/**
 * asr —— 语音转文字（腾讯云 ASR 一句话识别）
 *
 * 入参：
 *   fileID  云存储中的音频文件 ID（mp3，16kHz 单声道，≤60s）
 *   test    (可选) true = 仅检测是否配置了腾讯云密钥，不识别
 *
 * 环境变量（云函数「配置 → 环境变量」）：
 *   TENCENT_SECRET_ID   腾讯云 SecretId
 *   TENCENT_SECRET_KEY  腾讯云 SecretKey
 *
 * 免费额度参考：一句话识别约 5000 次/月（或约 50 小时/月），超限按量计费。
 * 识别成功后删除云端音频文件，避免占用云存储。
 */
const cloud = require('wx-server-sdk')
const tencentcloud = require('tencentcloud-sdk-nodejs-asr')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const AsrClient = tencentcloud.asr.v20190614.Client

function hasCreds() {
  return !!(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY)
}

exports.main = async (event) => {
  // 测试连通性
  if (event.test) {
    return { ok: hasCreds(), error: hasCreds() ? '' : 'no-creds' }
  }

  const fileID = event.fileID
  if (!fileID) return { text: '', error: 'no-file' }
  if (!hasCreds()) return { text: '', error: 'no-creds' }

  // 下载音频
  let audio
  try {
    const dl = await cloud.downloadFile({ fileID })
    audio = dl.fileContent
  } catch (e) {
    console.error('音频下载失败', fileID, e)
    return { text: '', error: 'download-fail: ' + ((e && (e.errMsg || e.message)) || '') }
  }

  const client = new AsrClient({
    credential: {
      secretId: process.env.TENCENT_SECRET_ID,
      secretKey: process.env.TENCENT_SECRET_KEY
    },
    profile: { httpProfile: { endpoint: 'asr.tencentcloudapi.com' } }
  })

  try {
    const res = await client.SentenceRecognition({
      ProjectId: 0,
      SubServiceType: 2,
      EngSerViceType: '16k_zh',
      SourceType: 1,
      VoiceFormat: 'mp3',
      Data: audio.toString('base64'),
      DataLen: audio.length,
      UsrAudioKey: 'tc' + Date.now() + Math.floor(Math.random() * 1e6)
    })
    const text = (res && res.Result ? res.Result : '').trim()
    // 识别完成即删除云端音频
    try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) { /* noop */ }
    if (!text) return { text: '', error: 'no-speech' }
    return { text }
  } catch (e) {
    console.error('ASR 调用失败', e)
    const msg = (e && (e.message || e.code || e.errCode || e)) || 'asr-fail'
    return { text: '', error: String(msg).slice(0, 150) }
  }
}
