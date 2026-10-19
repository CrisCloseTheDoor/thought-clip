/**
 * saveEntry —— AI 整理并保存一条记录
 *
 * 入参：
 *   raw             文本（必填，除非 test / kind=voice）
 *   dayKey          (可选) 客户端本地日期 yyyy-MM-dd。优先使用，避免云函数
 *                   容器时区不确定导致凌晨记录归错日期；缺省/非法时服务端
 *                   按东八区显式计算兜底
 *   audioFileIDs    (可选) 「保留原声」开启时的录音云文件 ID 数组，随记录落库
 *   kind            (可选) 'voice' = 声音灵感：title/amps/duration 必备，不经 AI
 *   feedback        (可选) true = 对已有记录按需生成 AI 反馈（kind 为反馈类别）
 *   refineOnly      (可选) true = 仅返回 AI 整理结果，不落库（贴纸逐段整理用）
 *   test            (可选) true = 仅测试 DeepSeek 连通性，不落库
 *   apiKeyOverride  (可选) 测试连接时临时传入的 Key，不落库
 *
 * Key 解析（双模式）：
 *   users.apiMode === 'own'  且 apiKey  → 用户自己的 Key
 *   users.apiMode === 'dev'  且 devConsent（已同意隐私说明）→ 环境变量 DEEPSEEK_API_KEY
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
6. 原文少于8字或内容无意义时，text 原样返回、type 用 fragment；
7. 从内容中抽取 0-3 个结构化事件 events：type 取 decision=做了什么决定 / goal=想达成什么 / event=发生了什么事 / mood=情绪状态；subject、summary 各不超过50字；没有可抽取的返回空数组。
输出格式：{"text":"整理后文本","type":"decision|reflection|fragment","keywords":["词1","词2"],"events":[{"type":"decision","subject":"主题","summary":"一句话概述","outcome":""}]}`

// AI 反馈（按需，用户主动触发）：四类，一律限 150 字内
const FEEDBACK_SYSTEM = '你是用户的私人思考伙伴。回复用简体中文，语气自然克制，严禁说教。严格遵守字数限制。'
const FEEDBACK_META = {
  digest: '把这段个人记录提炼成 3-5 条要点，每条一行、简洁独立。不新增信息、不评判。总字数不超过150字。直接输出要点列表，不要任何前后缀。',
  challenge: '你是用户的思考陪练。针对这段记录，指出 1-2 个最值得质疑的假设或盲点，并给出简短的反方视角或追问。语气坦诚友善，不居高临下。总字数不超过150字。直接输出内容。',
  action: '从这段记录中提炼最多 3 条可执行的小步骤，每条以动词开头、单步可完成。若确实没有可行动的内容，请诚实说明。总字数不超过150字。直接输出列表。',
  companion: '你是温柔的倾听者。用户刚写下一段心事或碎碎念。先接住情绪（不评判、不建议、不诊断），再以一句关心的开放式问题结尾。总字数不超过150字。直接输出内容。'
}

// 历史上下文：单次反馈最多携带的记录条数（起步期 30，扩量改此处）
const CTX_LIMIT = 30
// 历史记录的软约束（用户指定措辞基调：优先参考而非硬性限定，避免回答僵化）
const CTX_RULE = '以上个人历史记录请作为优先和重点参考的信息，引用处标注 [n]（可在行文中自然带出，如"你之前提到过…[1]"）；描述时间关系时直接采用已标注的相对天数（如"45天前"），不要自行推算或更改年份；找不到依据的，应避免擅自编造。'

function escapeReg(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 检索与当前记录相关的历史上下文（排除自身与回收站），返回编号行与来源。
// 检索输入 = 时间 + 文字：一次轻量 LLM 调用统一抽取关键词与可选时间范围
async function gatherContext(openid, entry, content, apiKey) {
  let kws = []
  let days = 0
  try {
    const hint = (Array.isArray(entry.keywords) ? entry.keywords : []).filter(Boolean).join('、')
    const kc = await callDeepSeek(apiKey,
      '从这段个人记录中抽取用于检索历史记录的关键词（名词优先，2-5个）。' +
      '若内容提到时间限定（如"最近/上周/上个月/今年"），把对应天数写入 days（最近N天），没有时间限定则 days 为 0。' +
      '只输出 json：{"keywords":["词1","词2"],"days":0}' +
      (hint ? '\n\n（记录自带关键词可供参考：' + hint + '）' : '') +
      '\n\n' + content, 120)
    const kd = JSON.parse(kc)
    if (Array.isArray(kd.keywords)) kws = kd.keywords.map(String).filter(Boolean).slice(0, 5)
    if (typeof kd.days === 'number' && kd.days > 0 && kd.days <= 3650) days = Math.round(kd.days)
  } catch (e) { /* 抽取失败则本次无上下文 */ }
  if (!kws.length) return { lines: [], sources: [] }

  const _ = db.command
  const re = db.RegExp({ regexp: kws.map(escapeReg).join('|'), options: 'i' })
  const cond = [
    { _openid: openid, deletedAt: _.exists(false), _id: _.neq(entry._id || '') },
    _.or([{ text: re }, { raw: re }, { keywords: re }])
  ]
  // 有时间限定时按时间窗过滤（如"上个月"→ 近 30 天）
  if (days > 0) cond.push({ createdAt: _.gte(new Date(Date.now() - days * 86400000)) })
  const res = await db.collection('entries').where(_.and(cond)).orderBy('createdAt', 'desc').limit(CTX_LIMIT).get()

  const hits = res.data || []
  const lines = []
  const sources = []
  hits.forEach((e, i) => {
    const snip = String(e.text || e.raw || '').replace(/\s+/g, ' ').slice(0, 200)
    const rel = relLabel(e.dayKey)
    lines.push('[' + (i + 1) + '] ' + (rel ? rel + '（' + e.dayKey + '）' : (e.dayKey || '')) + ' ' + snip)
    sources.push({ id: e._id, dayKey: e.dayKey || '', snippet: snip.slice(0, 60) })
  })
  return { lines, sources }
}

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

