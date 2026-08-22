const fmt = require('../../utils/format')
const { typeMeta } = require('../../utils/types')

Page({
  data: {
    id: '',
    entry: null,
    showRaw: false,
    editing: false,
    editText: ''
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.load()
  },

  load() {
    if (!wx.cloud || !wx.cloud.database) return
    const db = wx.cloud.database()
    db.collection('entries').doc(this.data.id).get()
      .then((res) => {
        const e = res.data
        const t = fmt.toDate(e.createdAt)
        const meta = typeMeta(e.type)
        this.setData({
          entry: Object.assign({}, e, {
            timeText: fmt.fullTime(t),
            typeLabel: meta.label,
            typeColor: meta.color
          }),
          editText: e.text || e.raw
        })
      })
      .catch(() => {
        wx.showToast({ title: '记录不存在或已删除', icon: 'none' })
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
      content: '删除后不可恢复。',
      confirmText: '删除',
      confirmColor: '#F0666E',
      success: (r) => {
        if (!r.confirm) return
        const db = wx.cloud.database()
        db.collection('entries').doc(this.data.id).remove()
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'none' })
            setTimeout(() => wx.navigateBack(), 600)
          })
          .catch(() => wx.showToast({ title: '删除失败', icon: 'none' }))
      }
    })
  }
})
