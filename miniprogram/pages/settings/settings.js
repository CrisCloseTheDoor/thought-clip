const config = require('../../config')
const fmt = require('../../utils/format')
const stats = require('../../utils/stats')

Page({
  data: {
    loading: true,
    // API 模式：own = 用我自己的 Key；dev = 用开发者提供的 API；none = 不使用AI
    // 新用户默认预选 dev（首次需同意隐私说明激活；此前默认 none）
    apiMode: 'dev',
    apiKey: '',
    apiKeyMask: '',
    devConsent: false,
    // 保留原声：成功识别的录音随记录长期保留，详情页可回听
    keepVoice: false,
    // 语音识别服务状态（null=未知，true=已配置，false=未配置）
    asrReady: null,
    // 回收站（软删除 3 天内可还原）
    bin: []
  },

  onShow() {
    this.load()
    this._checkAsr()
    this.loadBin()
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
            devConsent: !!doc.devConsent,
            keepVoice: !!doc.keepVoice
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
        this._promptKey(true) // 取消则回到未选择
      }
    } else if (mode === 'none') {
      this.save({ apiMode: 'none' })
    } else if (mode === 'dev') {
      // 已同意过隐私说明：切换即写库生效（否则只改界面、库里还是旧值，
      // 会导致详情页判定无 AI、重进设置跳回旧选项）
      if (this.data.devConsent) this.save({ apiMode: 'dev' })
      // 首次选 dev：等用户点下方「同意隐私说明并启用」才生效
    }
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

  /* ---------- 保留原声 ---------- */

  toggleKeepVoice() {
    const v = !this.data.keepVoice
    this.setData({ keepVoice: v })
    this.save({ keepVoice: v })
    wx.showToast({
      title: v ? '开：录音随记录保留' : '关：识别后即删除录音',
      icon: 'none'
    })
  },

  /* ---------- 回收站（软删除 3 天） ---------- */

  loadBin() {
    if (!wx.cloud || !wx.cloud.database) return
    const _ = wx.cloud.database().command
    wx.cloud.database().collection('entries')
      .where({ _openid: '{openid}', deletedAt: _.exists(true) })
      .orderBy('deletedAt', 'desc')
      .limit(20)
      .get()
      .then((res) => {
        const bin = (res.data || [])
          .map((d) => {
            const t = fmt.toDate(d.deletedAt)
            return {
              id: d._id,
              kind: d.kind || '',
              preview: d.kind === 'voice'
                ? '♪ ' + (d.title || '声音灵感')
                : (d.text || d.raw || '').slice(0, 30),
              deletedText: fmt.hm(t),
              remainDays: fmt.remainingDays(new Date(t.getTime() + 3 * 86400000))
            }
          })
          .filter((it) => it.remainDays > 0) // 已过期的等定时清理，不再展示
        this.setData({ bin })
      })
      .catch(() => {})
  },

  restoreEntry(e) {
    const id = e.currentTarget.dataset.id
    const _ = wx.cloud.database().command
    wx.cloud.database().collection('entries').doc(id)
      // 移除 deletedAt 即还原：createdAt 未动过，自动回到时间线原位
      .update({ data: { deletedAt: _.remove() } })
      .then(() => {
        stats.invalidate()
        wx.showToast({ title: '已还原', icon: 'success' })
        this.loadBin()
      })
      .catch(() => wx.showToast({ title: '还原失败', icon: 'none' }))
  },

  purgeEntry(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '彻底删除？',
      content: '记录及其音频将被永久删除，不可恢复。',
      confirmText: '彻底删除',
      confirmColor: '#F0666E',
      success: (r) => {
        if (!r.confirm) return
        const db = wx.cloud.database()
        db.collection('entries').doc(id).get()
          .then((res) => {
            const audios = (res.data && res.data.audioFileIDs) || []
            audios.forEach((f) => {
              wx.cloud.callFunction({ name: 'asr', data: { discard: f } }).catch(() => {})
            })
            return db.collection('entries').doc(id).remove()
          })
          .then(() => {
            stats.invalidate()
            wx.showToast({ title: '已彻底删除', icon: 'none' })
            this.loadBin()
          })
          .catch(() => wx.showToast({ title: '删除失败', icon: 'none' }))
      }
    })
  },

  /* ---------- 数据 ---------- */

  // 导出全部记录为 Markdown 文件，通过聊天分享给自己备份
  exportAll() {
    if (this._exporting) return
    if (!wx.cloud || !wx.cloud.callFunction) return
    this._exporting = true
    wx.showLoading({ title: '导出中…', mask: true })

    const CHUNK = 300
    const parts = []
    const step = (skip) => wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.STATS,
      data: { action: 'export', skip, limit: CHUNK }
    }).then((res) => {
      const r = res.result || {}
      parts.push(r.markdown || '')
      if (r.hasMore) return step(skip + CHUNK)
      return parts.join('\n')
    })

    const today = fmt.dayKey(new Date())
    const stamp = today.replace(/-/g, '')
    step(0).then((md) => {
      wx.hideLoading()
      this._exporting = false
      if (!md || !md.trim()) {
        wx.showToast({ title: '还没有可导出的记录', icon: 'none' })
        return
      }
      const content = '# Thought Clip 导出 · ' + today + '\n' + md + '\n'

      const write = (filePath) => new Promise((resolve, reject) => {
        wx.getFileSystemManager().writeFile({
          filePath,
          data: content,
          encoding: 'utf8',
          success: resolve,
          fail: reject
        })
      })
      const share = (filePath, fileName) => new Promise((resolve, reject) => {
        wx.shareFileMessage({
          filePath,
          fileName,
          success: resolve,
          fail: (f) => {
            if (f && f.errMsg && f.errMsg.indexOf('cancel') > -1) resolve('cancel')
            else reject(f)
          }
        })
      })
      const tryShare = (ext, fileName) => {
        const path = wx.env.USER_DATA_PATH + '/thought-clip-' + stamp + '.' + ext
        return write(path).then(() => share(path, fileName))
      }

      const run = async () => {
        // 优先发 .md 文件；部分机型不支持该扩展名时改发 .txt；均失败再复制剪贴板
        try {
          const r = await tryShare('md', 'ThoughtClip-' + today + '.md')
          if (r !== 'cancel') wx.showToast({ title: '已导出', icon: 'success' })
          return
        } catch (e) {
          console.warn('md 分享失败，尝试 txt', e && e.errMsg)
        }
        try {
          const r = await tryShare('txt', 'ThoughtClip-' + today + '.txt')
          if (r !== 'cancel') wx.showToast({ title: '已导出', icon: 'success' })
          return
        } catch (e) {
          console.warn('txt 分享失败，退化剪贴板', e && e.errMsg)
        }
        if (content.length < 80000) {
          wx.setClipboardData({
            data: content,
            success: () => {
              wx.hideToast() // 屏蔽系统默认的「内容已复制」
              wx.showToast({ title: '记录已复制到剪贴板', icon: 'none', duration: 2500 })
            }
          })
        } else {
          wx.showToast({ title: '请在手机微信中导出', icon: 'none', duration: 2200 })
        }
      }
      run()
    }).catch(() => {
      wx.hideLoading()
      this._exporting = false
      wx.showToast({ title: '导出失败，请检查网络', icon: 'none' })
    })
  },

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
                stats.invalidate()
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