// opts.plain = true 时输出纯文本（AI 反馈用），否则 JSON（整理用）
async function callDeepSeek(apiKey, text, maxTokens, systemPrompt, opts) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt || SYSTEM_PROMPT },
      { role: 'user', content: text }
    ],
    max_tokens: maxTokens || 500,
    temperature: (opts && opts.temperature) || 0.3
  }
  if (!(opts && opts.plain)) body.response_format = { type: 'json_object' }
  const res = await postJson(DEEPSEEK_URL, { Authorization: 'Bearer ' + apiKey }, body)
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
const EVENT_TYPES = ['decision', 'goal', 'event', 'mood']
function parseResult(content) {
  try {
    const data = JSON.parse(content)
    const type = ['decision', 'reflection', 'fragment'].indexOf(data.type) >= 0 ? data.type : 'fragment'
    const keywords = Array.isArray(data.keywords) ? data.keywords.slice(0, 3).map(String).filter(Boolean) : []
    const events = Array.isArray(data.events)
      ? data.events.filter((e) => e && typeof e === 'object').map((e) => ({
        type: EVENT_TYPES.indexOf(e.type) >= 0 ? e.type : 'event',
        subject: String(e.subject || '').slice(0, 50),
        summary: String(e.summary || '').slice(0, 50),
        outcome: String(e.outcome || '').slice(0, 50)
      })).filter((e) => e.subject || e.summary).slice(0, 3)
      : []
    const text = typeof data.text === 'string' ? data.text.trim() : ''
    return text ? { text, type, keywords, events } : null
  } catch (e) {
    return null
  }
}

// 东八区日期键：不依赖云函数容器本地时区
function dayKeyOfTs(ts) {
  const d = new Date(ts + 8 * 3600 * 1000)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
}

