const fmt = require('../../utils/format')
const stats = require('../../utils/stats')
const audioUtil = require('../../utils/audio')
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
    heatTip: { show: false, key: '', text: '', x: 0, y: 0 },
    actionId: '',       // 长按展开内联操作条的记录
  },

  _page: 0,

  // 转发给朋友 / 分享到朋友圈
  onShareAppMessage() {
    return { title: '思绪剪藏 · 记录即复利', path: '/pages/index/index' }
  },
  onShareTimeline() {
    return { title: '思绪剪藏 · 记录即复利' }
  },

  onShow() {
    if (this._returningFromDetail) {
      // 从详情返回：原地刷新数据（不重置分页），恢复滚动位置
      this._returningFromDetail = false
      this._refreshInPlace()
      if (this._returnScroll > 0) {
        wx.nextTick(() => {
          wx.pageScrollTo({ scrollTop: this._returnScroll, duration: 0 })
        })
      }
    } else {
      this.reload()
      this._loadStats()
    }
  },

  // 追踪滚动位置（用于详情返回恢复 + 浮窗消失）
  onPageScroll(e) {
    this._scrollTop = e.scrollTop
    this.clearHeatTip()
  },

  onHide() {
    // 离开历史页（切 tab / 进详情）时停止卡片回听
    audioUtil.stopPlayback()
  },

  // 原地刷新：重新拉取已加载的页数，不重置分页
  _refreshInPlace() {
    if (!wx.cloud || !wx.cloud.database) return
    const db = wx.cloud.database()
    const pages = Math.max(this._page, 1)
    db.collection('entries')
      .where(this._buildWhere())
      .orderBy('createdAt', 'desc')
      .limit(pages * PAGE_SIZE)
      .get()
      .then((res) => {
        const list = (res.data || []).map((e) => {
          const t = fmt.toDate(e.createdAt)
          const meta = typeMeta(e.type)
          return {
            _id: e._id,
            kind: e.kind || '',
            title: e.title || '',
            hidden: e.hidden || false,
            password: e.password || '',
            amps: e.amps || [],
            duration: e.duration || 0,
            audioFileIDs: e.audioFileIDs || [],
            text: e.text || e.raw,
            type: e.type,
            keywords: e.keywords || [],
            createdAt: e.createdAt,
            raw: e.raw,
            timeText: fmt.hm(t),
            dayKey: e.dayKey || fmt.dayKey(t),
            typeLabel: meta.label,
            typeColor: meta.color
          }
        })
        // 全量重建分组（不追加，原地替换保持位置）
        const groups = []
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
        this.setData({ groups, finished: list.length < pages * PAGE_SIZE })
      })
      .catch(() => { /* 静默 */ })
  },

  reload() {
    this._page = 0
    this.setData({ groups: [], finished: false, actionId: '' })
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
            hidden: e.hidden || false,
            password: e.password || '',
            amps: e.amps || [],
            duration: e.duration || 0,
            audioFileIDs: e.audioFileIDs || [],
            text: e.text || e.raw,
            type: e.type,
            keywords: e.keywords || [],
            createdAt: e.createdAt,
            raw: e.raw,
            timeText: fmt.hm(t),
            // 分组用存储的 dayKey：离线补传的记录 createdAt 是补传时刻，
            // 用它换算日期会把旧记录漂浮到「今天」
            dayKey: e.dayKey || fmt.dayKey(t),
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
    // 去重：分页期间有新记录插入会导致相邻页边界重叠，跳过已展示的记录
    const seen = new Set()
    groups.forEach((g) => g.items.forEach((it) => seen.add(it._id)))
    list.forEach((item) => {
      if (seen.has(item._id)) return
      seen.add(item._id)
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

  // 近 15 周热力图：列为周（周一开头），行为周一～周日；
  // 窗口每天以"今天"为终点重算，最后一格恒为当天
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

  /* ---------- 长按操作（ActionSheet：密码贴纸 / 删除） ---------- */

  /* ---------- 卡片点按/长按：三通道兜底 ----------
     1. 组件 triggerEvent（tapentry/longpressentry）
     2. 原生事件冒泡（tap/longpress，跨组件边界，不依赖组件事件注入，
        规避 lazyCodeLoading 在真机调试下组件事件失效的场景）
     3. 自定义 500ms 计时长按（touchstart~end，容忍 12px 手抖），
        规避真机上手指微动触发 touchmove 导致系统长按被取消
     多通道同手势并发触发，由短窗时间锁去重（展开后改为内联操作条，不再调用面板类原生 API） */

  onCardLongPress(e) {
    const id = (e.detail && e.detail.id) ||
      (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id)
    if (!id) return
    this.openCardActions(id)
  },

  onCardTouchStart(e) {
    const t = e.touches && e.touches[0]
    const id = e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id
    if (!t || !id) return
    this._lpTouch = { x: t.clientX, y: t.clientY }
    this._lpFiredId = ''
    clearTimeout(this._lpTimer)
    this._lpTimer = setTimeout(() => {
      this._lpTimer = null
      this.openCardActions(id)
    }, 500)
  },

  onCardTouchMove(e) {
    if (!this._lpTouch || !this._lpTimer) return
    const t = e.touches && e.touches[0]
    if (!t) return
    const dx = t.clientX - this._lpTouch.x
    const dy = t.clientY - this._lpTouch.y
    if (dx * dx + dy * dy > 144) { // 移动超 12px 视为滚动，取消长按
      clearTimeout(this._lpTimer)
      this._lpTimer = null
    }
  },

  onCardTouchEnd() {
    clearTimeout(this._lpTimer)
    this._lpTimer = null
    this._lpTouch = null
  },

  openCardActions(id) {
    const now = Date.now()
    // 多通道同一次手势并发触发，800ms 内同 id 只处理一次
    if (this._lpSetId === id && now - this._lpSetAt < 800) return
    this._lpSetId = id
    this._lpSetAt = now
    // 记录本次长按，抑制收指被误判为 tap 的导航泄漏
    this._lpFiredId = id
    this._lpFiredAt = now
    try { wx.vibrateShort({ type: 'light' }) } catch (err) { /* noop */ }
    // 操作条已展开时再长按同一条 = 收起
    if (this.data.actionId === id) { this.setData({ actionId: '' }); return }
    this.setData({ actionId: id })
  },

  /* ---------- 卡片内联操作条（长按展开：密码贴纸 / 删除） ---------- */

  onActPwd(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    this.setData({ actionId: '' })
    const item = this._findEntry(id)
    if (item && item.hidden) this._removePwdFromList(id, item)
    else this._setPwdFromList(id, item)
  },

  onActDel(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    this.setData({ actionId: '' })
    this.deleteEntryById(id)
  },

  clearActions() {
    if (this.data.actionId) this.setData({ actionId: '' })
  },

  _setPwdFromList(id, item) {
    const defaultTitle = (item && item.text ? item.text : '').slice(0, 20) || fmt.dayKey(new Date())
    wx.showModal({
      title: '设为密码贴纸',
      editable: true,
      placeholderText: '设置查看密码（标题默认取内容前 20 字）',
      confirmText: '确认',
      success: (r) => {
        const pwd = (r.content || '').trim()
        if (!r.confirm) return
        if (!pwd) { wx.showToast({ title: '密码不能为空', icon: 'none' }); return }
        const db = wx.cloud.database()
        db.collection('entries').doc(id)
          .update({ data: { hidden: true, password: pwd, title: defaultTitle } })
          .then(() => {
            wx.showToast({ title: '已设为密码贴纸', icon: 'success' })
            this.reload()
          })
          .catch(() => wx.showToast({ title: '操作失败', icon: 'none' }))
      }
    })
  },

  _removePwdFromList(id) {
    wx.showModal({
      title: '取消密码保护',
      editable: true,
      placeholderText: '输入当前密码',
      success: (r) => {
        const pwd = (r.content || '').trim()
        if (!r.confirm) return
        const item = this._findEntry(id)
        if (item && item.password !== pwd) {
          wx.showToast({ title: '密码错误', icon: 'none' })
          return
        }
        const db = wx.cloud.database()
        const _ = db.command
        db.collection('entries').doc(id)
          .update({ data: { hidden: _.remove(), password: _.remove() } })
          .then(() => {
            wx.showToast({ title: '已取消密码保护', icon: 'success' })
            this.reload()
          })
          .catch(() => wx.showToast({ title: '操作失败', icon: 'none' }))
      }
    })
  },

  goDetail(e) {
    const id = (e.detail && e.detail.id) ||
      (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id)
    if (!id) return
    const now = Date.now()
    // 双通道（组件 tapentry + 原生冒泡 tap）同一次点按并发去重
    if (this._tapTs && now - this._tapTs < 800) return
    this._tapTs = now
    // 长按后个别机型把收指误判为 tap：同卡短窗内忽略（优先于操作条逻辑，避免刚展开就被收指关掉）
    if (this._lpFiredId && this._lpFiredId === id && now - this._lpFiredAt < 1500) return
    // 操作条展开时，首次点按只收起操作条（不跳转）
    if (this.data.actionId) {
      const was = this.data.actionId
      this.setData({ actionId: '' })
      if (id === was) return
    }
    // 保存滚动位置，返回时恢复到点进去的位置而非顶部
    this._returningFromDetail = true
    this._returnScroll = this._scrollTop || 0
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
  }
})
