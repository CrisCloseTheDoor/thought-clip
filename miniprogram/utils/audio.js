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

module.exports = { computeAmps }