// 客户端 dayKey 优先，非法时服务端兜底
function resolveDayKey(v, ts) {
  return (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : dayKeyOfTs(ts)
}

// 相对时间（东八区）：把"哪天"换算成"N天前"，避免让 LLM 做年份心算
function relLabel(dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey || '')) return ''
  const n = Math.round((Date.parse(dayKeyOfTs(Date.now())) - Date.parse(dayKey)) / 86400000)
  if (n <= 0) return '今天'
  if (n === 1) return '昨天'
  if (n < 0) return dayKey
  return n + '天前'
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
  const isRefineOnly = !!event.refineOnly
  const override = typeof event.apiKeyOverride === 'string' && event.apiKeyOverride.trim()
    ? event.apiKeyOverride.trim() : null

  // 声音灵感：单段音频 + 标题 + 量化幅度，不经 AI，音频永久保留
  if (event.kind === 'voice') {
    const title = (typeof event.title === 'string' && event.title.trim())
      ? event.title.trim().slice(0, 30) : ''
    const amps = Array.isArray(event.amps)
      ? event.amps.filter((n) => typeof n === 'number' && n >= 0 && n <= 100)
        .map((n) => Math.round(n)).slice(0, 48)
      : []
    const duration = (typeof event.duration === 'number' && event.duration >= 0)
      ? Math.min(Math.round(event.duration), 600) : 0
    const audioFileIDs = Array.isArray(event.audioFileIDs)
      ? event.audioFileIDs.filter((s) => typeof s === 'string' && s.indexOf('cloud://') === 0).slice(0, 20)
      : []

    const now = new Date()
    const dayKeyNow = resolveDayKey(event.dayKey, now.getTime())
    const doc = {
      _openid: OPENID,
      kind: 'voice',
      title: title || dayKeyNow,
      text: '',
      raw: '',
      type: 'fragment',
      keywords: [],
      refined: false,
      amps,
      duration,
      dayKey: dayKeyNow,
      createdAt: now
    }
    if (audioFileIDs.length) doc.audioFileIDs = audioFileIDs
    const addRes = await db.collection('entries').add({ data: doc })
    doc._id = addRes._id
    doc.createdAt = now.toISOString()
    return { entry: doc }
  }

  // AI 反馈：对已有记录按需生成，结果追加保存在记录下（留最近 5 条）
  if (event.feedback) {
    const kind = FEEDBACK_META[event.kind] ? event.kind : null
    if (!kind) return { error: 'bad-kind' }
    const apiKey = await resolveKey(OPENID, null)
    if (!apiKey) return { error: 'no-key' }

    let entry
    try {
      const r = await db.collection('entries').doc(event.entryId).get()
      entry = r.data
    } catch (e) {
      return { error: 'not-found' }
    }
    if (!entry || entry._openid !== OPENID) return { error: 'not-found' }
    const content = (entry.text || entry.raw || '').trim()
    if (!content) return { error: 'empty' }

    // 历史上下文检索（用户已开启并授权时）
    let ctxLines = []
    let sources = []
    if (event.useCtx) {
      try {
        const ctx = await gatherContext(OPENID, entry, content, apiKey)
        ctxLines = ctx.lines
        sources = ctx.sources
      } catch (e) {
        console.warn('上下文检索失败，按无上下文继续', e.message)
      }
    }

    let text = ''
    try {
      // 让 AI 知道"今天是哪天"与"这句话是哪天说的"；相对天数由代码算好，LLM 不做年份心算
      const entryDay = entry.dayKey || dayKeyOfTs(new Date(entry.createdAt).getTime())
      const entryRel = relLabel(entryDay)
      let prompt = '【任务】' + FEEDBACK_META[kind] +
        '\n\n【当前日期】' + dayKeyOfTs(Date.now()) +
        '\n【用户记录】（记录于 ' + entryDay + (entryRel ? ' · ' + entryRel : '') + '）\n' + content
      if (ctxLines.length) {
        prompt += '\n\n【个人历史记录】\n' + ctxLines.join('\n') + '\n\n' + CTX_RULE
      }
      text = (await callDeepSeek(apiKey, prompt, 400, FEEDBACK_SYSTEM,
        { plain: true, temperature: kind === 'companion' || kind === 'challenge' ? 0.6 : 0.3 })).trim()
    } catch (e) {
      console.error('AI 反馈生成失败', e.message)
      return { error: 'ai-fail' }
    }
    if (!text) return { error: 'ai-empty' }

    const fb = { kind, text: text.slice(0, 400), createdAt: new Date() }
    if (sources.length) fb.sources = sources
    const list = (Array.isArray(entry.feedbacks) ? entry.feedbacks : []).concat(fb).slice(-5)
    try {
      await db.collection('entries').doc(event.entryId).update({ data: { feedbacks: list } })
    } catch (e) {
      return { error: 'save-fail' }
    }
    return { ok: true, feedbacks: list }
  }

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

  // 仅整理：贴纸里的单段语音清理，不落库
  if (isRefineOnly) {
    const apiKey = await resolveKey(OPENID, null)
    if (!apiKey || raw.length < 8) {
      return { text: raw, type: 'fragment', keywords: [], refined: false }
    }
    try {
      const content = await callDeepSeek(apiKey, raw, 500)
      const parsed = parseResult(content)
      return parsed || { text: raw, type: 'fragment', keywords: [], refined: false }
    } catch (e) {
      console.error('refineOnly 整理失败，返回原文', e.message)
      return { text: raw, type: 'fragment', keywords: [], refined: false }
    }
  }

  // 默认结果：降级为原文
  let result = { text: raw, type: 'fragment', keywords: [], refined: false }

  const apiKey = await resolveKey(OPENID, null)
  if (apiKey && raw.length >= 8) {
    try {
      const content = await callDeepSeek(apiKey, raw, 700)
      const parsed = parseResult(content)
      if (parsed && parsed.text) {
        result = Object.assign({}, parsed, { refined: true })
      }
    } catch (e) {
      console.error('DeepSeek 调用失败，降级保存原文', e.message)
    }
  }

  // 「保留原声」：校验并截取云文件 ID（最多 20 段，防止异常数据）
  const audioFileIDs = Array.isArray(event.audioFileIDs)
    ? event.audioFileIDs.filter((s) => typeof s === 'string' && s.indexOf('cloud://') === 0).slice(0, 20)
    : []

  // 落库
  const now = new Date()
  const doc = {
    _openid: OPENID,
    raw,
    text: result.text || raw,
    type: result.type,
    keywords: result.keywords || [],
    refined: result.refined,
    dayKey: resolveDayKey(event.dayKey, now.getTime()),
    createdAt: now
  }
  if (result.events && result.events.length) doc.events = result.events
  if (audioFileIDs.length) doc.audioFileIDs = audioFileIDs
  const addRes = await db.collection('entries').add({ data: doc })
  doc._id = addRes._id
  doc.createdAt = now.toISOString()
  return { entry: doc }
}
