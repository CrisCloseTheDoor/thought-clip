const config = require('../../config')

Page({
  data: {
    loading: true,
    // API 模式：own = 用我自己的 Key；dev = 用开发者提供的 API；none = 原文记录（默认，不用 AI）
    apiMode: 'none',
    apiKey: '',
    apiKeyMask: '',
    devConsent: false,
    // 语音识别服务状态（null=未知，true=已配置，false=未配置）
    asrReady: null
  },

  onShow() {
    this.load()
    this._checkAsr()
  },

  _checkAsr() {
    if (!wx.cloud || !wx.cloud.callFunction) return
    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.ASR,
      data: { test: true }
    }).then((res) => {
      this.setData({ asrReady: !!(res.result && res.result.ok) })
    }).catch(() => {
      this.setData({ asrReady: false })
    })
  },

  /* ---------- 读取用户配置 ---------- */

  load() {
    if (!wx.cloud || !wx.cloud.database) {
      this.setData({ loading: false })
      return
    }
    const db = wx.cloud.database()
    db.collection('users').where({ _openid: '{openid}' }).limit(1).get()
      .then((res) => {
        const doc = res.data && res.data[0]
        if (doc) {
          this._userId = doc._id
          this.setData({
            apiMode: doc.apiMode || 'none',
            apiKey: doc.apiKey || '',
            apiKeyMask: this._maskKey(doc.apiKey || ''),
            devConsent: !!doc.devConsent
          })
        }
        // 未配置时默认「原文记录」模式
        this.setData({ loading: false })
      })
      .catch(() => this.setData({ loading: false }))
  },

  /* ---------- 写入用户配置 ---------- */

  save(fields) {
    const db = wx.cloud.database()
    const data = Object.assign({}, fields, { updatedAt: new Date() })
    if (this._userId) {
      return db.collection('users').doc(this._userId).update({ data }).catch((e) => {
        console.warn('users update 失败', e)
      })
    }
    return db.collection('users').add({ data })
      .then((res) => { this._userId = res._id })
      .catch((e) => { console.warn('users add 失败', e) })
  },

  /* ---------- API 双模式 ---------- */

  onModeChange(e) {
    const mode = e.detail.value
    if (mode === this.data.apiMode) return
    this.setData({ apiMode: mode })
    if (mode === 'own') {
      // 自用模式：已有 Key 直接生效；没有则弹出输入框
      if (this.data.apiKey) {
        this.save({ apiMode: 'own' })
      } else {
        this._promptKey(true) // 取消则回到原文记录
      }
    } else if (mode === 'none') {
      this.save({ apiMode: 'none' })
    }
    // dev 模式：等用户点下方「同意隐私说明并启用」才生效
  },

  // 同意开发者模式（隐私说明已显示在按钮上方，点按钮即视为同意）
  agreeDevConsent() {
    if (this.data.devConsent) return
    this.setData({ devConsent: true })
    this.save({ apiMode: 'dev', devConsent: true, devConsentedAt: new Date() })
    wx.showToast({ title: '已启用开发者 API', icon: 'success' })
  },

  // 弹出输入框填自己的 Key；revertOnCancel=true 时取消则回到未选择
  _promptKey(revertOnCancel) {
    wx.showModal({
      title: '填写我的 DeepSeek Key',
      editable: true,
      placeholderText: 'sk-… 粘贴你的 DeepSeek API Key',
      confirmText: '保存',
      confirmColor: '#E8B44B',
      success: (r) => {
        if (r.confirm) {
          const key = (r.content || '').trim()
          if (!key) {
            wx.showToast({ title: 'Key 不能为空', icon: 'none' })
            this._promptKey(revertOnCancel)
            return
          }
          this.setData({ apiKey: key, apiKeyMask: this._maskKey(key) })
          this.save({ apiMode: 'own', apiKey: key }).then(() => {
            wx.showToast({ title: '已保存', icon: 'success' })
          })
        } else if (revertOnCancel) {
          this.setData({ apiMode: 'none' })
        }
      }
    })
  },

  changeKey() {
    this._promptKey(false) // 更换 Key 时取消则保持当前
  },

  _maskKey(key) {
    if (!key) return ''
    if (key.length <= 8) return '••••' + key.slice(-4)
    return key.slice(0, 4) + '••••••' + key.slice(-4)
  },

  testKey() {
    const key = (this.data.apiKey || '').trim()
    if (!key) {
      wx.showToast({ title: '请先输入 Key', icon: 'none' })
      return
    }
    wx.showLoading({ title: '测试中…', mask: true })
    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.SAVE_ENTRY,
      data: { raw: '__TEST__', test: true, apiKeyOverride: key }
    }).then((res) => {
      wx.hideLoading()
      const ok = res.result && res.result.ok
      if (ok) {
        wx.showToast({ title: '连接成功', icon: 'success' })
        this.save({ apiMode: 'own', apiKey: key })
      } else {
        wx.showModal({ title: '连接失败', content: '请检查 Key 是否正确、账户是否有余额。', showCancel: false })
      }
    }).catch(() => {
      wx.hideLoading()
      wx.showModal({ title: '连接失败', content: '无法访问云函数，请确认云环境已配置、saveEntry 已部署。', showCancel: false })
    })
  },

  /* ---------- 数据 ---------- */

  clearAll() {
    wx.showModal({
      title: '清空全部记录？',
      content: '将从云数据库删除你所有的记录，不可恢复。',
      confirmText: '清空',
      confirmColor: '#F0666E',
      success: (r) => {
        if (!r.confirm) return
        const db = wx.cloud.database()
        const next = () => {
          db.collection('entries').where({ _openid: '{openid}' }).limit(20).get()
            .then((res) => {
              const list = res.data || []
              if (!list.length) {
                wx.showToast({ title: '已清空', icon: 'success' })
                return
              }
              Promise.all(list.map((it) => db.collection('entries').doc(it._id).remove()))
                .then(next)
                .catch(() => wx.showToast({ title: '清空失败', icon: 'none' }))
            })
            .catch(() => wx.showToast({ title: '清空失败', icon: 'none' }))
        }
        next()
      }
    })
  }
})
