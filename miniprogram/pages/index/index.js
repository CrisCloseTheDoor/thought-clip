const config = require('../../config')
const fmt = require('../../utils/format')
const pending = require('../../utils/pending')
const stats = require('../../utils/stats')
const audioUtil = require('../../utils/audio')
const { typeMeta } = require('../../utils/types')

const MAX_RECORD_SECONDS = 60
const WARN_AT = 52            // 距上限 8 秒时预警，提醒收尾
const SHORT_RECORD_MS = 1000  // 短于 1s 视为误触，直接剪枝不识别
const WAVE_BARS = 28          // 波形条数
const DRAFT_KEY = 'draftSticker'
const CLIP_KEEP_DAYS = 7

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
    // 流程状态：idle(空态/贴纸) | recording(录音中) | transcribing(识别中)
    stage: 'idle',
    recordSeconds: 0,
    bars: [],                 // 实时波形 [{k, v}]，v 为 0-100 高度
    saving: false,            // 贴纸保存中
    // 贴纸（未确认草稿）：语音段/文字段持续追加，点「完成」才保存
    sticker: null,            // { rev, segments: [{id, source, text, pending}] }
    stickerFocus: false,
    typedDraft: '',
    // 暂存语音（识别失败临时保留，7 天有效）
    clips: [],
    playingId: '',
    clipsKeepDays: CLIP_KEEP_DAYS,
    // 贴纸段落拖拽排序
    draggingId: '',
    dragDy: 0,
    todayEntries: [],
    // 昨日复盘卡片（null 不显示）
    review: null
  },

  onLoad() {
    this._bindRecorder()
    this._restoreDraft()
    this.refreshToday()
    this.loadClips()
  },

  onShow() {
    this.refreshToday()
    this._checkApiConfig()
    this._ensureMicPermission()
    this._loadReview()
    this._loadStreak()
    this.loadClips()
  },

  onHide() {
    this._forceStop()
  },

  onUnload() {
    this._forceStop()
    if (this._audio) {
      this._audio.destroy()
      this._audio = null
    }
  },

  _vibrate(type) {
    try { wx.vibrateShort({ type: type || 'light' }) } catch (e) { /* 低版本忽略 */ }
  },

  /* ---------- 原生录音（RecorderManager，wav 16kHz 单声道） ---------- */

  _bindRecorder() {
    const r = getRecorder()
    r.onStart(() => {
      this._active = true
      this._framesHeard = false
      this._pseudoLevel = 24
      this.setData({ stage: 'recording', recordSeconds: 0, bars: [] })
      this._timer = setInterval(() => {
        const s = this.data.recordSeconds + 1
        this.setData({ recordSeconds: s })
        if (s === WARN_AT) {
          this._vibrate('light')
          setTimeout(() => { if (this.data.stage === 'recording') this._vibrate('light') }, 260)
        }
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
      // 部分机型/开发者工具不回调 onFrameRecorded：700ms 后仍无帧则用平滑伪波形兜底
      setTimeout(() => {
        if (!this._framesHeard && this.data.stage === 'recording') {
          this._barTimer = setInterval(() => {
            this._pseudoLevel = Math.min(88, Math.max(10,
              this._pseudoLevel + (Math.random() * 56 - 28)))
            this._pushBar(Math.round(this._pseudoLevel))
          }, 130)
        }
      }, 700)
    })
    // 实时音量帧（wav 封装下 frameBuffer 为 16bit PCM 分片）
    r.onFrameRecorded((res) => {
      if (this.data.stage !== 'recording' || !res || !res.frameBuffer) return
      const i16 = new Int16Array(res.frameBuffer)
      if (!i16.length) return
      let sum = 0
      for (let i = 0; i < i16.length; i++) {
        const v = i16[i] / 32768
        sum += v * v
      }
      const rms = Math.sqrt(sum / i16.length)
      this._framesHeard = true
      this._pushBar(Math.min(100, Math.round(Math.sqrt(rms) * 260)))
    })
    r.onStop((res) => {
      this._stopUi()
      this._pendingStop = false
      if (res && res.tempFilePath) {
        // duration 缺失时用计时器秒数兜底，避免正常录音被误剪
        const durMs = res.duration || this.data.recordSeconds * 1000
        if (durMs >= SHORT_RECORD_MS) {
          this._onRecorded(res.tempFilePath, durMs)
        } else {
          // 误触（极短录音）：不上传不识别，本地临时文件由系统回收
          this._resetStage()
          wx.showToast({ title: '时间过短，多说一会吧', icon: 'none' })
        }
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

  _pushBar(v) {
    if (this.data.stage !== 'recording') return
    this._barSeq = (this._barSeq || 0) + 1
    const bars = this.data.bars.slice(-(WAVE_BARS - 1))
    bars.push({ k: this._barSeq, v: v })
    this.setData({ bars })
  },

  _startRecord() {
    if (this.data.stage === 'recording' || this.data.stage === 'transcribing' || this.data.saving) return
    // 未开启 AI（原文记录模式）：首次点录音给一次知情提示，不硬拦截
    if (!this._aiEnabled && !wx.getStorageSync('promptedRawMode')) {
      this._promptEnableAi()
      return
    }
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
      // 从贴纸内小麦克风录音时收起键盘，避免输入法挡住录音状态
      if (this.data.stickerFocus) this.setData({ stickerFocus: false })
      r.start({
        duration: MAX_RECORD_SECONDS * 1000,
        format: 'wav',
        sampleRate: 16000,
        numberOfChannels: 1,
        frameSize: 4 // KB/帧，驱动实时波形
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
        // 「保留原声」：成功识别的录音随记录长期保留（设置页开关，默认关）
        this._keepVoice = !!(doc && doc.keepVoice)
      })
      .catch(() => { this._aiEnabled = false; this._keepVoice = false })
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
    if (this._barTimer) { clearInterval(this._barTimer); this._barTimer = null }
  },

  _guidePermission() {
    wx.showModal({
      title: '需要麦克风权限',
      content: '语音记录需要麦克风权限，请在设置中开启后重试。',
      confirmText: '去开启',
      success: (res) => { if (res.confirm) wx.openSetting() }
    })
  },

  /* ---------- 上传 → 识别 → 追加进贴纸 ---------- */

  _onRecorded(tempFilePath, durationMs) {
    // 声音灵感素材：停录即解析本地 wav 量化幅度（48 档）与时长
    this._lastDuration = durationMs ? Math.round(durationMs / 1000) : 0
    audioUtil.computeAmps(tempFilePath, 48, (amps) => { this._lastAmps = amps })
    this.setData({ stage: 'transcribing' })
    wx.cloud.uploadFile({
      cloudPath: 'audio/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.wav',
      filePath: tempFilePath
    }).then((upRes) => {
      return this._transcribe(upRes.fileID)
    }).catch((err) => {
      // 上传失败（多为断网）：没有 fileID，无法重试识别，引导打字
      this._onChainError(err, null)
    })
  },

  // 识别一段已上传的音频；「重新识别」复用同一 fileID。
  // 贴纸的第一段语音始终保留音频：用户可能把它「转为声音灵感」
  //（识别成功即删的默认行为会让转换时无音频可用）
  _transcribe(fileID) {
    const firstSeg = !this.data.sticker || !this.data.sticker.segments.length
    this.setData({ stage: 'transcribing' })
    return wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.ASR,
      data: { fileID, keepOnSuccess: !!(this._keepVoice || firstSeg) }
    }).then((res) => {
      const result = res.result || {}
      if (result.text) {
        this._resetStage()
        // 保留原声开启或首段素材：fileID 随段落带入贴纸
        this._appendVoiceSegment(result.text, result.kept ? fileID : null)
        return
      }
      this._resetStage()
      if (result.error === 'no-speech') {
        this._onNoSpeech(fileID)
      } else {
        this._onChainError(result.error || '未知错误', fileID)
      }
    }).catch((err) => {
      console.warn('语音识别链路失败，fileID=', fileID, err)
      this._resetStage()
      this._onChainError(err, fileID)
    })
  },

  // 没识别到内容：音频已保留，让用户选择去向；哼旋律常走这条路。
  // 误触关闭选择框时默认暂存，内容不丢
  _onNoSpeech(fileID) {
    wx.showActionSheet({
      alertText: '没有识别到语音内容',
      itemList: ['重新识别', '存为声音灵感 ♪', '暂存语音（保留 ' + CLIP_KEEP_DAYS + ' 天）', '放弃这段录音'],
      success: (r) => {
        if (r.tapIndex === 0) {
          this._transcribe(fileID)
        } else if (r.tapIndex === 1) {
          this._promptInspirationTitle(fileID)
        } else if (r.tapIndex === 2) {
          this._keepAudio(fileID)
        } else {
          this._discardAudio(fileID)
        }
      },
      fail: () => {
        // 关闭选择框 = 不做决定：暂存保底，7 天内随时可回来处理
        this._keepAudio(fileID)
      }
    })
  },

  _keepAudio(fileID) {
    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.ASR,
      data: { keepAudio: fileID }
    }).then((res) => {
      if (res.result && res.result.ok) {
        wx.showToast({ title: '已暂存，' + CLIP_KEEP_DAYS + ' 天内有效', icon: 'none', duration: 2200 })
        this.loadClips()
      } else {
        wx.showToast({ title: '暂存失败', icon: 'none' })
      }
    }).catch(() => wx.showToast({ title: '暂存失败', icon: 'none' }))
  },

  _discardAudio(fileID) {
    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.ASR,
      data: { discard: fileID }
    }).catch(() => {})
  },

  // 识别链路出错（非 no-speech）：友好提示 + 短错误码，给「重试 / 转打字」两条路
  _onChainError(err, fileID) {
    let code = (err && (err.errMsg || err.message)) || (typeof err === 'string' ? err : '') || '未知'
    code = String(code).split('\n')[0].slice(0, 60)
    wx.showModal({
      title: '语音没识别成功',
      content: '这段录音没能转成文字' + (code && code !== '未知' ? '（' + code + '）' : '') + '。' +
        (fileID ? '可以再试一次，或改用打字继续这条贴纸。' : '当前可能网络不可用，可改用打字继续这条贴纸。'),
      confirmText: fileID ? '再试一次' : '打字记录',
      cancelText: fileID ? '打字记录' : '关闭',
      confirmColor: '#E8B44B',
      success: (r) => {
        if (r.confirm && fileID) {
          this._transcribe(fileID)
        } else if (r.confirm && !fileID) {
          this._openTyping()
        } else if (!r.confirm && fileID) {
          // 转打字：这段音频不再需要，静默删除
          this._discardAudio(fileID)
          this._openTyping()
        }
      }
    })
  },

  _resetStage() {
    this.setData({ stage: 'idle' })
  },

  /* ---------- 贴纸：语音/文字段追加，确认后一次性保存 ---------- */

  _ensureSticker() {
    let st = this.data.sticker
    if (!st) {
      st = { rev: Date.now(), segments: [] }
      this._stickerRev = st.rev
      this.setData({ sticker: st })
    }
    return this.data.sticker
  },

  _persistSticker() {
    try {
      if (this.data.sticker) wx.setStorageSync(DRAFT_KEY, this.data.sticker)
      else wx.removeStorageSync(DRAFT_KEY)
    } catch (e) { /* 存储异常不阻塞主流程 */ }
  },

  _restoreDraft() {
    try {
      const d = wx.getStorageSync(DRAFT_KEY)
      if (d && Array.isArray(d.segments)) {
        d.segments.forEach((s) => { s.pending = false }) // 上次中断的整理不再等待
        this._stickerRev = d.rev
        this.setData({ sticker: d })
      }
    } catch (e) { /* noop */ }
  },

  _clearSticker() {
    this._stickerRev = null
    this.setData({ sticker: null, typedDraft: '', stickerFocus: false })
    this._persistSticker()
  },

  // 语音段：原文先入贴纸，AI 开启时仅整理不落库，返回后原位替换；
  // fileID 为保留的原声，amps/duration 为声音灵感的量化素材
  _appendVoiceSegment(text, fileID) {
    if (!text) return
    const st = this._ensureSticker()
    const seg = {
      id: 's' + Date.now() + Math.floor(Math.random() * 1e4),
      source: 'voice',
      text: text,
      fileID: fileID || '',
      amps: this._lastAmps || null,
      duration: this._lastDuration || 0,
      pending: !!this._aiEnabled
    }
    st.segments.push(seg)
    this.setData({ sticker: st })
    this._persistSticker()
    if (seg.pending) this._refineSegment(st.rev, seg.id, text)
  },

  _refineSegment(rev, segId, raw) {
    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.SAVE_ENTRY,
      data: { raw, refineOnly: true }
    }).then((res) => {
      const r = res.result
      if (!r || !r.text) return
      const st = this.data.sticker
      if (!st || st.rev !== rev || this.data.saving) return
      const seg = st.segments.find((s) => s.id === segId)
      if (!seg || !seg.pending) return // 已被用户编辑或删除
      seg.text = r.text
      seg.pending = false
      this.setData({ sticker: st })
      this._persistSticker()
    }).catch(() => {
      // 整理失败保留原文即可
      const st = this.data.sticker
      if (!st || st.rev !== rev) return
      const seg = st.segments.find((s) => s.id === segId)
      if (seg) {
        seg.pending = false
        this.setData({ sticker: st })
        this._persistSticker()
      }
    })
  },

  /* ---------- 贴纸：打字 / 编辑 / 删除 ---------- */

  _openTyping() {
    this._ensureSticker()
    // 先置 false 再置 true，保证输入框已失焦过的情况下仍能重新拉起键盘
    this.setData({ stage: 'idle', stickerFocus: false })
    setTimeout(() => this.setData({ stickerFocus: true }), 60)
  },

  openTyping() {
    if (this.data.saving) return
    this._openTyping()
  },

  onTypedInput(e) {
    this.setData({ typedDraft: e.detail.value })
  },

  addTyped() {
    if (this.data.saving) return
    const t = (this.data.typedDraft || '').trim()
    if (!t) return
    const st = this._ensureSticker()
    st.segments.push({
      id: 's' + Date.now() + Math.floor(Math.random() * 1e4),
      source: 'text',
      text: t,
      pending: false
    })
    this.setData({ sticker: st, typedDraft: '' })
    this._persistSticker()
  },

  editSegment(e) {
    if (this.data.saving) return
    const id = e.currentTarget.dataset.id
    const st = this.data.sticker
    if (!st) return
    const seg = st.segments.find((s) => s.id === id)
    if (!seg) return
    wx.showModal({
      title: '编辑这段内容',
      editable: true,
      content: seg.text,
      confirmText: '保存',
      confirmColor: '#E8B44B',
      success: (r) => {
        if (!r.confirm) return
        const text = (r.content || '').trim()
        if (!text) {
          wx.showToast({ title: '内容不能为空', icon: 'none' })
          return
        }
        const cur = this.data.sticker
        if (!cur) return
        const target = cur.segments.find((s) => s.id === id)
        if (!target) return
        target.text = text
        target.pending = false
        this.setData({ sticker: cur })
        this._persistSticker()
      }
    })
  },

  removeSegment(e) {
    if (this.data.saving) return
    const id = e.currentTarget.dataset.id
    const st = this.data.sticker
    if (!st) return
    const seg = st.segments.find((s) => s.id === id)
    if (seg && seg.fileID) this._discardAudio(seg.fileID) // 段删了，原声一并清理
    st.segments = st.segments.filter((s) => s.id !== id)
    this.setData({ sticker: st })
    this._persistSticker()
  },

  discardSticker() {
    const st = this.data.sticker
    if (!st) return
    const doDiscard = () => {
      // 整条丢弃：段落里已保留的原声也一并清理，不留孤儿文件
      st.segments.forEach((s) => { if (s.fileID) this._discardAudio(s.fileID) })
      this._clearSticker()
      wx.showToast({ title: '已丢弃', icon: 'none' })
    }
    if (!st.segments.length) {
      doDiscard()
      return
    }
    wx.showModal({
      title: '丢弃这条贴纸？',
      content: '未确认的内容不会被保存，此操作不可恢复。',
      confirmText: '丢弃',
      confirmColor: '#F0666E',
      success: (r) => { if (r.confirm) doDiscard() }
    })
  },

  confirmSticker() {
    if (this.data.saving) return
    const st = this.data.sticker
    const segs = st ? st.segments.filter((s) => s.text && s.text.trim()) : []
    if (!segs.length) {
      wx.showToast({ title: '先说点什么或写点什么', icon: 'none' })
      return
    }
    const combined = segs.map((s) => s.text.trim()).join('\n')
    let audioFileIDs = segs.map((s) => s.fileID).filter(Boolean)
    // 未开「保留原声」：首段为转灵感而保留的音频此时用不上了，清掉
    if (!this._keepVoice && audioFileIDs.length) {
      audioFileIDs.forEach((f) => this._discardAudio(f))
      audioFileIDs = []
    }
    const dayKey = fmt.dayKey(new Date())
    this.setData({ saving: true })

    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.SAVE_ENTRY,
      data: { raw: combined, dayKey, audioFileIDs }
    }).then((res) => {
      this.setData({ saving: false })
      this._vibrate('medium')
      wx.showToast({ title: '已保存', icon: 'success' })
      this._clearSticker()
      stats.invalidate() // 今日统计/连续天数已变化
      this.refreshToday()
    }).catch((err) => {
      this.setData({ saving: false })
      console.warn('saveEntry 调用失败，已入离线队列', err)
      pending.enqueue(combined, dayKey, audioFileIDs)
      wx.showToast({ title: '已暂存本机，联网后自动同步', icon: 'none', duration: 2500 })
      this._clearSticker()
    })
  },

  /* ---------- 声音灵感：单段语音 → 标题 → 独立记录 ---------- */

  // 贴纸动作区入口：仅当贴纸是「单段语音 + 有音频 + 有量化幅度」时可转
  convertToInspiration() {
    if (this.data.saving) return
    const st = this.data.sticker
    const seg = st && st.segments.length === 1 ? st.segments[0] : null
    if (!seg || seg.source !== 'voice' || !seg.fileID || !seg.amps) return
    this._promptInspirationTitle(seg.fileID, seg.amps, seg.duration)
  },

  // no-speech（哼旋律）入口：幅度来自刚才停录时的解析结果。
  // 取消标题弹窗时回落到「暂存语音」，音频不悬空
  _promptInspirationTitle(fileID, amps, duration) {
    const defTitle = fmt.titleStamp(new Date())
    wx.showModal({
      title: '为声音灵感起个标题',
      editable: true,
      content: defTitle,
      placeholderText: defTitle,
      confirmText: '保存',
      confirmColor: '#E8B44B',
      success: (r) => {
        if (!r.confirm) {
          // 从 no-speech 进入（无贴纸上下文）时暂存兜底；从贴纸进入则保持贴纸原状
          if (!this.data.sticker) this._keepAudio(fileID)
          return
        }
        const title = ((r.content || '').trim() || defTitle).slice(0, 30)
        this._saveInspiration({
          title,
          amps: amps || this._lastAmps || [],
          duration: duration || this._lastDuration || 0,
          fileID
        })
      },
      fail: () => {
        if (!this.data.sticker) this._keepAudio(fileID)
      }
    })
  },

  _saveInspiration(opt) {
    if (this.data.saving) return
    const dayKey = fmt.dayKey(new Date())
    this.setData({ saving: true })
    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.SAVE_ENTRY,
      data: {
        kind: 'voice',
        title: opt.title,
        amps: opt.amps,
        duration: opt.duration,
        audioFileIDs: [opt.fileID],
        dayKey
      }
    }).then(() => {
      this.setData({ saving: false })
      this._vibrate('medium')
      wx.showToast({ title: '已存为声音灵感 ♪', icon: 'none' })
      this._clearSticker() // 音频已归记录所有，仅清草稿，不删音频
      stats.invalidate()
      this.refreshToday()
    }).catch((err) => {
      this.setData({ saving: false })
      console.warn('声音灵感保存失败，已入离线队列', err)
      pending.enqueueVoice({
        title: opt.title, amps: opt.amps, duration: opt.duration,
        audioFileIDs: [opt.fileID], dayKey
      })
      wx.showToast({ title: '已暂存本机，联网后自动同步', icon: 'none', duration: 2500 })
      this._clearSticker()
    })
  },

  /* ---------- 暂存语音（7 天有效） ---------- */

  loadClips() {
    if (!wx.cloud || !wx.cloud.database) return
    wx.cloud.database().collection('voiceClips')
      .where({ _openid: '{openid}' })
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get()
      .then((res) => {
        const clips = (res.data || []).map((d) => ({
          id: d._id,
          fileID: d.fileID,
          remainDays: fmt.remainingDays(d.expiresAt),
          createdText: fmt.hm(fmt.toDate(d.createdAt))
        })).filter((c) => c.remainDays > 0)
        this.setData({ clips })
      })
      .catch(() => {})
  },

  playClip(e) {
    const id = e.currentTarget.dataset.id
    const fileID = e.currentTarget.dataset.file
    if (this._playingId === id && this._audio) {
      this._audio.stop()
      this._playingId = ''
      this.setData({ playingId: '' })
      return
    }
    if (!this._audio) {
      this._audio = wx.createInnerAudioContext()
      this._audio.onEnded(() => {
        this._playingId = ''
        this.setData({ playingId: '' })
      })
      this._audio.onError(() => {
        // 云文件首次点播偶发解析失败：静默重试一次
        if (!this._retried) {
          this._retried = true
          setTimeout(() => {
            if (this._playingId === id && this._audio) {
              this._audio.stop()
              this._audio.src = fileID
              this._audio.play()
            }
          }, 300)
          return
        }
        this._playingId = ''
        this.setData({ playingId: '' })
        wx.showToast({ title: '无法播放，语音可能已过期', icon: 'none' })
      })
    }
    this._retried = false
    this._audio.stop()
    this._audio.src = fileID // 云文件 ID 可直接播放
    this._playingId = id
    this.setData({ playingId: id })
    this._audio.play()
  },

  reidentifyClip(e) {
    const id = e.currentTarget.dataset.id
    const fileID = e.currentTarget.dataset.file
    wx.showLoading({ title: '识别中…', mask: true })
    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.ASR,
      data: { fileID, keepOnSuccess: !!this._keepVoice }
    }).then((res) => {
      wx.hideLoading()
      const result = res.result || {}
      if (result.text) {
        // 成功：转入贴纸；保留原声开启时音频转挂到段落，只清暂存记录
        this._appendVoiceSegment(result.text, result.kept ? fileID : null)
        this._removeClipRecord(id, result.kept ? null : fileID)
        wx.showToast({ title: '已转入贴纸', icon: 'none' })
      } else if (result.error === 'no-speech') {
        wx.showToast({ title: '仍未识别到内容', icon: 'none' })
      } else {
        wx.showToast({ title: '识别失败，稍后再试', icon: 'none' })
      }
    }).catch(() => {
      wx.hideLoading()
      wx.showToast({ title: '识别失败，稍后再试', icon: 'none' })
    })
  },

  exportClip(e) {
    const fileID = e.currentTarget.dataset.file
    wx.showLoading({ title: '准备导出…', mask: true })
    wx.cloud.downloadFile({ fileID }).then((res) => {
      wx.hideLoading()
      wx.shareFileMessage({
        filePath: res.tempFilePath,
        fileName: '语音暂存-' + fmt.dayKey(new Date()) + '.wav',
        fail: (f) => {
          if (f && f.errMsg && f.errMsg.indexOf('cancel') > -1) return
          wx.showToast({ title: '当前环境不支持分享，请在手机上使用', icon: 'none', duration: 2200 })
        }
      })
    }).catch(() => {
      wx.hideLoading()
      wx.showToast({ title: '下载失败，请检查网络', icon: 'none' })
    })
  },

  deleteClip(e) {
    const id = e.currentTarget.dataset.id
    const fileID = e.currentTarget.dataset.file
    wx.showModal({
      title: '删除这段暂存语音？',
      content: '删除后不可恢复。',
      confirmText: '删除',
      confirmColor: '#F0666E',
      success: (r) => {
        if (!r.confirm) return
        this._removeClipRecord(id, fileID)
        wx.showToast({ title: '已删除', icon: 'none' })
      }
    })
  },

  _removeClipRecord(id, fileID) {
    // fileID 传 null 表示音频已被保留（转挂到记录/段落），只清暂存记录
    if (fileID) this._discardAudio(fileID)
    wx.cloud.database().collection('voiceClips').doc(id).remove()
      .then(() => this.loadClips())
      .catch(() => this.loadClips())
  },

  /* ---------- 昨日复盘 ---------- */

  _loadReview() {
    if (!wx.cloud || !wx.cloud.callFunction) return
    const yesterdayKey = fmt.dayKey(new Date(Date.now() - 86400000))
    this._yesterdayKey = yesterdayKey
    // 用户今天已手动关过：当天不再打扰（需在读取缓存前判断，否则缓存会把它顶回来）
    if (wx.getStorageSync('dismissedReviewDay') === yesterdayKey) {
      this.setData({ review: null })
      return
    }
    // 当天已生成过就直接用缓存，避免反复调用云函数
    const cached = wx.getStorageSync('lastReview')
    if (cached && cached.dayKey === yesterdayKey) {
      this.setData({ review: cached })
      return
    }
    wx.cloud.callFunction({
      name: config.CLOUD_FUNCTIONS.DAILY_REVIEW,
      data: { dayKey: yesterdayKey }
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
    // 记住「今天关过昨日复盘」，切 tab / 重进不再弹出
    if (this._yesterdayKey) {
      try { wx.setStorageSync('dismissedReviewDay', this._yesterdayKey) } catch (e) { /* noop */ }
    }
  },

  /* ---------- 连续天数与今日时间线 ---------- */

  _loadStreak() {
    if (!wx.cloud || !wx.cloud.callFunction) return
    stats.loadSummary()
      .then((d) => this.setData({ streak: d.streak || 0 }))
      .catch(() => { /* 静默，不打扰记录 */ })
  },

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
          kind: e.kind || '',
          title: e.title || '',
          amps: e.amps || [],
          duration: e.duration || 0,
          audioFileIDs: e.audioFileIDs || [],
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
      })
      .catch(() => {})
  },

  /* ---------- 贴纸段落：长按拖动排序 ---------- */

  onSegDragStart(e) {
    if (this.data.saving) return
    const st = this.data.sticker
    if (!st || st.segments.length < 2) return
    const id = e.currentTarget.dataset.id
    const segs = st.segments
    if (!segs.some((s) => s.id === id)) return
    // 实测每段高度，供换位计算（文本长度不一，不能假设等高）
    wx.createSelectorQuery().selectAll('.seg').boundingClientRect((rects) => {
      if (!rects || rects.length !== segs.length) return
      const h = {}
      segs.forEach((s, i) => { h[s.id] = rects[i].height })
      this._drag = {
        id,
        baseTop: rects[0].top,
        h,
        visualTop: rects[segs.indexOf(segs.find((s) => s.id === id))].top,
        lastY: e.touches && e.touches[0] ? e.touches[0].clientY : 0,
        lastSetAt: 0
      }
      this._vibrate('light')
      this.setData({ draggingId: id, dragDy: 0 })
    }).exec()
  },

  onSegDragMove(e) {
    const d = this._drag
    if (!d || !e.touches || !e.touches[0]) return
    const y = e.touches[0].clientY
    d.visualTop += y - d.lastY
    d.lastY = y
    this._dragReposition()
  },

  onSegDragEnd() {
    if (!this._drag) return
    this._drag = null
    this._persistSticker() // 顺序已实时变化，落草稿
    this.setData({ draggingId: '', dragDy: 0 })
  },

  _dragReposition() {
    const d = this._drag
    if (!d) return
    const segs = this.data.sticker.segments
    const cur = segs.findIndex((s) => s.id === d.id)
    if (cur < 0) { this._drag = null; return }

    // 拖拽项中心点越过哪个邻段的中点，就插到哪个位置
    const center = d.visualTop + d.h[d.id] / 2
    const others = segs.filter((s) => s.id !== d.id)
    let acc = d.baseTop
    let p = others.length
    for (let i = 0; i < others.length; i++) {
      const mid = acc + d.h[others[i].id] / 2
      if (center < mid) { p = i; break }
      acc += d.h[others[i].id]
    }

    let arr = segs
    if (p !== cur) {
      arr = segs.slice()
      arr.splice(cur, 1)
      arr.splice(p, 0, segs[cur])
      this._vibrate('light')
      this.setData({ 'sticker.segments': arr })
    }

    // 让拖拽项视觉位置保持跟手：位移 = 当前视觉顶部 - 当前排布下的自然顶部
    const idx = arr.findIndex((s) => s.id === d.id)
    let naturalTop = d.baseTop
    for (let i = 0; i < idx; i++) naturalTop += d.h[arr[i].id]
    const now = Date.now()
    if (now - d.lastSetAt > 32) {
      d.lastSetAt = now
      this.setData({ dragDy: d.visualTop - naturalTop })
    }
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
