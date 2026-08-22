// 离线草稿箱：云函数调用失败时暂存本地，网络恢复后自动补传
const config = require('../config')

const KEY = 'pendingQueue'

function getQueue() {
  try {
    return wx.getStorageSync(KEY) || []
  } catch (e) {
    return []
  }
}

function enqueue(raw) {
  const q = getQueue()
  q.push({ raw, localCreatedAt: Date.now() })
  try {
    wx.setStorageSync(KEY, q)
  } catch (e) {
    // 存储满等极端情况：丢弃，保主流程
  }
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
    try {
      await wx.cloud.callFunction({
        name: config.CLOUD_FUNCTIONS.SAVE_ENTRY,
        data: { raw: item.raw }
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
  return done
}

module.exports = { getQueue, enqueue, clear, flushPendingQueue }
