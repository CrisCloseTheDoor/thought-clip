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
    timeText: ''
  },

  observers: {
    entry(v) {
      if (!v) return
      const meta = typeMeta(v.type)
      this.setData({
        typeLabel: meta.label,
        typeColor: meta.color,
        timeText: hm(toDate(v.createdAt))
      })
    }
  },

  methods: {
    onTap() {
      if (this.properties.entry && this.properties.entry._id) {
        this.triggerEvent('tapentry', { id: this.properties.entry._id })
      }
    }
  }
})
