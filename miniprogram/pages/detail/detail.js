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
    // AI 反馈（每类别唯一对话串）：芯片 = 查看/开启的唯一入口
    fbChips: FB_CHIPS,
    fbTab: '',         // 当前查看的类别串（'' = 尚无任何对话）
    fbView: [],        // 渲染用扁平列表：轮次 / 整串删除按钮
    fbHasAny: false,
    fbScrollInto: '',  // scroll-into-view 锚点：新回复飞入最新一条
    fbLoading: false,
    followText: '',    // 追问输入
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
          editText: e.text || e.raw
        })
        // 反馈：按"类别 = 唯一对话串"构建线程；用户轮归属其前一条 AI 轮的类别
        const fbs = Array.isArray(e.feedbacks) ? e.feedbacks : []
        this._fbRaw = fbs
        this._threads = this._buildFbThreads(fbs)
        // 默认聚焦最新一串；已选类别仍有内容则保持用户选择
        const keep = this.data.fbTab && this._threads[this.data.fbTab] && this._threads[this.data.fbTab].length
        if (!keep) {
          let lastKind = ''
          let lastTs = -1
          Object.keys(this._threads).forEach((k) => {
            const arr = this._threads[k]
            if (arr.length && arr[arr.length - 1].id > lastTs) {
              lastTs = arr[arr.length - 1].id
              lastKind = k
            }
          })
          this.setData({ fbTab: lastKind })
        }
        this.setData({ fbHasAny: fbs.length > 0 })
        this._renderFb()
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
        // 新反馈开启该类别的对话串，自动聚焦并飞入最新回复
        this.setData({ fbTab: kind })
        this._scrollToLatest = true
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

  /* ---------- 对话串：每类别唯一一串；芯片 = 查看/开启的唯一入口 ---------- */

  _buildFbThreads(fbs) {
    const threads = {}
    let cur = null
    fbs.forEach((f) => {
      if (!f) return
      const ts = fmt.toDate(f.createdAt).getTime()
      const isAi = f.kind !== 'user'
      if (isAi) cur = f.kind
      const kind = isAi ? f.kind : (cur || 'digest')
      const label = isAi
        ? ((FB_CHIPS.find((c) => c.k === f.kind) || {}).label || 'AI 反馈')
        : '我'
      if (!threads[kind]) threads[kind] = []
      threads[kind].push({
        id: ts,
        kind: f.kind,
        user: !isAi,
        label,
        text: f.text || '',
        timeText: fmt.hm(fmt.toDate(f.createdAt)),
        sources: (f.sources || []).map((s, i) => ({
          id: s.id,
          n: i + 1,
          label: s.dayKey
            ? (parseInt(s.dayKey.slice(5, 7), 10) + '月' + parseInt(s.dayKey.slice(8, 10), 10) + '日')
            : '记录',
          snippet: (s.snippet || '').slice(0, 24)
        }))
      })
    })
    return threads
  },

  // 渲染当前类别串：最新在上，串末（最旧端）挂整串删除按钮
  _renderFb() {
    const list = (this._threads && this._threads[this.data.fbTab]) || []
    const view = []
    list.slice().reverse().forEach((t) => {
      view.push(Object.assign({ type: 'turn', key: 'tt' + t.id }, t))
    })
    if (list.length) view.push({ type: 'gdel', key: 'dd' + this.data.fbTab, count: list.length })
    this.setData({ fbView: view })
    // 新回复到达时飞入最新一条（scroll-into-view 锚点）
    if (this._scrollToLatest && list.length) {
      this._scrollToLatest = false
      this.setData({ fbScrollInto: 't' + list[list.length - 1].id })
    }
  },

  // 类别芯片双职责：该类别有历史 → 直接切换查看；无历史 → 开启（生成首轮回复）
  onChipTap(e) {
    const kind = e.currentTarget.dataset.kind
    if (!kind || this.data.fbLoading) return
    if (this._threads && this._threads[kind] && this._threads[kind].length) {
      if (this.data.fbTab !== kind) {
        try { wx.vibrateShort({ type: 'light' }) } catch (err) { /* noop */ }
        this._scrollToLatest = false
        this.setData({ fbTab: kind })
        this._renderFb()
      }
      return
    }
    this.askFeedback(e) // 无历史：正常 AI 思考并产生第一次对话
  },

  // 删除某轮 = 截断：该轮及其之后的对话删掉，更早的保留
  deleteTurn(e) {
    const ts = Number(e.currentTarget.dataset.ts)
    const list = (this._threads && this._threads[this.data.fbTab]) || []
    const cut = list.filter((t) => t.id >= ts).length
    if (!cut) return
    wx.showModal({
      title: '删除这轮对话？',
      content: '将删除这条及之后的 ' + cut + ' 条对话，更早的保留。',
      confirmText: '删除',
      confirmColor: '#F0666E',
      success: (r) => {
        if (!r.confirm) return
        this._removeFbTs(new Set(list.filter((t) => t.id >= ts).map((t) => t.id)))
      }
    })
  },

  // 删除当前类别整串对话（二次确认）
  deleteThread() {
    const list = (this._threads && this._threads[this.data.fbTab]) || []
    if (!list.length) return
    const label = (FB_CHIPS.find((c) => c.k === this.data.fbTab) || {}).label || '对话'
    wx.showModal({
      title: '删除整串对话？',
      content: '将删除「' + label + '」的全部 ' + list.length + ' 条内容，不可恢复。',
      confirmText: '删除',
      confirmColor: '#F0666E',
      success: (r) => {
        if (!r.confirm) return
        this._removeFbTs(new Set(list.map((t) => t.id)))
      }
    })
  },

  // 按时间戳集合从原始 feedbacks 中剔除并写回
  _removeFbTs(set) {
    const filtered = (this._fbRaw || []).filter((f) => !set.has(fmt.toDate(f.createdAt).getTime()))
    wx.cloud.database().collection('entries').doc(this.data.id)
      .update({ data: { feedbacks: filtered } })
      .then(() => {
        wx.showToast({ title: '已删除', icon: 'none' })
        this.load()
      })
      .catch(() => wx.showToast({ title: '删除失败', icon: 'none' }))
  },

  onFollowInput(e) {
    this.setData({ followText: e.detail.value })
  },

  // 多轮追问：用户裸文本继续当前对话，AI 结合对话历史与（可选）检索记录作答
  sendFollowUp() {
    if (this.data.fbLoading) return
    const text = (this.data.followText || '').trim()
    if (!text) return
    if (!this.data.aiEnabled) {
      this._guideEnableAi()
      return
    }
    this.setData({ fbLoading: true })
    // 追问延续当前类别串
    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.SAVE_ENTRY,
      data: {
        feedback: true, followUp: true, entryId: this.data.id, text,
        useCtx: !!this.data.ctxEnabled, threadKind: this.data.fbTab
      }
    }).then((res) => {
      const r = res.result || {}
      if (r.ok) {
        this.setData({ fbLoading: false, followText: '' })
        this._scrollToLatest = true // 回复到达后飞入最新一条
        try { wx.vibrateShort({ type: 'light' }) } catch (e) { /* noop */ }
        this.load()
      } else if (r.error === 'no-key') {
        this.setData({ fbLoading: false })
        this._guideEnableAi()
      } else {
        this.setData({ fbLoading: false })
        wx.showToast({ title: 'AI 暂时没回应，稍后再试', icon: 'none' })
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
