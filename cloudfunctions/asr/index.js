/**
 * asr —— 语音转文字（腾讯云 ASR 一句话识别）
 *
 * 入参：
 *   fileID         云存储中的音频文件 ID（wav 16kHz 单声道 或 mp3，≤60s）
 *   test           (可选) true = 仅检测是否配置了腾讯云密钥，不识别
 *   keepOnSuccess  (可选) true = 识别成功也不删除音频（用户开启「保留原声」时传入）
 *   keepAudio      (可选) 传入 fileID：不识别，仅为该音频创建「暂存语音」记录（7 天有效）
 *   discard        (可选) 传入 fileID：不识别，直接删除该音频（用户放弃 / 删除暂存时调用）
 *
 * 环境变量（云函数「配置 → 环境变量」）：
 *   TENCENT_SECRET_ID   腾讯云 SecretId
 *   TENCENT_SECRET_KEY  腾讯云 SecretKey
 *
 * 音频生命周期：
 *   识别成功（默认）    → 立即删除音频
 *   识别成功+保留原声   → 音频 fileID 写入 entries.audioFileIDs，随记录长期保留
 *   识别为空(no-speech) → 保留音频，由用户选择：重新识别 / 暂存 7 天 / 放弃
 *   暂存语音            → 写入 voiceClips 集合，expiresAt = now + 7 天，
 *                         由 stats 云函数的定时触发器到期清理
 *
 * 免费额度参考：一句话识别约 5000 次/月，超限按量计费。
 */
const cloud = require('wx-server-sdk')
const tencentcloud = require('tencentcloud-sdk-nodejs-asr')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const AsrClient = tencentcloud.asr.v20190614.Client

const CLIP_KEEP_DAYS = 7

function hasCreds() {
  return !!(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY)
}

// 根据云存储文件扩展名判断格式（客户端目前录 wav；兼容历史 mp3）
function voiceFormatOf(fileID) {
  return /\.mp3$/i.test(fileID) ? 'mp3' : 'wav'
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()

  // 测试连通性
  if (event.test) {
    return { ok: hasCreds(), error: hasCreds() ? '' : 'no-creds' }
  }

  // 暂存语音：为已上传的音频创建 7 天有效的记录
  if (event.keepAudio) {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + CLIP_KEEP_DAYS * 86400000)
    try {
      const add = await db.collection('voiceClips').add({
        data: {
          _openid: OPENID,
          fileID: event.keepAudio,
          createdAt: now,
          expiresAt
        }
      })
      return { ok: true, clipId: add._id, expiresAt: expiresAt.toISOString(), keepDays: CLIP_KEEP_DAYS }
    } catch (e) {
      console.error('创建暂存语音记录失败', e)
      return { ok: false, error: 'keep-fail' }
    }
  }

  // 放弃 / 删除：直接删除云端音频
  if (event.discard) {
    try { await cloud.deleteFile({ fileList: [event.discard] }) } catch (e) { /* 已不存在也视为成功 */ }
    return { ok: true }
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
      VoiceFormat: voiceFormatOf(fileID),
      Data: audio.toString('base64'),
      DataLen: audio.length,
      UsrAudioKey: 'tc' + Date.now() + Math.floor(Math.random() * 1e6)
    })
    const text = (res && res.Result ? res.Result : '').trim()
    if (!text) {
      // 识别为空：保留音频，交给用户选择（重新识别 / 暂存 / 放弃）
      return { text: '', error: 'no-speech', fileID }
    }
    if (event.keepOnSuccess) {
      // 用户开启「保留原声」：音频随记录长期保留，由记录删除时一并清理
      return { text, kept: true, fileID }
    }
    // 识别成功即删除云端音频
    try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) { /* noop */ }
    return { text }
  } catch (e) {
    console.error('ASR 调用失败', e)
    // 调用异常时同样保留音频，允许用户重试
    const msg = (e && (e.message || e.code || e.errCode || e)) || 'asr-fail'
    return { text: '', error: String(msg).slice(0, 150), fileID }
  }
}
