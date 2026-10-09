// 统计数据共享层：首页 streak 与历史页热力图共用，按天缓存减少云函数调用
const config = require('../config')
const fmt = require('./format')

const KEY = 'statsCache'

function getCached() {
  try {
    const c = wx.getStorageSync(KEY)
    if (c && c.day === fmt.dayKey(new Date())) return c.data
  } catch (e) { /* noop */ }
  return null
}

// 返回 Promise<{ total, streak, longestStreak, days }>
function loadSummary() {
  const cached = getCached()
  if (cached) return Promise.resolve(cached)
  return wx.cloud.callFunction({ name: config.CLOUD_FUNCTIONS.STATS, data: {} })
    .then((res) => {
      const data = res.result || {}
      try { wx.setStorageSync(KEY, { day: fmt.dayKey(new Date()), data }) } catch (e) { /* noop */ }
      return data
    })
}

module.exports = {
  loadSummary,

  // 当天记录发生变化（保存/补传/清空）后调用，强制下次重新拉取统计
  invalidate() {
    try { wx.removeStorageSync(KEY) } catch (e) { /* noop */ }
  }
}
