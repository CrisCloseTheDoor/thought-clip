const fmt = require('../../utils/format')
const stats = require('../../utils/stats')
const { typeMeta } = require('../../utils/types')

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
    editText: ''
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.load()
  },

  onUnload() {
    if (this._audio) {
      this._audio.destroy()
      this._audio = null
    }
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
      })
      .catch(() => {
        wx.showToast({ title: '记录不存在或已删除', icon: 'none' })
      })
  },

  /* ---------- 声音灵感 ---------- */

  toggleVoicePlay() {
    const e = this.data.entry
    if (!e || !e.audioFileIDs || !e.audioFileIDs.length) {
      wx.showToast({ title: '没有可播放的音频', icon: 'none' })
      return
    }
    if (this._audio && this.data.voicePlaying) {
      this._audio.stop()
      this.setData({ voicePlaying: false })
      return
    }
    if (!this._audio) {
      this._audio = wx.createInnerAudioContext()
      this._audio.onEnded(() => this.setData({ voicePlaying: false }))
      this._audio.onError(() => {
        // 云文件首次点播偶发解析失败：静默重试一次
        if (!this._retried) {
          this._retried = true
          const f = this.data.entry && this.data.entry.audioFileIDs &&
            this.data.entry.audioFileIDs[0]
          setTimeout(() => {
            if (this.data.voicePlaying && this._audio && f) {
              this._audio.stop()
              this._audio.src = f
              this._audio.play()
            }
          }, 300)
          return
        }
        this.setData({ voicePlaying: false })
        wx.showToast({ title: '无法播放', icon: 'none' })
      })
    }
    this._retried = false
    this._audio.stop()
    this._audio.src = e.audioFileIDs[0]
    this.setData({ voicePlaying: true })
    this._audio.play()
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
    if (this._audio && this.data.playingVoice === fileID) {
      this._audio.stop()
      this._playing = ''
      this.setData({ playingVoice: '' })
      return
    }
    if (!this._audio) {
      this._audio = wx.createInnerAudioContext()
      this._audio.onEnded(() => {
        this._playing = ''
        this.setData({ playingVoice: '' })
      })
      this._audio.onError(() => {
        // 云文件首次点播偶发解析失败：静默重试一次
        if (!this._retried) {
          this._retried = true
          setTimeout(() => {
            if (this.data.playingVoice === fileID && this._audio) {
              this._audio.stop()
              this._audio.src = fileID
              this._audio.play()
            }
          }, 300)
          return
        }
        this._playing = ''
        this.setData({ playingVoice: '' })
        wx.showToast({ title: '无法播放', icon: 'none' })
      })
    }
    this._retried = false
    this._audio.stop()
    this._audio.src = fileID // 云文件 ID 可直接播放
    this._playing = fileID
    this.setData({ playingVoice: fileID })
    this._audio.play()
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
      content: '删除后不可恢复。',
      confirmText: '删除',
      confirmColor: '#F0666E',
      success: (r) => {
        if (!r.confirm) return
        const db = wx.cloud.database()
        const audios = (this.data.entry && this.data.entry.audioFileIDs) || []
        db.collection('entries').doc(this.data.id).remove()
          .then(() => {
            // 记录删除后其音频（原声/声音灵感）一并清理，不留孤儿文件
            audios.forEach((f) => {
              wx.cloud.callFunction({
                name: 'asr',
                data: { discard: f }
              }).catch(() => {})
            })
            stats.invalidate()
            wx.showToast({ title: '已删除', icon: 'none' })
            setTimeout(() => wx.navigateBack(), 600)
          })
          .catch(() => wx.showToast({ title: '删除失败', icon: 'none' }))
      }
    })
  }
})
