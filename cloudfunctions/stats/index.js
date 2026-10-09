/**
 * stats —— 用户数据统计 / 导出 / 暂存语音过期清理
 *
 * 入参：
 *   无参或 { action: 'summary' }
 *     → { total, streak, longestStreak, days: [{ dayKey, count }] }
 *       days 按日期倒序，最多近 400 天，供首页 streak 与历史页热力图使用
 *   { action: 'export', skip, limit }
 *     → 按时间正序分块导出记录的 Markdown 片段
 *       { markdown, count, hasMore }（分块传输，避免超过云函数响应大小限制）
 *
 * 定时触发器（config.json）：每天 04:00 清理过期「暂存语音」
 *   - 删除 voiceClips 中 expiresAt 已过期的记录及其云端音频文件
 *
 * 时区约定：dayKey 统一为东八区日期，与客户端写入时的值一致；
 * 此处显式用 +8h 后的 UTC 分量计算，不依赖容器本地时区。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate

const SUMMARY_DAYS = 400   // summary 覆盖的最多天数（连续天数/热力图足够）
const EXPORT_CHUNK = 300   // 导出分块大小
const EXPORT_MAX = 5000    // 导出总量上限，防止极端数据拖垮函数

function pad(n) { return n < 10 ? '0' + n : '' + n }

// 东八区日期键
function dayKeyOfTs(ts) {
  const d = new Date(ts + 8 * 3600 * 1000)
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
}

function dayKeyAdd(dayKey, deltaDays) {
  const [y, m, d] = dayKey.split('-').map(Number)
  return dayKeyOfTs(Date.UTC(y, m - 1, d) - 8 * 3600 * 1000 + deltaDays * 86400000)
}

// 统计：按 dayKey 聚合条数 + 连续天数
async function summary(openid) {
  const res = await db.collection('entries').aggregate()
    .match({ _openid: openid })
    .group({ _id: '$dayKey', count: $.sum(1) })
    .sort({ _id: -1 })
    .limit(SUMMARY_DAYS)
    .end()

  const list = (res.list || []).filter((d) => d._id)
  const days = list.map((d) => ({ dayKey: d._id, count: d.count }))
  const total = days.reduce((s, d) => s + d.count, 0)

  // 当前连续天数：从今天（或昨天，容忍今天还没记）往前数
  let streak = 0
  let cursor = dayKeyOfTs(Date.now())
  if (!days.some((d) => d.dayKey === cursor)) cursor = dayKeyAdd(cursor, -1)
  while (days.some((d) => d.dayKey === cursor)) {
    streak++
    cursor = dayKeyAdd(cursor, -1)
  }

  // 历史最长连续天数
  const asc = days.map((d) => d.dayKey).sort()
  let longest = 0, run = 0
  for (let i = 0; i < asc.length; i++) {
    if (i > 0 && dayKeyAdd(asc[i - 1], 1) === asc[i]) run++
    else run = 1
    if (run > longest) longest = run
  }

  return { total, streak, longestStreak: longest, days }
}

const TYPE_LABEL = { decision: '决策', reflection: '反思', fragment: '碎片' }

// 东八区 HH:mm
function hmOfTs(ts) {
  const d = new Date(ts + 8 * 3600 * 1000)
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes())
}

// 导出分块：返回该块 Markdown（按天分组的行），hasMore 提示客户端继续取
async function exportMarkdown(openid, skip, limit) {
  const chunk = Math.min(Math.max(limit || EXPORT_CHUNK, 1), EXPORT_CHUNK)
  const res = await db.collection('entries')
    .where({ _openid: openid })
    .orderBy('createdAt', 'asc')
    .skip(Math.max(skip || 0, 0))
    .limit(chunk)
    .get()

  const entries = res.data || []
  if (!entries.length) return { markdown: '', count: 0, hasMore: false }

  const byDay = new Map()
  entries.forEach((e) => {
    const key = e.dayKey || dayKeyOfTs(new Date(e.createdAt).getTime())
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(e)
  })

  const lines = []
  byDay.forEach((items, day) => {
    lines.push('\n## ' + day + '\n')
    items.forEach((e) => {
      const time = hmOfTs(new Date(e.createdAt).getTime())
      if (e.kind === 'voice') {
        // 声音灵感：只有标题与录音，Markdown 无法内嵌音频
        lines.push('- **[声音灵感]** ' + time + ' ♪ ' + (e.title || '') +
          '（' + (e.duration || 0) + 's 录音）')
        return
      }
      const type = TYPE_LABEL[e.type] || '碎片'
      const kws = (e.keywords || []).map((k) => ' #' + k).join('')
      lines.push('- **[' + type + ']** ' + time + ' ' + (e.text || e.raw || '') + kws)
      if (e.raw && e.text && e.raw !== e.text) {
        lines.push('  > 原文：' + e.raw)
      }
      if (e.edited) lines.push('  >（已手动编辑）')
    })
  })

  return {
    markdown: lines.join('\n'),
    count: entries.length,
    hasMore: entries.length >= chunk && (skip || 0) + entries.length < EXPORT_MAX
  }
}

// 定时清理：删除过期暂存语音的云端音频与记录
async function cleanupExpiredClips() {
  const now = new Date()
  let cleaned = 0
  // 循环处理，单次最多清理 500 条，防止积压时超时
  for (let round = 0; round < 25; round++) {
    const res = await db.collection('voiceClips')
      .where({ expiresAt: _.lt(now) })
      .limit(20)
      .get()
    const clips = res.data || []
    if (!clips.length) break
    for (const clip of clips) {
      try { await cloud.deleteFile({ fileList: [clip.fileID] }) } catch (e) { /* 文件可能已不存在 */ }
      try { await db.collection('voiceClips').doc(clip._id).remove() } catch (e) { /* noop */ }
      cleaned++
    }
  }
  console.log('清理过期暂存语音', cleaned, '条')
  return { cleaned }
}

exports.main = async (event) => {
  // 定时触发器：event 形如 { Type: 'Timer', TriggerName: '...' }
  if (event.Type === 'Timer' || event.triggerName || event.TriggerName || event.action === 'cleanup') {
    return cleanupExpiredClips()
  }

  const { OPENID } = cloud.getWXContext()

  if (event.action === 'export') {
    return exportMarkdown(OPENID, event.skip, event.limit)
  }

  return summary(OPENID)
}
