// 日期格式化工具
function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

// 返回 yyyy-MM-dd
function dayKey(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

// 今天 / 昨天 / 几月几日 的友好展示
function friendlyDate(d) {
  const today = new Date()
  const kToday = dayKey(today)
  const kD = dayKey(d)
  const yesterday = new Date(today.getTime() - 86400000)
  if (kD === kToday) return '今天'
  if (kD === dayKey(yesterday)) return '昨天'
  return (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

// 星期几
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function weekday(d) {
  return WEEK[d.getDay()]
}

// HH:mm
function hm(d) {
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// 完整时间 yyyy-MM-dd HH:mm
function fullTime(d) {
  return dayKey(d) + ' ' + hm(d)
}

// 声音灵感默认标题：10月8日 14:32（日期+时刻，同日多条不重名）
function titleStamp(d) {
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm(d)
}

// 把数据库返回的时间转成 Date；兼容 Date / ISO 字符串 / 时间戳 / {$date}
function toDate(v) {
  if (!v) return new Date()
  if (v instanceof Date) return v
  if (typeof v === 'number') return new Date(v)
  if (typeof v === 'string') return new Date(v)
  if (v.$date) return new Date(v.$date)
  if (v.seconds) return new Date(v.seconds * 1000)
  return new Date()
}

// 转义正则特殊字符（搜索用户输入时使用）
function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 距过期时间的剩余天数（至少 1，过期返回 0）
function remainingDays(expiresAt) {
  const t = toDate(expiresAt).getTime() - Date.now()
  if (t <= 0) return 0
  return Math.max(1, Math.ceil(t / 86400000))
}

module.exports = { pad, dayKey, friendlyDate, weekday, hm, fullTime, titleStamp, toDate, escapeRegExp, remainingDays }
