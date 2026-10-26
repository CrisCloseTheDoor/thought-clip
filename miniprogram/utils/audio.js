// 音频分析：把本地 wav（16kHz 单声道 PCM）量化成少量幅度档位
// 用于「声音灵感」的简化可视化——只保留能量轮廓，不展示波形细节
function computeAmps(filePath, buckets, cb) {
  if (typeof buckets !== 'number' || buckets <= 0) buckets = 16
  wx.getFileSystemManager().readFile({
    filePath,
    success: (res) => {
      try {
        const dv = new DataView(res.data)
        // 跳过 RIFF/WAVE 头，定位 data 块（兼容非 44 字节头的变体）
        let off = 12
        let dataLen = Math.max(0, dv.byteLength - 44)
        while (off + 8 <= dv.byteLength) {
          const id = String.fromCharCode(
            dv.getUint8(off), dv.getUint8(off + 1),
            dv.getUint8(off + 2), dv.getUint8(off + 3)
          )
          const size = dv.getUint32(off + 4, true)
          if (id === 'data') {
            dataLen = Math.min(size, dv.byteLength - off - 8)
            off += 8
            break
          }
          off += 8 + size + (size % 2)
        }
        const nSamples = Math.floor(dataLen / 2)
        if (nSamples <= 0) { cb(null); return }

        const per = Math.max(1, Math.floor(nSamples / buckets))
        const amps = []
        for (let b = 0; b < buckets; b++) {
          const start = b * per
          if (start >= nSamples) { amps.push(0); continue }
          let sum = 0, cnt = 0
          // 每桶最多抽 200 个样本，长录音也不卡
          const stride = Math.max(1, Math.floor(per / 200))
          for (let i = start; i < Math.min(start + per, nSamples) && cnt < 200; i += stride) {
            const v = dv.getInt16(off + i * 2, true) / 32768
            sum += v * v
            cnt++
          }
          const rms = cnt ? Math.sqrt(sum / cnt) : 0
          // 与实时波形同一映射（√rms 放大弱信号），输出 0-100 整数
          amps.push(Math.min(100, Math.round(Math.sqrt(rms) * 260)))
        }
        cb(amps)
      } catch (e) {
        cb(null)
      }
    },
    fail: () => cb(null)
  })
}

// ---------- 全局音频播放器（全 app 唯一播放出口） ----------
// 设计要点（对应三个真机问题的根治）：
// 1. 互斥：任何新播放自动停止上一个（跨页面生效）——不会出现多个声音同时播
// 2. 录制互斥：开始录音前调用 stopPlayback()——回听不会继续、也不会被录入麦克风
// 3. 每次播放销毁重建 InnerAudioContext——规避复用旧上下文在录音会话后偶发的断续
// 4. 整段下载到本地播放 + 会话缓存；缓存路径用前校验，被系统清理则自动重下
let _ctx = null
let _cur = null // { fileID, handlers, retried }
const _fileCache = {}

function _destroyCtx() {
  if (_ctx) {
    try { _ctx.destroy() } catch (e) { /* noop */ }
    _ctx = null
  }
}

// 停止当前播放；通过 onStop 通知原调用方复位界面状态
function stopPlayback() {
  if (!_cur) return
  const h = _cur.handlers
  _cur = null
  _destroyCtx()
  if (h && h.onStop) h.onStop()
}

function _start(fileID, path, handlers, retried) {
  // 下载期间若已被其他播放占位（快速连点不同音频的竞态），先通知旧调用方复位
  if (_cur && _cur.fileID !== fileID) {
    const old = _cur.handlers
    _cur = null
    if (old && old.onStop) old.onStop()
  }
  _destroyCtx()
  _ctx = wx.createInnerAudioContext()
  // iOS 静音开关不影响回放（用户点播放即收听意图）；需在 src 赋值前设置
  try { _ctx.obeyMuteSwitch = false } catch (e) { /* 非 iOS 无此属性 */ }
  // 部分机型上"新建上下文后立即 play()"存在起播竞态，autoplay 由系统择机起播更稳
  _ctx.autoplay = true
  _cur = { fileID, handlers, retried: !!retried }
  _ctx.onEnded(() => {
    const h = _cur && _cur.handlers
    _cur = null
    _destroyCtx()
    if (h && h.onEnded) h.onEnded()
  })
  _ctx.onError((err) => {
    console.warn('[audio] onError', fileID, 'retried=', !!(_cur && _cur.retried), err)
    if (!_cur || _cur.fileID !== fileID) return
    if (!_cur.retried) {
      // 本地文件偶发未就绪：静默重试一次（retried 透传，防止无限重试）
      const cur = _cur
      setTimeout(() => {
        if (_cur === cur) _start(fileID, path, handlers, true)
      }, 300)
      return
    }
    const h = _cur.handlers
    _cur = null
    _destroyCtx()
    if (h && h.onError) h.onError()
    wx.showToast({ title: '无法播放', icon: 'none' })
  })
  _ctx.src = path
}

function _ensureLocal(fileID) {
  const cached = _fileCache[fileID]
  if (cached) {
    try {
      wx.getFileSystemManager().accessSync(cached)
      return Promise.resolve(cached)
    } catch (e) {
      delete _fileCache[fileID] // 临时文件已被系统清理，重新下载
    }
  }
  return new Promise((resolve, reject) => {
    wx.cloud.downloadFile({
      fileID,
      success: (res) => {
        _fileCache[fileID] = res.tempFilePath
        resolve(res.tempFilePath)
      },
      fail: reject
    })
  })
}

// 播放云存储音频。handlers = { onEnded, onStop, onError }，
// 被新播放顶掉或手动停止时回调 onStop，调用方据此复位按钮状态。
function playCloudAudio(fileID, handlers) {
  return new Promise((resolve, reject) => {
    if (!fileID) {
      reject(new Error('no fileID'))
      return
    }
    stopPlayback() // 互斥：先停掉任何在播音频
    _ensureLocal(fileID)
      .then((path) => {
        _start(fileID, path, handlers || {})
        resolve()
      })
      .catch(reject)
  })
}

module.exports = { computeAmps, playCloudAudio, stopPlayback }
