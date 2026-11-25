/**
 * asr —— 语音转文字（支持腾讯云 ASR / 科大讯飞 IAT，可在设置页切换）
 *
 * 入参：
 *   fileID         云存储中的音频文件 ID（wav 16kHz 单声道 或 mp3，≤60s）
 *   provider       (可选) 指定 ASR 提供商：'tencent'（默认）| 'iflytek'
 *                  若未指定则从 users.asrProvider 读取用户偏好
 *   test           (可选) true = 仅检测当前提供商 ASR 服务是否可用
 *   keepOnSuccess  (可选) true = 识别成功也不删除音频（用户开启「保留原声」时传入）
 *   keepAudio      (可选) 传入 fileID：不识别，仅为该音频创建「暂存语音」记录（7 天有效）
 *   discard        (可选) 传入 fileID：不识别，直接删除该音频（用户放弃 / 删除暂存时调用）
 *
 * 环境变量（云函数「配置 → 环境变量」）：
 *   TENCENT_SECRET_ID   腾讯云 SecretId
 *   TENCENT_SECRET_KEY  腾讯云 SecretKey
 *   IFLYTEK_APPID       科大讯飞 APPID（开发者测试用；正式路径读用户自己的密钥）
 *   IFLYTEK_API_KEY     科大讯飞 APIKey
 *   IFLYTEK_API_SECRET  科大讯飞 APISecret
 *
 * ASR 提供商路由：
 *   1. 读 users.asrProvider（用户在设置页选择）→ 'tencent' | 'iflytek'
 *   2. iflytek 需配置讯飞环境变量，否则自动降级回腾讯
 *   3. 双提供商共享同一音频生命周期管理（保留原声/暂存/删除）
 *
 * 音频生命周期：
 *   识别成功（默认）    → 立即删除音频
 *   识别成功+保留原声   → 音频 fileID 写入 entries.audioFileIDs，随记录长期保留
 *   识别为空(no-speech) → 保留音频，由用户选择：重新识别 / 暂存 7 天 / 放弃
 *   暂存语音            → 写入 voiceClips 集合，expiresAt = now + 7 天，
 *                         由 stats 云函数的定时触发器到期清理
 */
const cloud = require('wx-server-sdk')
const tencentcloud = require('tencentcloud-sdk-nodejs-asr')
const WebSocket = require('ws')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const AsrClient = tencentcloud.asr.v20190614.Client

const CLIP_KEEP_DAYS = 7

function hasTencentCreds() {
  return !!(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY)
}

function hasIFlytekCreds() {
  return !!(process.env.IFLYTEK_APPID && process.env.IFLYTEK_API_KEY && process.env.IFLYTEK_API_SECRET)
}

// 根据云存储文件扩展名判断格式
function voiceFormatOf(fileID) {
  return /\.wav$/i.test(fileID) ? 'wav' : 'mp3' // 兼容旧 wav 文件
}

// 读取用户 ASR 提供商偏好（设置页选择，默认腾讯）
async function getAsrProvider(openid) {
  try {
    const res = await db.collection('users').where({ _openid: openid }).limit(1).get()
    const doc = res.data && res.data[0]
    return (doc && doc.asrProvider) || 'tencent'
  } catch (e) {
    return 'tencent'
  }
}

/* ---------- 科大讯飞 IAT（WebSocket 流式识别） ---------- */

// 构建鉴权 URL（HMAC-SHA256 签名）
function buildIatAuthUrl(apiKey, apiSecret, host) {
  const date = new Date().toUTCString()
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET /v2/iat HTTP/1.1`
  const signatureSha = crypto.createHmac('sha256', apiSecret)
    .update(signatureOrigin)
    .digest()
  const signature = signatureSha.toString('base64')
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`
  const authorization = Buffer.from(authorizationOrigin).toString('base64')
  return `wss://${host}/v2/iat?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${host}`
}

