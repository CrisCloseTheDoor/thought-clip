Component({
  properties: {
    recording: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false }
  },

  methods: {
    onTouchStart(e) {
      if (this.data.disabled) return
      this._pressed = true
      const y = (e.touches && e.touches[0]) ? e.touches[0].clientY : 0
      try { wx.vibrateShort({ type: 'light' }) } catch (e) { /* 低版本忽略 */ }
      this.triggerEvent('recordstart', { y })
    },

    onTouchMove(e) {
      if (!this._pressed) return
      const y = (e.touches && e.touches[0]) ? e.touches[0].clientY : 0
      if (y) this.triggerEvent('recordmove', { y })
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
