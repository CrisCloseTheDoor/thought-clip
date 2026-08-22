/**
 * saveEntry —— AI 整理并保存一条记录
 *
 * 入参：
 *   raw         语音转写原文（必填，除非 test）
 *   test        (可选) true = 仅测试 DeepSeek 连通性，不落库
 *   apiKeyOverride (可选) 测试连接时临时传入的 Key，不落库
 *
 * Key 解析（双模式）：
 *   users.apiMode === 'own'  且 apiKey  → 用户自己的 Key
 *   users.apiMode === 'dev'  且 devConsent（已同意隐私说明）→ 环境变量 DEEPSEEK_API_KEY
 *   兜底：环境变量 DEEPSEEK_API_KEY
 *   均无 → 优雅降级，原文保存 refined=false
 */
const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'

const SYSTEM_PROMPT = `你是用户的个人记录整理助手。将口语化、带叠词和语气词的语音转写文本整理成简洁中文笔记，请严格输出 json。规则：
1. 删除叠词、语气助词（嗯/啊/呃/然后然后/就是就是）、无意义重复、口头禅；
2. 保持原意与关键细节，不新增不臆测；
3. 保留第一人称和日常语气，不过度书面化；
4. 分类 type：decision=做了决定或选择；reflection=思考/复盘/观点/情绪；fragment=日常记录/随想/待办；
5. 提取最多3个关键词 keywords；
6. 原文少于8字或内容无意义时，text 原样返回、type 用 fragment。
输出格式：{"text":"整理后文本","type":"decision|reflection|fragment","keywords":["词1","词2"]}`

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

async function callDeepSeek(apiKey, text, maxTokens) {
  const res = await postJson(DEEPSEEK_URL, { Authorization: 'Bearer ' + apiKey }, {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text }
    ],
    response_format: { type: 'json_object' },
    max_tokens: maxTokens || 500,
    temperature: 0.3
  })
  if (res.status !== 200) {
    const err = new Error('DeepSeek HTTP ' + res.status + ': ' + JSON.stringify(res.body).slice(0, 200))
    err.status = res.status
    throw err
  }
  const c = res.body && res.body.choices && res.body.choices[0] &&
    res.body.choices[0].message && res.body.choices[0].message.content
  return c || ''
}

// 解析并校验 AI 返回的 JSON
function parseResult(content) {
  try {
    const data = JSON.parse(content)
    const type = ['decision', 'reflection', 'fragment'].indexOf(data.type) >= 0 ? data.type : 'fragment'
    const keywords = Array.isArray(data.keywords) ? data.keywords.slice(0, 3).map(String).filter(Boolean) : []
    const text = typeof data.text === 'string' ? data.text.trim() : ''
    return text ? { text, type, keywords } : null
  } catch (e) {
    return null
  }
}

function dayKeyOf(ts) {
  const d = new Date(ts)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

// 双模式 Key 解析
async function resolveKey(openid, override) {
  if (override) return override
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
  // 严格模式：只有「开发者模式 + 已同意隐私说明」才用开发者的 Key
  return null
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const raw = typeof event.raw === 'string' ? event.raw.trim() : ''
  const isTest = !!event.test
  const override = typeof event.apiKeyOverride === 'string' && event.apiKeyOverride.trim()
    ? event.apiKeyOverride.trim() : null

  // 测试连接：不落库
  if (isTest) {
    const apiKey = await resolveKey(OPENID, override)
    if (!apiKey) return { ok: false, refined: false, error: 'no-key' }
    try {
      await callDeepSeek(apiKey, '测试连接，请回复 {"text":"ok","type":"fragment","keywords":[]}', 50)
      return { ok: true, refined: true }
    } catch (e) {
      return { ok: false, refined: false, error: e.message }
    }
  }

  if (!raw) return { error: 'raw is required' }

  // 默认结果：降级为原文
  let result = { text: raw, type: 'fragment', keywords: [], refined: false }

  const apiKey = await resolveKey(OPENID, null)
  if (apiKey && raw.length >= 8) {
    try {
      const content = await callDeepSeek(apiKey, raw, 500)
      const parsed = parseResult(content)
      if (parsed && parsed.text) {
        result = Object.assign({}, parsed, { refined: true })
      }
    } catch (e) {
      console.error('DeepSeek 调用失败，降级保存原文', e.message)
    }
  }

  // 落库
  const now = new Date()
  const doc = {
    _openid: OPENID,
    raw,
    text: result.text || raw,
    type: result.type,
    keywords: result.keywords || [],
    refined: result.refined,
    dayKey: dayKeyOf(now.getTime()),
    createdAt: now
  }
  const addRes = await db.collection('entries').add({ data: doc })
  doc._id = addRes._id
  doc.createdAt = now.toISOString()
  return { entry: doc }
}
