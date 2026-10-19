const fmt = require('../../utils/format')
const stats = require('../../utils/stats')
const { typeMeta } = require('../../utils/types')
const config = require('../../config')
const audioUtil = require('../../utils/audio')

const FB_CHIPS = [
  { k: 'digest', label: '提炼要点' },
  { k: 'challenge', label: '挑战我的想法' },
  { k: 'action', label: '下一步行动' },
  { k: 'companion', label: '陪我说说' }
]

Page({
  data: {
    id: '',
    entry: null,
    voices: [],        // 保留的原声 [{ fileID, label }]
    playingVoice: '',
    isVoice: false,    // 声音灵感（kind=voice）
    voicePlaying: false,
    showRaw: false,
    editing: false,
    editText: '',
    // AI 反馈
    fbChips: FB_CHIPS,
    feedbacks: [],     // [{ kind, label, text, timeText, sources }] 最新在前
    fbLoading: false,
    aiEnabled: false,
    // 反馈时检索历史上下文（全局开关，开启需同意）
    ctxEnabled: false
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.load()
    this._checkAi()
  },

  onUnload() {
    if (this.data.voicePlaying || this.data.playingVoice) audioUtil.stopPlayback()
  },

  onHide() {
    // 进入更深页面（如点引用来源）时停止本页回听
    if (this.data.voicePlaying || this.data.playingVoice) audioUtil.stopPlayback()
  },

  load() {
    if (!wx.cloud || !wx.cloud.database) return
    const db = wx.cloud.database()
    db.collection('entries').doc(this.data.id).get()
      .then((res) => {
        const e = res.data
        const t = fmt.toDate(e.createdAt)
        const meta = typeMeta(e.type)
        const files = (Array.isArray(e.audioFileIDs) ? e.audioFileIDs : [])
          .filter((f) => f && typeof f === 'string')
        const voices = files.map((f, i) => ({
          fileID: f,
          label: files.length > 1 ? '录音 ' + (i + 1) : '录音'
        }))
        const isVoice = e.kind === 'voice'
        this.setData({
          entry: Object.assign({}, e, {
            timeText: fmt.fullTime(t),
            typeLabel: meta.label,
            typeColor: meta.color,
            // 幅度视图：钳位 + 波纹动效延迟（与卡片一致的均衡器式起伏）
            ampsView: (e.amps || []).map((n, i) => ({
              v: Math.max(6, Math.min(100, n || 0)),
              d: ((i % 8) * 0.09).toFixed(2)
            }))
          }),
          voices: isVoice ? [] : voices,
          isVoice,
          voicePlaying: false,
          // 反馈历史：最新在前；陪我说说带 companion 标记做绿色轻松样式
          feedbacks: (Array.isArray(e.feedbacks) ? e.feedbacks : []).slice().reverse().map((f) => ({
            kind: f.kind,
            label: (FB_CHIPS.find((c) => c.k === f.kind) || {}).label || 'AI 反馈',
            text: f.text || '',
            timeText: fmt.hm(fmt.toDate(f.createdAt)),
            id: fmt.toDate(f.createdAt).getTime(), // 删除反馈时定位用
            sources: (f.sources || []).map((s) => ({
              id: s.id,
              label: s.dayKey
                ? (parseInt(s.dayKey.slice(5, 7), 10) + '月' + parseInt(s.dayKey.slice(8, 10), 10) + '日')
                : '记录',
              snippet: (s.snippet || '').slice(0, 24)
            }))
          })),
          editText: e.text || e.raw
        })
        // 已在回收站的记录：提示并返回（还原入口在设置页）
        if (e.deletedAt) {
          wx.showToast({ title: '该记录已在回收站，可在设置中还原', icon: 'none', duration: 2000 })
          setTimeout(() => wx.navigateBack(), 1200)
        }
      })
      .catch(() => {
        wx.showToast({ title: '记录不存在或已删除', icon: 'none' })
      })
  },

  /* ---------- AI 反馈 ---------- */

  // 与 saveEntry 的 Key 解析口径一致：own+Key 或 dev+已同意 才算可用
  _checkAi() {
    if (!wx.cloud || !wx.cloud.database) return
    wx.cloud.database().collection('users').where({ _openid: '{openid}' }).limit(1).get()
      .then((res) => {
        const doc = res.data && res.data[0]
        const ok = !!(doc && ((doc.apiMode === 'own' && doc.apiKey) ||
          (doc.apiMode === 'dev' && doc.devConsent)))
        this.setData({ aiEnabled: ok, ctxEnabled: !!(doc && doc.ctxEnabled) })
      })
      .catch(() => this.setData({ aiEnabled: false, ctxEnabled: false }))
  },

  /* ---------- 历史上下文开关（全局，存 users.ctxEnabled） ---------- */

  onCtxToggle() {
    if (!this.data.aiEnabled) {
      this._guideEnableAi()
      return
    }
    const v = !this.data.ctxEnabled
    if (!v) {
      this.setData({ ctxEnabled: false })
      this._saveCtx(false)
      return
    }
    wx.showModal({
      title: '检索历史上下文',
      content: '开启后，每次反馈会自动检索你的相关历史记录，便于AI引擎生成更了解你的回答。可随时关闭。',
      confirmText: '开启',
      cancelText: '暂不',
      confirmColor: '#E8B44B',
      success: (r) => {
        if (!r.confirm) return
        this.setData({ ctxEnabled: true })
        this._saveCtx(true)
      }
    })
  },

  _saveCtx(v) {
    const db = wx.cloud.database()
    db.collection('users').where({ _openid: '{openid}' }).limit(1).get()
      .then((res) => {
        const doc = res.data && res.data[0]
        const data = { ctxEnabled: v, updatedAt: new Date() }
        if (doc) return db.collection('users').doc(doc._id).update({ data })
        return db.collection('users').add({ data })
      })
      .catch(() => { /* 保存失败不阻断，下次开关重试 */ })
  },

  _guideEnableAi() {
    wx.showModal({
      title: '当前是无 AI 模式',
      content: '无法获取反馈，可在设置页选择 AI 引擎。',
      confirmText: '去设置',
      cancelText: '知道了',
      confirmColor: '#E8B44B',
      success: (r) => { if (r.confirm) wx.switchTab({ url: '/pages/settings/settings' }) }
    })
  },

  askFeedback(e) {
    if (this.data.fbLoading) return
    const kind = e.currentTarget.dataset.kind
    if (!kind) return
    if (!this.data.aiEnabled) {
      this._guideEnableAi()
      return
    }
    this.setData({ fbLoading: true })
    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.SAVE_ENTRY,
      data: { feedback: true, kind, entryId: this.data.id, useCtx: !!this.data.ctxEnabled }
    }).then((res) => {
      this.setData({ fbLoading: false })
      const r = res.result || {}
      if (r.ok) {
        try { wx.vibrateShort({ type: 'light' }) } catch (err) { /* noop */ }
        this.load()
      } else if (r.error === 'no-key') {
        this._guideEnableAi()
      } else if (r.error === 'ai-fail' || r.error === 'ai-empty') {
        wx.showToast({ title: 'AI 暂时没回应，稍后再试', icon: 'none' })
      } else {
        wx.showToast({ title: '反馈失败', icon: 'none' })
      }
    }).catch(() => {
      this.setData({ fbLoading: false })
      wx.showToast({ title: '网络不佳，稍后再试', icon: 'none' })
    })
  },

  // 点击引用来源 → 跳到对应记录详情
  goSource(e) {
    const id = e.currentTarget.dataset.id
    if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
  },

  // 删除某条反馈（不满意时可删掉重新生成）
  deleteFeedback(e) {
    const ts = Number(e.currentTarget.dataset.ts)
    const list = (this.data.entry && this.data.entry.feedbacks) || []
    const kept = list.filter((f) => fmt.toDate(f.createdAt).getTime() !== ts)
    if (kept.length === list.length) return
    wx.cloud.database().collection('entries').doc(this.data.id)
      .update({ data: { feedbacks: kept } })
      .then(() => {
        wx.showToast({ title: '已删除反馈', icon: 'none' })
        this.load()
      })
      .catch(() => wx.showToast({ title: '删除失败', icon: 'none' }))
  },

  /* ---------- 声音灵感 ---------- */

  toggleVoicePlay() {
    const e = this.data.entry
    if (!e || !e.audioFileIDs || !e.audioFileIDs.length) {
      wx.showToast({ title: '没有可播放的音频', icon: 'none' })
      return
    }
    if (this.data.voicePlaying) {
      audioUtil.stopPlayback()
      return
    }
    wx.showLoading({ title: '加载中…', mask: true })
    audioUtil.playCloudAudio(e.audioFileIDs[0], {
      onEnded: () => this.setData({ voicePlaying: false }),
      onStop: () => this.setData({ voicePlaying: false }),
      onError: () => this.setData({ voicePlaying: false })
    }).then(() => {
      wx.hideLoading()
      this.setData({ voicePlaying: true })
    }).catch(() => {
      wx.hideLoading()
      wx.showToast({ title: '加载失败，请检查网络', icon: 'none' })
    })
  },

  renameInspire() {
    const e = this.data.entry
    if (!e) return
    wx.showModal({
      title: '重命名灵感',
      editable: true,
      content: e.title || '',
      confirmText: '保存',
      confirmColor: '#E8B44B',
      success: (r) => {
        if (!r.confirm) return
        const title = ((r.content || '').trim() || e.title).slice(0, 30)
        if (!title) {
          wx.showToast({ title: '标题不能为空', icon: 'none' })
          return
        }
        wx.cloud.database().collection('entries').doc(this.data.id)
          .update({ data: { title } })
          .then(() => {
            this.setData({ 'entry.title': title })
            wx.showToast({ title: '已保存', icon: 'success' })
          })
          .catch(() => wx.showToast({ title: '保存失败', icon: 'none' }))
      }
    })
  },

  exportInspireAudio() {
    const e = this.data.entry
    const fileID = e && e.audioFileIDs && e.audioFileIDs[0]
    if (!fileID) {
      wx.showToast({ title: '没有可导出的音频', icon: 'none' })
      return
    }
    wx.showLoading({ title: '准备导出…', mask: true })
    wx.cloud.downloadFile({ fileID }).then((res) => {
      wx.hideLoading()
      const name = ((e.title || '灵感').replace(/[\\/:*?"<>|\s]+/g, '') || '灵感') + '.wav'
      wx.shareFileMessage({
        filePath: res.tempFilePath,
        fileName: name,
        fail: (f) => {
          if (f && f.errMsg && f.errMsg.indexOf('cancel') > -1) return
          wx.showToast({ title: '当前环境不支持分享，请在手机上使用', icon: 'none', duration: 2200 })
        }
      })
    }).catch(() => {
      wx.hideLoading()
      wx.showToast({ title: '下载失败，请检查网络', icon: 'none' })
    })
  },

  /* ---------- 原声回听 ---------- */

  playVoice(e) {
    const fileID = e.currentTarget.dataset.file
    if (!fileID) return
    if (this.data.playingVoice === fileID) {
      audioUtil.stopPlayback()
      return
    }
    wx.showLoading({ title: '加载中…', mask: true })
    audioUtil.playCloudAudio(fileID, {
      onEnded: () => this.setData({ playingVoice: '' }),
      onStop: () => this.setData({ playingVoice: '' }),
      onError: () => this.setData({ playingVoice: '' })
    }).then(() => {
      wx.hideLoading()
      this.setData({ playingVoice: fileID })
    }).catch(() => {
      wx.hideLoading()
      wx.showToast({ title: '加载失败，请检查网络', icon: 'none' })
    })
  },

  toggleRaw() {
    this.setData({ showRaw: !this.data.showRaw })
  },

  /* ---------- 编辑 ---------- */

  startEdit() {
    this.setData({ editing: true, editText: this.data.entry.text || this.data.entry.raw })
  },

  cancelEdit() {
    this.setData({ editing: false })
  },

  onEditInput(e) {
    this.setData({ editText: e.detail.value })
  },

  saveEdit() {
    const text = (this.data.editText || '').trim()
    if (!text) {
      wx.showToast({ title: '内容不能为空', icon: 'none' })
      return
    }
    const db = wx.cloud.database()
    db.collection('entries').doc(this.data.id)
      .update({ data: { text, edited: true, updatedAt: new Date() } })
      .then(() => {
        this.setData({ editing: false })
        this.load()
        wx.showToast({ title: '已保存', icon: 'success' })
      })
      .catch(() => wx.showToast({ title: '保存失败', icon: 'none' }))
  },

  /* ---------- 其他操作 ---------- */

  copyText() {
    const text = this.data.editing ? this.data.editText : this.data.entry.text
    wx.setClipboardData({ data: text })
  },

  deleteEntry() {
    wx.showModal({
      title: '删除这条记录？',
      content: '将移入回收站，3 天内可在「设置 → 回收站」还原，之后自动彻底删除。',
      confirmText: '删除',
      confirmColor: '#F0666E',
      success: (r) => {
        if (!r.confirm) return
        const db = wx.cloud.database()
        // 软删除：保留原文与音频，3 天内可按原时间线位置还原
        db.collection('entries').doc(this.data.id)
          .update({ data: { deletedAt: new Date() } })
          .then(() => {
            stats.invalidate()
            wx.showToast({ title: '已移入回收站', icon: 'none' })
            setTimeout(() => wx.navigateBack(), 600)
          })
          .catch(() => wx.showToast({ title: '删除失败', icon: 'none' }))
      }
    })
  }
})
