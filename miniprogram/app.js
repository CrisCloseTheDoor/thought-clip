const config = require('./config')
const { flushPendingQueue } = require('./utils/pending')

App({
  globalData: {
    // 云环境是否就绪（未配置环境 ID 时云端功能不可用，但页面仍可打开）
    cloudReady: false
  },

  onLaunch() {
    // 音频会话独占：不与其他音频混音，录音与回听的会话切换行为更确定
    // （修复真机上"录音一次后，所有回听都断断续续"的会话残留问题）
    if (wx.setInnerAudioOption) {
      try {
        wx.setInnerAudioOption({ mixWithOther: false })
      } catch (e) { /* 低版本忽略 */ }
    }
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

    // 网络恢复时自动补传离线记录（app.onShow 只覆盖「离开再回来」的场景）
    wx.onNetworkStatusChange((res) => {
      if (!res.isConnected || !this.globalData.cloudReady) return
      flushPendingQueue().then((n) => {
        if (n > 0) wx.showToast({ title: '已同步 ' + n + ' 条离线记录', icon: 'none' })
      }).catch(() => {})
    })
  },

  onShow() {
    // 网络恢复/重新进入时补传离线记录
    if (this.globalData.cloudReady) {
      flushPendingQueue()
    }
  }
})
