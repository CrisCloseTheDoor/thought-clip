const config = require('./config')
const { flushPendingQueue } = require('./utils/pending')

App({
  globalData: {
    // 云环境是否就绪（未配置环境 ID 时云端功能不可用，但页面仍可打开）
    cloudReady: false
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库版本过低，请使用 2.2.3 及以上基础库以使用云能力')
      return
    }
    if (!config.CLOUD_ENV || config.CLOUD_ENV === 'your-env-id') {
      console.warn('尚未配置云开发环境 ID，请在 miniprogram/config.js 中填写')
      return
    }
    wx.cloud.init({
      env: config.CLOUD_ENV,
      traceUser: true
    })
    this.globalData.cloudReady = true
  },

  onShow() {
    // 网络恢复/重新进入时补传离线记录
    if (this.globalData.cloudReady) {
      flushPendingQueue()
    }
  }
})
