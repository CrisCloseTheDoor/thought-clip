const { hm, toDate } = require('../../utils/format')
const { typeMeta } = require('../../utils/types')

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
      if (this._audio) {
        this._audio.destroy()
        this._audio = null
      }
    }
  },

  methods: {
    onTap() {
      if (this.properties.entry && this.properties.entry._id) {
        this.triggerEvent('tapentry', { id: this.properties.entry._id })
      }
    },

    // 点击关键词标签：不进入详情，交给页面去触发搜索
    onKeyword(e) {
      const kw = e.currentTarget.dataset.keyword
      if (kw) this.triggerEvent('tapkeyword', { keyword: kw })
    },

    // 声音灵感：卡片内直接回听（不打断浏览）
    onPlayTap() {
      const e = this.properties.entry
      if (!e || !e.audioFileIDs || !e.audioFileIDs.length) {
        wx.showToast({ title: '没有可播放的音频', icon: 'none' })
        return
      }
      if (this._audio && this.data.playing) {
        this._audio.stop()
        this.setData({ playing: false })
        return
      }
      if (!this._audio) {
        this._audio = wx.createInnerAudioContext()
        this._audio.onEnded(() => this.setData({ playing: false }))
        this._audio.onError(() => {
          // 云文件首次点播偶发解析失败：静默重试一次（即用户「点第二次才响」的场景）
          if (!this._retried) {
            this._retried = true
            const f = this.properties.entry && this.properties.entry.audioFileIDs &&
              this.properties.entry.audioFileIDs[0]
            setTimeout(() => {
              if (this.data.playing && this._audio && f) {
                this._audio.stop()
                this._audio.src = f
                this._audio.play()
              }
            }, 300)
            return
          }
          this.setData({ playing: false })
          wx.showToast({ title: '无法播放', icon: 'none' })
        })
      }
      this._retried = false
      this._audio.stop()
      this._audio.src = e.audioFileIDs[0]
      this.setData({ playing: true })
      this._audio.play()
    }
  }
})
