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

// 入队：记录录入时刻与当天日期键（及幂等键、原声文件 ID），补传时随请求带上，
// 保证离线记录归入「发生那天」而不是「补传那天」；clientId 让服务端强幂等去重
function enqueue(raw, dayKey, audioFileIDs, clientId) {
  const q = getQueue()
  q.push({
    raw,
    dayKey: dayKey || '',
    audioFileIDs: Array.isArray(audioFileIDs) ? audioFileIDs : [],
    clientId: clientId || '',
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
    clientId: v.clientId || '',
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

// 删除记录时同步剔除队列中的同源副本：彻底删除后，
// 残留的离线队列项会在下次补传时"还魂"成新记录（幂等键只认已存在的记录）
function dropByClientIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return
  const set = {}
  ids.forEach((id) => { if (id) set[id] = true })
  const q = getQueue()
  const kept = q.filter((item) => !item.clientId || !set[item.clientId])
  if (kept.length !== q.length) {
    try {
      if (kept.length) wx.setStorageSync(KEY, kept)
      else wx.removeStorageSync(KEY)
    } catch (e) { /* noop */ }
  }
}

// 并发锁：网络事件与切前台可能同时触发补传，
// 不加锁会同时读到同一份队列、各自全部补传，造成成倍重复
let _flushing = false

// 补传离线队列；成功返回补传条数
async function flushPendingQueue() {
  if (_flushing) return 0
  _flushing = true
  try {
    const q = getQueue()
    if (!q.length) return 0
    const remaining = []
    let done = 0
    for (const item of q) {
      // 旧队列条目没有 dayKey：用录入时刻推算
      const dayKey = item.dayKey || fmt.dayKey(new Date(item.localCreatedAt || Date.now()))
      try {
        const common = {
          dayKey,
          clientId: item.clientId || '',
          // 原始录入时间：补传的记录落回它真正的时间线位置
          clientCreatedAt: item.localCreatedAt || Date.now()
        }
        const data = item.kind === 'voice'
          ? Object.assign({
              kind: 'voice',
              title: item.title || '',
              amps: Array.isArray(item.amps) ? item.amps : [],
              duration: item.duration || 0,
              audioFileIDs: Array.isArray(item.audioFileIDs) ? item.audioFileIDs : []
            }, common)
          : Object.assign({
              raw: item.raw,
              audioFileIDs: Array.isArray(item.audioFileIDs) ? item.audioFileIDs : []
            }, common)
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
  } finally {
    _flushing = false
  }
}

module.exports = { getQueue, enqueue, enqueueVoice, clear, dropByClientIds, flushPendingQueue }
