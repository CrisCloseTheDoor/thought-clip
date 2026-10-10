const fmt = require('../../utils/format')
const stats = require('../../utils/stats')
const { typeMeta } = require('../../utils/types')

const PAGE_SIZE = 20
const TYPES = [
  { value: '', label: '全部' },
  { value: 'decision', label: '决策' },
  { value: 'reflection', label: '反思' },
  { value: 'fragment', label: '碎片' }
]
const HEAT_DAYS = 105 // 近 15 周

Page({
  data: {
    types: TYPES,
    type: '',
    kw: '',
    groups: [],       // [{ dayKey, label, items: [] }]
    loading: false,
    finished: false,
    // 统计（null = 尚未加载，不显示统计区）
    total: null,
    streak: null,
    longestStreak: null,
    heatColumns: [],
    heatTip: { show: false, key: '', text: '', x: 0, y: 0 }
  },

  _page: 0,

  onShow() {
    this.reload()
    this._loadStats()
  },

  reload() {
    this._page = 0
    this.setData({ groups: [], finished: false })
    this.loadMore()
  },

  onReachBottom() {
    if (!this.data.loading && !this.data.finished) this.loadMore()
  },

  // 查询条件：openid + 排除回收站 + 类型筛选 + 关键词（匹配整理文本 / 原文 / 关键词 / 标题）
  _buildWhere() {
    const db = wx.cloud.database()
    const _ = db.command
    let cond = { _openid: '{openid}', deletedAt: _.exists(false) }
    if (this.data.type) cond.type = this.data.type
    const kw = (this.data.kw || '').trim()
    if (kw) {
      const re = db.RegExp({ regexp: fmt.escapeRegExp(kw), options: 'i' })
      // 声音灵感只有标题可搜；普通记录匹配整理文本/原文/关键词
      cond = _.and([cond, _.or([{ text: re }, { raw: re }, { keywords: re }, { title: re }])])
    }
    return cond
  },

  loadMore() {
    if (this.data.loading || this.data.finished) return
    if (!wx.cloud || !wx.cloud.database) return
    this.setData({ loading: true })
    const db = wx.cloud.database()
    db.collection('entries')
      .where(this._buildWhere())
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
            kind: e.kind || '',
            title: e.title || '',
            amps: e.amps || [],
            duration: e.duration || 0,
            audioFileIDs: e.audioFileIDs || [],
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

  /* ---------- 搜索与筛选 ---------- */

  onSearchInput(e) {
    this.setData({ kw: e.detail.value })
  },

  onSearchConfirm() {
    this.reload()
  },

  clearSearch() {
    if (!this.data.kw) return
    this.setData({ kw: '' })
    this.reload()
  },

  onTypeTap(e) {
    const v = e.currentTarget.dataset.value
    if (v === this.data.type) return
    this.setData({ type: v })
    this.reload()
  },

  // 点了记录卡片上的 #关键词 → 直接作为搜索词
  onKeywordTap(e) {
    const kw = e.detail && e.detail.keyword
    if (!kw) return
    this.setData({ kw })
    this.reload()
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },

  /* ---------- 统计与热力图 ---------- */

  _loadStats() {
    if (!wx.cloud || !wx.cloud.callFunction) return
    stats.loadSummary()
      .then((d) => {
        this.setData({
          total: d.total || 0,
          streak: d.streak || 0,
          longestStreak: d.longestStreak || 0,
          heatColumns: this._buildHeat(d.days || [])
        })
      })
      .catch(() => { /* 统计失败不阻塞列表 */ })
  },

  // 近 15 周热力图：列为周（周一开头），行为周一～周日
  _buildHeat(days) {
    const map = {}
    days.forEach((d) => { map[d.dayKey] = d.count })
    const cells = []
    for (let i = HEAT_DAYS - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000)
      const key = fmt.dayKey(d)
      const count = map[key] || 0
      cells.push({
        key,
        count,
        level: count === 0 ? 0 : (count === 1 ? 1 : (count <= 3 ? 2 : 3))
      })
    }
    // 第一列前补空位，让每列都从周一开始
    const firstDow = (new Date(Date.now() - (HEAT_DAYS - 1) * 86400000).getDay() + 6) % 7
    const columns = []
    let col = []
    for (let i = 0; i < firstDow; i++) {
      col.push({ key: 'pad' + i, blank: true })
    }
    cells.forEach((c) => {
      col.push(c)
      if (col.length === 7) {
        columns.push({ key: 'c' + columns.length, cells: col })
        col = []
      }
    })
    if (col.length) columns.push({ key: 'c' + columns.length, cells: col })
    // GitHub 式标注：月份变化处的列标月份（10月），行标周一/周三/周五在 wxml 固定
    columns.forEach((c, i) => {
      const firstReal = c.cells.find((s) => !s.blank)
      c.month = firstReal ? parseInt(firstReal.key.slice(5, 7), 10) : 0
      c.monthLabel = (i > 0 && c.month && c.month !== columns[i - 1].month) ? (c.month + '月') : ''
    })
    return columns
  },

  /* ---------- 热力图浮窗 ---------- */

  // 轻点色块：在指尖上方显示「N条 · M月D日」；再点同块或点空白处关闭
  onHeatTap(e) {
    const cell = e.currentTarget.dataset
    const key = cell.key || ''
    if (key.indexOf('pad') === 0) return // 前置补位空块
    if (this.data.heatTip.key === key && this.data.heatTip.show) {
      this.setData({ 'heatTip.show': false, 'heatTip.key': '' })
      return
    }
    const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0])
    if (!t) return
    const m = parseInt(key.slice(5, 7), 10)
    const d = parseInt(key.slice(8, 10), 10)
    let w = 375
    try { w = wx.getSystemInfoSync().windowWidth } catch (err) { /* 兜底 */ }
    const x = Math.min(Math.max(t.clientX, 110), w - 110)
    const y = Math.max(t.clientY, 90)
    this.setData({
      heatTip: {
        show: true,
        key,
        text: (cell.count || 0) + '条 · ' + m + '月' + d + '日',
        x,
        y
      }
    })
  },

  clearHeatTip() {
    if (this.data.heatTip.show) this.setData({ 'heatTip.show': false, 'heatTip.key': '' })
  },

  goDetail(e) {
    const id = e.detail && e.detail.id
    if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
  }
})
