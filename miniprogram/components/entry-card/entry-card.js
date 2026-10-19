const { hm, toDate } = require('../../utils/format')
const { typeMeta } = require('../../utils/types')
const audioUtil = require('../../utils/audio')

Component({
  properties: {
    entry: { type: Object, value: null },
    showRaw: { type: Boolean, value: false },
    // compact 用于时间线紧凑展示（不显示时间戳）
    compact: { type: Boolean, value: false }
  },

  data: {
    typeLabel: '',
    typeColor: '#8A8F99',
    timeText: '',
    ampsView: [],
    playing: false
  },

  observers: {
    entry(v) {
      if (!v) return
      const meta = typeMeta(v.type)
      this.setData({
        typeLabel: meta.label,
        typeColor: meta.color,
        timeText: hm(toDate(v.createdAt)),
        // d = 播放动效的波纹延迟（8 根一循环，均衡器式起伏）
        ampsView: (v.amps || []).map((n, i) => ({
          v: Math.max(8, Math.min(100, n || 0)),
          d: ((i % 8) * 0.09).toFixed(2)
        }))
      })
    }
  },

  lifetimes: {
    detached() {
      if (this.data.playing) audioUtil.stopPlayback()
    }
  },

  methods: {
    onTap() {
      if (this.properties.entry && this.properties.entry._id) {
        this.triggerEvent('tapentry', { id: this.properties.entry._id })
      }
    },

    // 长按卡片：交给页面弹删除按钮（历史页）
    onLongPress() {
      if (this.properties.entry && this.properties.entry._id) {
        this.triggerEvent('longpressentry', { id: this.properties.entry._id })
      }
    },

    // 点击关键词标签：不进入详情，交给页面去触发搜索
    onKeyword(e) {
      const kw = e.currentTarget.dataset.keyword
      if (kw) this.triggerEvent('tapkeyword', { keyword: kw })
    },

    // 声音灵感：卡片内直接回听（走全局单播放器：新播放自动停上一个）
    onPlayTap() {
      const e = this.properties.entry
      if (!e || !e.audioFileIDs || !e.audioFileIDs.length) {
        wx.showToast({ title: '没有可播放的音频', icon: 'none' })
        return
      }
      if (this.data.playing) {
        audioUtil.stopPlayback()
        return
      }
      wx.showLoading({ title: '加载中…', mask: true })
      audioUtil.playCloudAudio(e.audioFileIDs[0], {
        onEnded: () => this.setData({ playing: false }),
        onStop: () => this.setData({ playing: false }),
        onError: () => this.setData({ playing: false })
      }).then(() => {
        wx.hideLoading()
        this.setData({ playing: true })
      }).catch(() => {
        wx.hideLoading()
        wx.showToast({ title: '加载失败，请检查网络', icon: 'none' })
      })
    }
  }
})
