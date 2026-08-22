const config = require('../../config')
const fmt = require('../../utils/format')
const pending = require('../../utils/pending')
const { typeMeta } = require('../../utils/types')

const MAX_RECORD_SECONDS = 60

let recorder = null
function getRecorder() {
  if (recorder) return recorder
  recorder = wx.getRecorderManager()
  return recorder
}

Page({
  data: {
    todayTitle: '',
    streak: 0,
    todayCount: 0,
    // 流程状态：idle(空闲/展示卡片) | recording(录音中) | transcribing(识别中)
    stage: 'idle',
    recordSeconds: 0,
    saving: false,
    // 最近一次保存的卡片（整理中/已整理/离线暂存）
    savedEntry: null,
    todayEntries: [],
    // 昨日复盘卡片（null 不显示）
    review: null
  },

  onLoad() {
    this._bindRecorder()
    this.refreshToday()
  },

  onShow() {
    this.refreshToday()
    this._checkApiConfig()
    this._ensureMicPermission()
    this._loadReview()
  },

  onHide() {
    this._forceStop()
  },

  onUnload() {
    this._forceStop()
  },

  /* ---------- 原生录音（RecorderManager） ---------- */

  _bindRecorder() {
    const r = getRecorder()
    r.onStart(() => {
      this._active = true
      this.setData({ stage: 'recording', recordSeconds: 0 })
      this._timer = setInterval(() => {
        const s = this.data.recordSeconds + 1
        this.setData({ recordSeconds: s })
        if (s >= MAX_RECORD_SECONDS) {
          clearInterval(this._timer)
          this._timer = null
        }
      }, 1000)
      // 若在启动完成前就已松手（极快点击），延迟一小会儿再停，保证产出有效文件
      if (this._pendingStop) {
        this._pendingStop = false
        setTimeout(() => this._stopRecord(), 300)
      }
    })
    r.onStop((res) => {
      this._stopUi()
      this._pendingStop = false
      if (res && res.tempFilePath) {
        this._onRecorded(res.tempFilePath)
      } else {
        this._resetStage()
      }
    })
    r.onError((err) => {
      const wasActive = this._active // 先记录是否真在录音，_stopUi 会清零
      const msg = (err && (err.errMsg || err.msg)) || ''
      this._stopUi()
      this._resetStage()
      this._pendingStop = false
      if (msg.indexOf('denied') > -1 || msg.indexOf('authorize') > -1) {
        this._guidePermission()
      } else if (wasActive) {
        // 确实在录音时出错才提示
        wx.showToast({ title: '录音失败，请重试', icon: 'none' })
      }
      // 未在录音时 stop 等产生的噪声错误：静默忽略
    })
  },

  _startRecord() {
    if (this.data.stage === 'recording' || this.data.stage === 'transcribing' || this.data.saving) return
    // 未开启 AI（原文记录模式）：首次点录音给一次知情提示，不硬拦截
    if (!this._aiEnabled && !wx.getStorageSync('promptedRawMode')) {
      this._promptEnableAi()
      return
    }
    this._deleted = false // 新一轮录音，重置删除标记
    this._pendingStop = false
    wx.getSetting({
      success: (res) => {
        if (res.authSetting['scope.record'] === true) {
          this._beginStart()
        } else {
          this._authorizeBeforeRecord()
        }
      },
      fail: () => this._authorizeBeforeRecord()
    })
  },

  // 权限已就绪：真正开始录音
  _beginStart() {
    const r = getRecorder()
    try {
      r.start({
        duration: MAX_RECORD_SECONDS * 1000,
        format: 'mp3',
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000
      })
    } catch (e) {
      wx.showToast({ title: '无法启动录音', icon: 'none' })
    }
  },

  // 未授权时：先弹我们自己确认框，再走系统授权（不打断按住手势）
  _authorizeBeforeRecord() {
    wx.showModal({
      title: '需要麦克风权限',
      content: '语音记录需要麦克风权限。是否前往授权？',
      confirmText: '去授权',
      cancelText: '取消',
      confirmColor: '#E8B44B',
      success: (r) => {
        if (!r.confirm) return
        wx.authorize({
          scope: 'scope.record',
          success: () => this._beginStart(),
          fail: () => this._guidePermission()
        })
      }
    })
  },

  // 首次打开时提前申请麦克风权限，避免授权弹窗打断首次按住说话
  _ensureMicPermission() {
    if (this._permChecked) return
    this._permChecked = true
    wx.getSetting({
      success: (res) => {
        if (res.authSetting['scope.record'] === false) return // 曾拒绝，按录音时再引导
        if (!res.authSetting['scope.record']) {
          wx.authorize({ scope: 'scope.record', fail: () => { /* 拒绝则按录音时再引导 */ } })
        }
      }
    })
  },

  _checkApiConfig() {
    if (!wx.cloud || !wx.cloud.database) return
    wx.cloud.database().collection('users').where({ _openid: '{openid}' }).limit(1).get()
      .then((res) => {
        const doc = res.data && res.data[0]
        // 只有明确选了 own/dev 才算开启 AI 整理；none / 未配置 → 原文记录
        this._aiEnabled = !!(doc && (doc.apiMode === 'own' || doc.apiMode === 'dev'))
      })
      .catch(() => { this._aiEnabled = false })
  },

  _promptEnableAi() {
    wx.showModal({
      title: '当前为原文记录模式',
      content: '尚未开启 AI 整理，记录将以原文保存。开启后 AI 可帮你清理语气词、自动分类、提取关键词。',
      confirmText: '去开启',
      cancelText: '仍然原文',
      confirmColor: '#E8B44B',
      success: (r) => {
        wx.setStorageSync('promptedRawMode', true) // 只提示一次
        if (r.confirm) wx.switchTab({ url: '/pages/settings/settings' })
      }
    })
  },

  _stopRecord() {
    const r = getRecorder()
    try { r.stop() } catch (e) { /* noop */ }
  },

  _forceStop() {
    // 页面隐藏/卸载时兜底停止，避免录音残留；只在真正录音时才 stop，
    // 否则对未录音的 RecorderManager 调 stop 会触发 onError（噪声错误）
    const wasRecording = this.data.stage === 'recording'
    this._active = false
    this._stopUi()
    const r = getRecorder()
    if (r && wasRecording) {
      try { r.stop() } catch (e) { /* noop */ }
    }
  },

  _stopUi() {
    this._active = false
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  },

  _guidePermission() {
    wx.showModal({
      title: '需要麦克风权限',
      content: '语音记录需要麦克风权限，请在设置中开启后重试。',
      confirmText: '去开启',
      success: (res) => { if (res.confirm) wx.openSetting() }
    })
  },

  /* ---------- 上传 → 识别 → 整理保存 ---------- */

  _onRecorded(tempFilePath) {
    this.setData({ stage: 'transcribing' })
    wx.cloud.uploadFile({
      cloudPath: 'audio/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.mp3',
      filePath: tempFilePath
    }).then((upRes) => {
      // 云函数 asr：音频 → 文字
      return wx.cloud.callFunction({
        name: config.CLOUD_FUNCTIONS.ASR,
        data: { fileID: upRes.fileID }
      })
    }).then((res) => {
      const text = res.result && res.result.text
      if (text) {
        this._submit(text)
      } else {
        this._resetStage()
        this._handleAsrError(res.result && res.result.error)
      }
    }).catch((err) => {
      this._resetStage()
      const detail = (err && (err.errMsg || err.message)) || String(err || '未知')
      console.warn('语音识别链路失败，路径=', tempFilePath, err)
      wx.showModal({
        title: '识别失败',
        content: '错误：' + detail + '\n录音文件：' + tempFilePath,
        confirmText: '文字输入',
        cancelText: '关闭',
        success: (r) => { if (r.confirm) this._openTextInput() }
      })
    })
  },

  _handleAsrError(err) {
    if (err === 'no-creds') {
      wx.showModal({
        title: '语音识别未配置',
        content: '需在云函数 asr 的环境变量中配置腾讯云 SecretId/SecretKey（见 README）。配置前可先用文字输入记录。',
        confirmText: '文字输入',
        cancelText: '取消',
        success: (r) => { if (r.confirm) this._openTextInput() }
      })
    } else if (err === 'no-speech') {
      wx.showToast({ title: '没有听清，请再说一次', icon: 'none' })
    } else {
      wx.showModal({
        title: '识别失败',
        content: '错误：' + (err || '未知') + '\n（也可到云开发控制台 asr 函数日志查看）',
        confirmText: '文字输入',
        cancelText: '关闭',
        success: (r) => { if (r.confirm) this._openTextInput() }
      })
    }
  },

  _resetStage() {
    this.setData({ stage: 'idle', savedEntry: null })
    if (this._clearTimer) clearTimeout(this._clearTimer)
  },

  _openTextInput() {
    this.setData({ stage: 'idle' })
    wx.showModal({
      title: '文字记录',
      editable: true,
      placeholderText: '此刻的想法…',
      success: (r) => {
        if (r.confirm && r.content && r.content.trim()) {
          this._submit(r.content.trim())
        }
      }
    })
  },

  _submit(raw) {
    // 先展示原文，AI 整理完成后原位替换
    this.setData({
      stage: 'idle',
      saving: true,
      savedEntry: { raw, text: raw, type: 'fragment', keywords: [], refined: false }
    })
    this._scheduleClearSaved()

    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.SAVE_ENTRY,
      data: { raw }
    }).then((res) => {
      this._finishSave()
      if (this._deleted) return // 用户在整理完成前点了删除
      const entry = res.result && res.result.entry
      if (entry) {
        const meta = typeMeta(entry.type)
        this.setData({
          savedEntry: Object.assign({}, entry, { typeLabel: meta.label, typeColor: meta.color })
        })
        this.refreshToday()
      }
    }).catch((err) => {
      this._finishSave()
      if (this._deleted) return
      // 离线 / 云函数失败 → 入本地队列，待网络恢复补传
      pending.enqueue(raw)
      this.setData({
        savedEntry: { raw, text: raw + '（已暂存本机，联网后自动同步）', type: 'fragment', keywords: [], refined: false }
      })
      console.warn('saveEntry 调用失败，已入离线队列', err)
    })
  },

  _finishSave() {
    this.setData({ saving: false })
  },

  _scheduleClearSaved() {
    if (this._clearTimer) clearTimeout(this._clearTimer)
    const token = (this._savedToken = (this._savedToken || 0) + 1)
    // 8 秒后收起卡片，回到干净状态，方便连续记录；仅清除本次的卡片
    this._clearTimer = setTimeout(() => {
      if (this._savedToken === token && this.data.savedEntry) {
        this.setData({ savedEntry: null })
      }
    }, 8000)
  },

  deleteLast() {
    if (this.data.saving) {
      wx.showToast({ title: '正在处理，稍候再操作', icon: 'none' })
      return
    }
    const entry = this.data.savedEntry
    if (!entry) return
    this._deleted = true
    this.setData({ savedEntry: null })
    if (this._clearTimer) clearTimeout(this._clearTimer)
    if (!entry._id) return // 离线暂存，直接丢弃卡片即可
    wx.cloud.database().collection('entries').doc(entry._id)
      .remove()
      .then(() => {
        this.refreshToday()
        wx.showToast({ title: '已删除', icon: 'none' })
      })
      .catch(() => this.refreshToday())
  },

  /* ---------- 昨日复盘 ---------- */

  _loadReview() {
    if (!wx.cloud || !wx.cloud.callFunction) return
    const yesterdayKey = fmt.dayKey(new Date(Date.now() - 86400000))
    // 当天已生成过就直接用缓存，避免反复调用云函数
    const cached = wx.getStorageSync('lastReview')
    if (cached && cached.dayKey === yesterdayKey) {
      this.setData({ review: cached })
      return
    }
    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.DAILY_REVIEW,
      data: {}
    }).then((res) => {
      const r = res.result
      if (r && r.hasEntries) {
        const review = { dayKey: yesterdayKey, title: r.title, summary: r.summary, refined: !!r.refined }
        wx.setStorageSync('lastReview', review)
        this.setData({ review })
      } else {
        this.setData({ review: null })
      }
    }).catch(() => { /* 失败则静默，不阻塞记录 */ })
  },

  dismissReview() {
    this.setData({ review: null })
  },

  /* ---------- 今日时间线与 streak ---------- */

  refreshToday() {
    if (!wx.cloud || !wx.cloud.database) return
    const now = new Date()
    const todayKey = fmt.dayKey(now)
    const db = wx.cloud.database()

    db.collection('entries')
      .where({ _openid: '{openid}', dayKey: todayKey })
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get()
      .then((res) => {
        const entries = (res.data || []).map((e) => ({
          _id: e._id,
          text: e.text || e.raw,
          type: e.type,
          keywords: e.keywords || [],
          createdAt: e.createdAt,
          raw: e.raw
        }))
        this.setData({
          todayTitle: fmt.friendlyDate(now) + ' · ' + fmt.weekday(now),
          todayCount: entries.length,
          todayEntries: entries
        })
        this._computeStreak()
      })
      .catch(() => {})
  },

  _computeStreak() {
    const db = wx.cloud.database()
    db.collection('entries')
      .where({ _openid: '{openid}' })
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get()
      .then((res) => {
        const days = new Set((res.data || []).map((e) => fmt.dayKey(fmt.toDate(e.createdAt))))
        let streak = 0
        const d = new Date()
        while (days.has(fmt.dayKey(d))) {
          streak++
          d.setDate(d.getDate() - 1)
        }
        this.setData({ streak })
      })
      .catch(() => {})
  },

  /* ---------- 事件转发 ---------- */

  onRecordStart() { this._startRecord() },
  onRecordStop() {
    // 松手：已在录音则停；还在启动中则标记，等 onStart 后延迟停（保证文件有效）
    if (this.data.stage === 'recording') {
      this._stopRecord()
    } else {
      this._pendingStop = true
    }
  },

  goHistory() { wx.switchTab({ url: '/pages/history/history' }) },
  goSettings() { wx.switchTab({ url: '/pages/settings/settings' }) },

  goDetail(e) {
    const id = e.detail && e.detail.id
    if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
  }
})
