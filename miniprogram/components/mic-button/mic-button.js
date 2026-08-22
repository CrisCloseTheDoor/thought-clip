Component({
  properties: {
    recording: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false }
  },

  methods: {
    onTouchStart() {
      if (this.data.disabled) return
      this._pressed = true
      try { wx.vibrateShort({ type: 'light' }) } catch (e) { /* 低版本忽略 */ }
      this.triggerEvent('recordstart')
    },

    onTouchEnd() {
      if (!this._pressed) return
      this._pressed = false
      this.triggerEvent('recordstop')
    },

    onTouchCancel() {
      if (!this._pressed) return
      this._pressed = false
      this.triggerEvent('recordstop')
    }
  }
})
