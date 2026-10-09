// 离线草稿箱：云函数调用失败时暂存本地，网络恢复后自动补传
const config = require('../config')
const fmt = require('./format')
const stats = require('./stats')

const KEY = 'pendingQueue'

function getQueue() {
  try {
    return wx.getStorageSync(KEY) || []
  } catch (e) {
    return []
  }
}

// 入队：记录录入时刻与当天日期键（及保留的原声文件 ID），补传时随请求带上，
// 保证离线记录归入「发生那天」而不是「补传那天」
function enqueue(raw, dayKey, audioFileIDs) {
  const q = getQueue()
  q.push({
    raw,
    dayKey: dayKey || '',
    audioFileIDs: Array.isArray(audioFileIDs) ? audioFileIDs : [],
    localCreatedAt: Date.now()
  })
  try {
    wx.setStorageSync(KEY, q)
  } catch (e) {
    // 存储满等极端情况：丢弃，保主流程
  }
}

// 声音灵感离线入队（音频已传云端，只差落库）
function enqueueVoice(v) {
  const q = getQueue()
  q.push({
    kind: 'voice',
    title: v.title || '',
    amps: Array.isArray(v.amps) ? v.amps : [],
    duration: v.duration || 0,
    audioFileIDs: Array.isArray(v.audioFileIDs) ? v.audioFileIDs : [],
    dayKey: v.dayKey || '',
    localCreatedAt: Date.now()
  })
  try {
    wx.setStorageSync(KEY, q)
  } catch (e) { /* 存储满等极端情况：丢弃，保主流程 */ }
}

function clear() {
  try {
    wx.removeStorageSync(KEY)
  } catch (e) { /* noop */ }
}

// 补传离线队列；成功返回补传条数
async function flushPendingQueue() {
  const q = getQueue()
  if (!q.length) return 0
  const remaining = []
  let done = 0
  for (const item of q) {
    // 旧队列条目没有 dayKey：用录入时刻推算
    const dayKey = item.dayKey || fmt.dayKey(new Date(item.localCreatedAt || Date.now()))
    try {
      const data = item.kind === 'voice'
        ? {
            kind: 'voice',
            title: item.title || '',
            amps: Array.isArray(item.amps) ? item.amps : [],
            duration: item.duration || 0,
            audioFileIDs: Array.isArray(item.audioFileIDs) ? item.audioFileIDs : [],
            dayKey
          }
        : {
            raw: item.raw,
            dayKey,
            audioFileIDs: Array.isArray(item.audioFileIDs) ? item.audioFileIDs : []
          }
      await wx.cloud.callFunction({
        name: config.CLOUD_FUNCTIONS.SAVE_ENTRY,
        data
      })
      done++
    } catch (e) {
      remaining.push(item)
    }
  }
  if (remaining.length) {
    try { wx.setStorageSync(KEY, remaining) } catch (e) { /* noop */ }
  } else {
    clear()
  }
  if (done > 0) stats.invalidate() // 补传成功后统计/连续天数已变化
  return done
}

module.exports = { getQueue, enqueue, enqueueVoice, clear, flushPendingQueue }
