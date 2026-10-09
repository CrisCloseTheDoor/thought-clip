/**
 * dailyReview —— 生成「昨日复盘」简报（应用内展示，不做推送）
 *
 * 入参：{ dayKey } 可选，默认昨日（yyyy-MM-dd）
 * 返回：{ hasEntries, title, summary, refined }
 *   - 有昨日记录：有 AI Key（自用/开发者模式）→ DeepSeek 生成；否则返回统计摘要
 *   - 无昨日记录：{ hasEntries: false }
 *
 * 环境变量（可选）：DEEPSEEK_API_KEY —— 开发者模式共享 Key，仅对「dev + 已同意」的用户生效
 */
const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = JSON.stringify(body)
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }, headers)
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch (e) { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// 东八区日期键：不依赖云函数容器本地时区（客户端通常会显式传 dayKey，此处为兜底）
function dayKeyOf(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
}

// 与 saveEntry 一致的严格 Key 解析：只有 dev+已同意才用开发者 Key
async function resolveKey(openid) {
  try {
    const res = await db.collection('users').where({ _openid: openid }).limit(1).get()
    const doc = res.data && res.data[0]
    if (doc) {
      if (doc.apiMode === 'own' && doc.apiKey) return doc.apiKey
      if (doc.apiMode === 'dev' && doc.devConsent && process.env.DEEPSEEK_API_KEY) {
        return process.env.DEEPSEEK_API_KEY
      }
    }
  } catch (e) {
    console.warn('读取 users 配置失败', e)
  }
  return null
}

async function callDeepSeek(apiKey, texts) {
  const lines = texts.slice(0, 30).map((t, i) => (i + 1) + '. ' + t).join('\n')
  const userPrompt = '下面是用户昨天的个人记录，请提炼成 3-5 条要点，作为「昨日复盘」展示给用户。' +
    '要求：保留关键决策、思考与情绪；用第一人称；总字数 120 字以内。' +
    '请严格输出 json：{"title":"一句话标题","summary":"要点内容"}。\n\n记录：\n' + lines

  const res = await postJson(DEEPSEEK_URL, { Authorization: 'Bearer ' + apiKey }, {
    model: MODEL,
    messages: [
      { role: 'system', content: '你是一个温柔的个人复盘助手，请严格输出 json。' },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: 'json_object' },
    max_tokens: 400,
    temperature: 0.4
  })
  if (res.status !== 200) {
    throw new Error('DeepSeek HTTP ' + res.status + ': ' + JSON.stringify(res.body).slice(0, 200))
  }
  const c = res.body && res.body.choices && res.body.choices[0] &&
    res.body.choices[0].message && res.body.choices[0].message.content
  if (!c) throw new Error('DeepSeek 返回为空')
  try {
    const d = JSON.parse(c)
    return { title: (d.title || '昨日复盘').slice(0, 20), summary: (d.summary || '').slice(0, 200) }
  } catch (e) {
    return { title: '昨日复盘', summary: c.slice(0, 120) }
  }
}

// 未开 AI 时的统计摘要
function statsSummary(entries) {
  const byType = { decision: 0, reflection: 0, fragment: 0 }
  entries.forEach((e) => { byType[e.type] = (byType[e.type] || 0) + 1 })
  const parts = []
  if (byType.decision) parts.push('决策 ' + byType.decision + ' 条')
  if (byType.reflection) parts.push('反思 ' + byType.reflection + ' 条')
  if (byType.fragment) parts.push('碎片 ' + byType.fragment + ' 条')
  return {
    title: '昨日共 ' + entries.length + ' 条记录',
    summary: parts.join(' · ') || '（无分类信息）'
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  // 默认昨日（东八区）；容器时区不确定，用 +8h 后的 UTC 分量计算
  const dayKey = event.dayKey || dayKeyOf(new Date(Date.now() + 8 * 3600 * 1000 - 86400000))

  const entryRes = await db.collection('entries')
    .where({ _openid: OPENID, dayKey })
    .limit(30)
    .get()
  const entries = entryRes.data || []
  if (!entries.length) return { hasEntries: false }

  const apiKey = await resolveKey(OPENID)
  if (!apiKey) {
    return Object.assign({ hasEntries: true, refined: false }, statsSummary(entries))
  }

  try {
    const texts = entries.map((e) => e.text || e.raw).filter(Boolean)
    const r = await callDeepSeek(apiKey, texts)
    return Object.assign({ hasEntries: true, refined: true }, r)
  } catch (e) {
    console.error('复盘生成失败，回退统计摘要', e.message)
    return Object.assign({ hasEntries: true, refined: false }, statsSummary(entries))
  }
}
