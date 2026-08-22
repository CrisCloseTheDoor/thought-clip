const fmt = require('../../utils/format')
const { typeMeta } = require('../../utils/types')

const PAGE_SIZE = 20

Page({
  data: {
    groups: [],       // [{ dayKey, label, items: [] }]
    loading: false,
    finished: false
  },

  _page: 0,

  onShow() {
    this.reload()
  },

  reload() {
    this._page = 0
    this.setData({ groups: [], finished: false })
    this.loadMore()
  },

  onReachBottom() {
    if (!this.data.loading && !this.data.finished) this.loadMore()
  },

  loadMore() {
    if (this.data.loading || this.data.finished) return
    if (!wx.cloud || !wx.cloud.database) return
    this.setData({ loading: true })
    const db = wx.cloud.database()
    db.collection('entries')
      .where({ _openid: '{openid}' })
      .orderBy('createdAt', 'desc')
      .skip(this._page * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .get()
      .then((res) => {
        const list = (res.data || []).map((e) => {
          const t = fmt.toDate(e.createdAt)
          const meta = typeMeta(e.type)
          return {
            _id: e._id,
            text: e.text || e.raw,
            type: e.type,
            keywords: e.keywords || [],
            createdAt: e.createdAt,
            raw: e.raw,
            timeText: fmt.hm(t),
            dayKey: fmt.dayKey(t),
            typeLabel: meta.label,
            typeColor: meta.color
          }
        })
        this._page++
        this.setData({
          groups: this._merge(list),
          loading: false,
          finished: list.length < PAGE_SIZE
        })
      })
      .catch(() => this.setData({ loading: false }))
  },

  _merge(list) {
    const groups = this.data.groups.slice()
    list.forEach((item) => {
      const last = groups[groups.length - 1]
      if (last && last.dayKey === item.dayKey) {
        last.items.push(item)
      } else {
        groups.push({
          dayKey: item.dayKey,
          label: fmt.friendlyDate(fmt.toDate(item.createdAt)),
          items: [item]
        })
      }
    })
    return groups
  },

  goDetail(e) {
    const id = e.detail && e.detail.id
    if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
  }
})