// 讯飞识别：传入原始 PCM 数据（16kHz 16bit mono），返回完整识别文本
function iflytekIat(pcmData, appid, apiKey, apiSecret) {
  return new Promise((resolve, reject) => {
    const host = 'iat-api.xfyun.cn'
    const authUrl = buildIatAuthUrl(apiKey, apiSecret, host)
    const ws = new WebSocket(authUrl, { handshakeTimeout: 10000 })

    let resultText = ''
    let settled = false

    const settle = (err, text) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try { ws.close() } catch (e) { /* noop */ }
      setTimeout(() => {
        if (err) reject(err)
        else resolve(text || '')
      }, 50) // 短暂延迟确保 close 事件处理完毕
    }

    const timeout = setTimeout(() => settle(new Error('iFlytek 识别超时')), 55000)

    ws.on('error', (err) => settle(err))

    ws.on('open', () => {
      // 分帧发送 PCM 音频（每帧 1280 字节，间隔 40ms）
      const frameSize = 1280
      let offset = 0
      const sendTimer = setInterval(() => {
        const isLast = offset + frameSize >= pcmData.length
        const chunk = pcmData.slice(offset, Math.min(offset + frameSize, pcmData.length))
        const status = isLast ? 2 : (offset === 0 ? 0 : 1)
        const msg = {
          data: {
            status,
            format: 'audio/L16;rate=16000',
            encoding: 'raw',
            audio: chunk.toString('base64')
          }
        }
        // 首帧携带配置
        if (offset === 0) {
          msg.common = { app_id: appid }
          msg.business = { language: 'zh_cn', domain: 'iat', accent: 'mandarin', vad_eos: 10000, dwa: 'wpgs' }
        }
        try { ws.send(JSON.stringify(msg)) } catch (e) { settle(e) }
        offset += chunk.length
        if (isLast) clearInterval(sendTimer)
      }, 40)
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data)
        if (msg.code !== 0) {
          settle(new Error(`iFlytek ${msg.code}: ${msg.message}`))
          return
        }
        if (msg.data && msg.data.result && msg.data.result.ws) {
          resultText += msg.data.result.ws.map((w) => (w.cw || []).map((c) => c.w).join('')).join('')
        }
      } catch (e) { /* ignore parse errors */ }
    })

    ws.on('close', () => {
      // 服务端主动关闭 = 识别完成，返回已积累的文本
      clearTimeout(timeout)
      if (!settled) {
        settled = true
        resolve(resultText)
      }
    })
  })
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()

  // 测试连通性（检查当前提供商凭证是否配置）
  if (event.test) {
    const provider = event.provider || await getAsrProvider(OPENID)
    if (provider === 'iflytek') {
      return { ok: hasIFlytekCreds(), error: hasIFlytekCreds() ? '' : 'no-creds' }
    }
    return { ok: hasTencentCreds(), error: hasTencentCreds() ? '' : 'no-creds' }
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

  // ASR 提供商路由
  const provider = event.provider || await getAsrProvider(OPENID)

  // 讯飞路径：优先读用户自己的密钥（users 集合），无则降级回腾讯
  let iflytekCreds = null
  if (provider === 'iflytek') {
    try {
      const res = await db.collection('users').where({ _openid: OPENID }).limit(1).get()
      const doc = res.data && res.data[0]
      if (doc && doc.iflytekAppId && doc.iflytekApiKey && doc.iflytekApiSecret) {
        iflytekCreds = {
          appId: doc.iflytekAppId,
          apiKey: doc.iflytekApiKey,
          apiSecret: doc.iflytekApiSecret
        }
      }
    } catch (e) { /* 读用户配置失败 */ }
    if (!iflytekCreds) {
      console.warn('用户未配置讯飞密钥，降级回腾讯 ASR')
    }
  }

  const useTencent = provider !== 'iflytek' || !iflytekCreds
  if (useTencent && !hasTencentCreds()) return { text: '', error: 'no-creds' }

  // 下载音频
  let audio
  try {
    const dl = await cloud.downloadFile({ fileID })
    audio = dl.fileContent
  } catch (e) {
    console.error('音频下载失败', fileID, e)
    return { text: '', error: 'download-fail: ' + ((e && (e.errMsg || e.message)) || '') }
  }

  // ---------- 科大讯飞路径（使用用户自己的密钥） ----------
  if (provider === 'iflytek' && iflytekCreds) {
    try {
      // 去 WAV 头（44 字节），获取原始 PCM
      const pcm = audio.slice(44)
      const text = await iflytekIat(pcm, iflytekCreds.appId, iflytekCreds.apiKey, iflytekCreds.apiSecret)
      const trimmed = text.trim()
      if (!trimmed) return { text: '', error: 'no-speech', fileID }
      if (event.keepOnSuccess) return { text: trimmed, kept: true, fileID }
      // 识别成功即删除云端音频
      try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) { /* noop */ }
      return { text: trimmed }
    } catch (e) {
      console.error('讯飞 ASR 失败，降级回腾讯', e.message)
      // 降级回腾讯
    }
  }

  // ---------- 腾讯云路径 ----------
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
