/**
 * saveEntry —— AI 整理并保存一条记录
 *
 * 入参：
 *   raw             文本（必填，除非 test / kind=voice）
 *   dayKey          (可选) 客户端本地日期 yyyy-MM-dd。优先使用，避免云函数
 *                   容器时区不确定导致凌晨记录归错日期；缺省/非法时服务端
 *                   按东八区显式计算兜底
 *   audioFileIDs    (可选) 「保留原声」开启时的录音云文件 ID 数组，随记录落库
 *   kind            (可选) 'voice' = 声音灵感；'monthlyReview' = 思维模式月复盘
 *   feedback        (可选) true = 对已有记录按需生成 AI 反馈（kind 为反馈类别）
 *   followUp        (可选) true = feedback 的追问轮（threadKind 为所属对话串类别）
 *   formatOnly      (可选) true = 仅对已有记录做 AI 分段排版，返回排版后全文不落库
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

// 清理 AI 回复中可能导致渲染异常的字符（emoji、替换字符等）
function sanitizeAiText(s) {
  return String(s || '')
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '') // emoji（代理对）
    .replace(/\uFFFD/g, '') // Unicode 替换字符
}

const SYSTEM_PROMPT = `你是用户的个人记录整理助手。将口语化、带叠词和语气词的语音转写文本整理成简洁中文笔记，请严格输出 json。规则：
1. 只删除无意义的填充词（嗯/啊/呃/然后然后/就是就是这类纯语气助词和无意义重复），不做文明化改写；
2. 保留说话人的原始语气和情绪强度——粗话、感叹、吐槽是情绪表达的一部分，原样保留，不替换为礼貌用语；
3. 保持原意与关键细节，不新增不臆测；
4. 保留第一人称和日常语气，不过度书面化；
5. 分类 type：decision=做了决定或选择；reflection=思考/复盘/观点/情绪；fragment=日常记录/随想/待办；
6. 提取最多3个关键词 keywords；
7. 从内容中抽取 0-3 个结构化事件 events：type 取 decision=做了什么决定 / goal=想达成什么 / event=发生了什么事 / mood=情绪状态；subject、summary 各不超过50字；没有可抽取的返回空数组。
输出格式：{"text":"整理后文本","type":"decision|reflection|fragment","keywords":["词1","词2"],"events":[{"type":"decision","subject":"主题","summary":"一句话概述","outcome":""}]}`

// AI 反馈（按需，用户主动触发）：四类，一律限 150 字内
const FEEDBACK_SYSTEM = '你是用户的私人思考伙伴。回复用简体中文，语气自然克制，严禁说教。严格遵守字数限制。不要使用任何 Markdown 格式符号（如 **加粗**、# 标题、- 列表等），不要使用 emoji 或特殊 Unicode 符号，直接输出纯文本段落。'
const FEEDBACK_META = {
  digest: '把这段个人记录提炼成 3-5 条要点，每条一行、简洁独立。不新增信息、不评判。总字数不超过250字（不必凑满）。直接输出要点列表，不要任何前后缀。',
  challenge: '你是用户的思维框架分析伙伴。任务分两步：\n1. **框架识别**：从这段记录中识别用户可能的思维框架（如因果假设、评价标准、默认前提等）。有历史记录可对照时，指出反复出现的模式；没有历史可对照时，只说"可能"，不硬归类。\n2. **框架撬动**：用一个经典、有名且情境合适的思维工具或理论（如沉没成本、机会成本、第二序思维、基本归因错误、博弈论中的承诺机制、系统思维中的存量流量等），撬动框架外的解法或视角。\n\n要求：\n- 语气是温暖的观察者，不是批评者（"注意到一个模式"而非"你又犯了"）\n- 引用原理时用【原理】原理名：一句话解释 的格式\n- 不要给回复加小标题或分段标题（如 **框架分析**），直接呈现正文内容\n- 以一个框架外的开放性问题收尾\n- 总字数不超过800字（不必凑满）\n直接输出内容。',
  action: '从这段记录中提炼最多 3 条可执行的小步骤，每条以动词开头、单步可完成。若确实没有可行动的内容，请诚实说明。总字数不超过250字（不必凑满）。直接输出列表。',
  companion: '你是温柔的倾听者。用户刚写下一段心事或碎碎念。先接住情绪（不评判、不建议、不诊断），再以一句关心的开放式问题结尾。总字数不超过250字（不必凑满）。直接输出内容。'
}

// 追问轮的系统提示：思维框架类允许根据内容灵活切换（严肃分析 ↔ 轻松回应）
const FRAMEWORK_FOLLOWUP_SYSTEM = '你是用户的思维框架分析伙伴。延续此前的对话。注意：用户追问的内容如果是轻松闲聊、简单事实性问题或情感表达，请自然回应即可，不必每次都进行框架分析；只有当用户明确在讨论问题、决策或思维方式时，才继续运用经典理论撬动框架外视角。语气始终温暖。回复不超过800字（不必凑满）。'

// 历史上下文：单次反馈最多携带的记录条数（起步期 30，扩量改此处）
const CTX_LIMIT = 30
// 追问对话摘要的总预算（字符）：过渡方案——每条贴纸最多携带最近 2 组问答，
// 超出预算的静默省略。将来升级为知识库/知识图谱组织方式后移除
const CTX_DIALOG_CHARS = 1200
// 历史记录的软约束（用户指定措辞基调：优先参考而非硬性限定，避免回答僵化）
const CTX_RULE = '以上个人历史记录请作为优先和重点参考的信息，引用处标注 [n]（可在行文中自然带出，如"你之前提到过…[1]"）；描述时间关系时直接采用已标注的相对天数（如"45天前"），不要自行推算或更改年份；找不到依据的，应避免擅自编造。标注「追问对话」的内容是该贴纸此前的问答往来，同样可参考与引用（引用其所属贴纸的 [n]）。'

// AI 排版：只分段、不改写内容
const FORMAT_SYSTEM = '你是文本排版助手。任务：把用户给的文本划分成自然的段落。规则：1、只在语义合适的位置插入换行符分段，绝不增删改写任何文字与标点；2、按话题/步骤/时间等自然边界分段，每段2-5句为宜；3、直接输出排版后的全文，不要任何解释、前后缀或编号。'

// 思维模式月复盘：扫描复盘周期内的记录，识别反复出现的思维模式
const MONTHLY_REVIEW_SYSTEM = '你是用户的思维模式观察者。基于用户在指定时间段内的个人记录，写一份简短温暖的"思维模式月复盘"。要求：\n1. 识别 2-3 个反复出现的思维模式（如决策倾向、情绪触发、归因习惯），用"注意到"的语气描述，不评判；\n2. 每个模式引用具体的记录日期和内容片段作支撑；\n3. 如有框架类的经典概念可以命名（如【沉没成本】【基本归因错误】），帮助用户获得思维工具；\n4. 以一句温暖的鼓励或开放式问题收尾。\n5. 总字数不超过400字。\n直接输出复盘内容，不要标题。'

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
    { _openid: openid, deletedAt: _.exists(false), hidden: _.neq(true), _id: _.neq(entry._id || '') },
    _.or([{ text: re }, { raw: re }, { keywords: re }])
  ]
  // 有时间限定时按时间窗过滤（如"上个月"→ 近 30 天）
  if (days > 0) cond.push({ createdAt: _.gte(new Date(Date.now() - days * 86400000)) })
  const res = await db.collection('entries').where(_.and(cond)).orderBy('createdAt', 'desc').limit(CTX_LIMIT).get()

  const hits = res.data || []
  const lines = []
  const sources = []
  let dialogBudget = CTX_DIALOG_CHARS
  hits.forEach((e, i) => {
    const snip = String(e.text || e.raw || '').replace(/\s+/g, ' ').slice(0, 200)
    const rel = relLabel(e.dayKey)
    let line = '[' + (i + 1) + '] ' + (rel ? rel + '（' + e.dayKey + '）' : (e.dayKey || '')) + ' ' + snip

    // 该贴纸若带追问对话，附最近 2 组问答作为附加上下文（引用仍归本条 [n]）
    const fbs = Array.isArray(e.feedbacks) ? e.feedbacks : []
    const qa = []
    fbs.forEach((f, idx) => {
      if (f.kind !== 'user' || !f.text) return
      let a = ''
      for (let j = idx + 1; j < fbs.length; j++) {
        if (fbs[j].kind !== 'user') { a = fbs[j].text || ''; break }
      }
      qa.push({ q: f.text, a })
    })
    const recent = qa.slice(-2)
    if (recent.length && dialogBudget > 0) {
      const parts = []
      recent.forEach((p) => {
        const q = String(p.q || '').replace(/\s+/g, ' ').slice(0, 60)
        const a = String(p.a || '').replace(/\s+/g, ' ').slice(0, 60)
        if (q) parts.push('我追问："' + q + '"' + (a ? '，AI答："' + a + '"' : ''))
      })
      if (parts.length) {
        let tail = '（该贴纸追问对话：' + parts.join('；') + '）'
        if (tail.length > dialogBudget) tail = tail.slice(0, dialogBudget) + '…）'
        line += tail
        dialogBudget -= tail.length
      }
    }

    lines.push(line)
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

// 底层：直接以消息数组调用（多轮对话用）；plain=false 时要求 JSON 输出
async function callDeepSeekMsgs(apiKey, messages, maxTokens, temperature, plain) {
  const body = {
    model: MODEL,
    messages,
    max_tokens: maxTokens || 500,
    temperature: temperature || 0.3
  }
  if (!plain) body.response_format = { type: 'json_object' }
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

// opts.plain = true 时输出纯文本（AI 反馈用），否则 JSON（整理用）
async function callDeepSeek(apiKey, text, maxTokens, systemPrompt, opts) {
  const messages = [
    { role: 'system', content: systemPrompt || SYSTEM_PROMPT },
    { role: 'user', content: text }
  ]
  return callDeepSeekMsgs(apiKey, messages, maxTokens, (opts && opts.temperature) || 0.3, opts && !!opts.plain)
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

// 客户端时间：补传的记录用它落回真实的记录时刻（而非补传时刻）
function clientNow(event) {
  const cts = Number(event.clientCreatedAt)
  return (cts > 0 && cts <= Date.now() + 60000) ? new Date(cts) : new Date()
}

// 幂等返回体：把已存文档包装成与正常保存一致的形状
function dupReturn(doc) {
  return {
    entry: {
      _id: doc._id,
      kind: doc.kind || '',
      raw: doc.raw || '',
      text: doc.text || '',
      type: doc.type,
      keywords: doc.keywords || [],
      refined: doc.refined,
      dayKey: doc.dayKey,
      createdAt: new Date(doc.createdAt).toISOString()
    }
  }
}

// 强幂等：带 clientId 的提交（客户端直存重试 / 离线补传）不限时间窗，永不重复落库
async function findByClientId(openid, clientId) {
  if (!clientId || typeof clientId !== 'string') return null
  const cid = clientId.slice(0, 40)
  const res = await db.collection('entries')
    .where({ _openid: openid, clientId: cid })
    .limit(1)
    .get()
  return (res.data && res.data[0]) || null
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
    const dupDoc = await findByClientId(OPENID, event.clientId)
    if (dupDoc) return dupReturn(dupDoc)
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

    const now = clientNow(event)
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
    if (event.clientId) doc.clientId = String(event.clientId).slice(0, 40)
    const addRes = await db.collection('entries').add({ data: doc })
    doc._id = addRes._id
    doc.createdAt = now.toISOString()
    return { entry: doc }
  }

  // 思维模式月复盘：扫描复盘周期内的记录（不含月复盘自身与回收站），AI 生成模式观察。
  // periodStart 由客户端传入（首次 = 30 天前；后续 = 上次复盘时刻），服务端不猜时间范围
  if (event.kind === 'monthlyReview') {
    const dupDoc = await findByClientId(OPENID, event.clientId)
    if (dupDoc) return dupReturn(dupDoc)
    const apiKey = await resolveKey(OPENID, null)
    if (!apiKey) return { error: 'no-key' }

    const _w = db.command
    const ps = Number(event.periodStart)
    const periodStart = (ps > 0 && ps <= Date.now() + 60000) ? new Date(ps) : new Date(Date.now() - 30 * 86400000)
    const periodRes = await db.collection('entries')
      .where({
        _openid: OPENID,
        deletedAt: _w.exists(false),
        createdAt: _w.gte(periodStart),
        kind: _w.neq('monthlyReview')
      })
      .orderBy('createdAt', 'desc')
      .limit(30)
      .get()
    const periodEntries = periodRes.data || []
    if (!periodEntries.length) return { ok: false, reason: 'no-entries' }

    const lines = periodEntries.map((e) => {
      const rel = relLabel(e.dayKey)
      const snip = String(e.text || e.raw || '').replace(/\s+/g, ' ').slice(0, 120)
      return (rel ? rel + ' ' : '') + snip
    })

    let text = ''
    try {
      text = sanitizeAiText((await callDeepSeekMsgs(apiKey, [
        { role: 'system', content: MONTHLY_REVIEW_SYSTEM },
        { role: 'user', content: '以下是用户在本复盘周期内的全部记录：\n\n' + lines.join('\n') }
      ], 800, 0.5, true)).trim())
    } catch (e) {
      console.error('月复盘生成失败', e.message)
      return { error: 'ai-fail' }
    }
    if (!text) return { error: 'ai-empty' }

    const now = clientNow(event)
    const doc = {
      _openid: OPENID,
      kind: 'monthlyReview',
      title: '思维模式月复盘',
      text: text.slice(0, 600),
      raw: '',
      type: 'fragment',
      keywords: [],
      refined: true,
      dayKey: resolveDayKey(event.dayKey, now.getTime()),
      createdAt: now
    }
    if (event.clientId) doc.clientId = String(event.clientId).slice(0, 40)
    const addRes = await db.collection('entries').add({ data: doc })
    doc._id = addRes._id
    doc.createdAt = now.toISOString()
    return { entry: doc }
  }

  // AI 反馈：对已有记录按需生成，结果追加保存在记录下（留最近 20 轮）
  if (event.feedback) {
    // 追问（followUp）不带类别：它延续已有对话，类别在历史轮里；
    // 仅首轮反馈必须携带合法 kind
    const kind = FEEDBACK_META[event.kind] ? event.kind : null
    if (!kind && !event.followUp) {
      console.error('[feedback] bad-kind:', event.kind, 'followUp:', event.followUp)
      return { error: 'bad-kind' }
    }
    const apiKey = await resolveKey(OPENID, null)
    if (!apiKey) {
      console.error('[feedback] no-key: apiMode 或 Key 未配置')
      return { error: 'no-key' }
    }

    let entry
    try {
      const r = await db.collection('entries').doc(event.entryId).get()
      entry = r.data
    } catch (e) {
      console.error('[feedback] entry not-found:', event.entryId, e.message)
      return { error: 'not-found' }
    }
    if (!entry || entry._openid !== OPENID) {
      console.error('[feedback] entry ownership mismatch')
      return { error: 'not-found' }
    }
    const content = (entry.text || entry.raw || '').trim()
    if (!content) {
      console.error('[feedback] empty content')
      return { error: 'empty' }
    }

    // 多轮追问：用户裸文本延续"threadKind 类别"的唯一对话串。
    // 用户轮归属其前一条 AI 轮的类别（与客户端展示同一规则）；
    // 历史记录上下文沿用本串首次检索的编号行，保证 [n] 编号跨轮一致
    if (event.followUp) {
      const text = (typeof event.text === 'string' ? event.text.trim() : '').slice(0, 500)
      if (!text) return { error: 'empty' }
      const all = Array.isArray(entry.feedbacks) ? entry.feedbacks : []

      let gKind = FEEDBACK_META[event.threadKind] ? event.threadKind : ''
      if (!gKind) {
        const lastAi = all.slice().reverse().find((t) => t.kind && t.kind !== 'user')
        gKind = (lastAi && lastAi.kind) || 'digest'
      }
      const turns = []
      let cur = null
      all.forEach((t) => {
        if (!t) return
        if (t.kind !== 'user') cur = t.kind
        if (t.kind === 'user' ? (cur === gKind) : (t.kind === gKind)) turns.push(t)
      })

      const isFw = gKind === 'challenge'
      // 思维框架类追问：允许根据内容灵活切换（严肃分析 ↔ 轻松回应），其余沿用通用系统
      const sysMsg = isFw ? FRAMEWORK_FOLLOWUP_SYSTEM : FEEDBACK_SYSTEM
      const msgs = [{ role: 'system', content: sysMsg }]
      let lastRole = 'system'
      turns.forEach((t) => {
        if (!t || !t.text) return
        const role = t.kind === 'user' ? 'user' : 'assistant'
        if (role === lastRole) {
          msgs[msgs.length - 1].content += '\n' + t.text
        } else {
          msgs.push({ role, content: t.text })
          lastRole = role
        }
      })

      let final = text + (isFw ? '' : '\n\n（回复不超过250字，不必凑满）')
      const lastAi = turns.slice().reverse().find((t) => t.kind !== 'user' && Array.isArray(t.lines) && t.lines.length)
      if (event.useCtx && lastAi) {
        final = '【个人历史记录】\n' + lastAi.lines.join('\n') + '\n\n' + CTX_RULE + '\n\n【用户追问】\n' + final
      }
      if (msgs[msgs.length - 1].role === 'user') {
        msgs[msgs.length - 1].content += '\n\n' + final
      } else {
        msgs.push({ role: 'user', content: final })
      }

      let reply = ''
      try {
        reply = sanitizeAiText((await callDeepSeekMsgs(apiKey, msgs, isFw ? 1600 : 400, 0.5, true)).trim())
      } catch (e) {
        console.error('追问生成失败', e.message)
        return { error: 'ai-fail' }
      }
      if (!reply) return { error: 'ai-empty' }

      const now = new Date()
      const aiTurn = { kind: gKind, text: reply.slice(0, isFw ? 800 : 400), createdAt: now }
      if (event.useCtx && lastAi && Array.isArray(lastAi.sources) && lastAi.sources.length) {
        aiTurn.sources = lastAi.sources
      }
      const list = all.concat([{ kind: 'user', text, createdAt: now }, aiTurn]).slice(-20)
      try {
        await db.collection('entries').doc(event.entryId).update({ data: { feedbacks: list } })
      } catch (e) {
        return { error: 'save-fail' }
      }
      return { ok: true, feedbacks: list }
    }

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
    const isFwKind = kind === 'challenge'
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
      text = (await callDeepSeek(apiKey, prompt, isFwKind ? 1600 : 400, FEEDBACK_SYSTEM,
        { plain: true, temperature: kind === 'companion' || kind === 'challenge' ? 0.6 : 0.3 })).trim()
      text = sanitizeAiText(text)
    } catch (e) {
      console.error('AI 反馈生成失败', e.message)
      return { error: 'ai-fail' }
    }
    if (!text) return { error: 'ai-empty' }

    const fbMax = isFwKind ? 800 : 400
    const fb = { kind, text: text.slice(0, fbMax), createdAt: new Date(), head: true }
    if (sources.length) fb.sources = sources
    // 编号行全文存档：后续追问直接复用，保证 [n] 引用跨轮一致
    if (ctxLines.length) fb.lines = ctxLines
    const list = (Array.isArray(entry.feedbacks) ? entry.feedbacks : []).concat(fb).slice(-20)
    try {
      await db.collection('entries').doc(event.entryId).update({ data: { feedbacks: list } })
    } catch (e) {
      return { error: 'save-fail' }
    }
    return { ok: true, feedbacks: list }
  }

  // AI 排版：按语义分自然段，只返回排版后全文不落库——用户在编辑态确认后才写回
  if (event.formatOnly) {
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

    let text = ''
    try {
      text = sanitizeAiText((await callDeepSeekMsgs(apiKey, [
        { role: 'system', content: FORMAT_SYSTEM },
        { role: 'user', content }
      ], 1500, 0.2, true)).trim())
    } catch (e) {
      console.error('AI 排版失败', e.message)
      return { error: 'ai-fail' }
    }
    if (!text) return { error: 'ai-empty' }
    return { ok: true, text: text.slice(0, 4000) }
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

  // 强幂等（第一优先）：带 clientId 的提交不限时间窗——弱网超时重试、
  // 数小时后网络恢复才补传的离线记录，均直接返回首次落库的那条，不再重复
  try {
    const dupDoc = await findByClientId(OPENID, event.clientId)
    if (dupDoc) {
      console.log('幂等拦截(clientId)：', event.clientId, '→', dupDoc._id)
      return dupReturn(dupDoc)
    }
  } catch (e) {
    console.warn('clientId 幂等检查失败，继续走同文护栏', e.message)
  }

  // 幂等护栏（第二优先，拦不带 clientId 的直存重试）：
  // 同一天内相同原文的重复提交不重复落库（不限时间——离线补传可能隔数天）。
  // 有意连记同句话跨天不受影响（dayKey 不同自然放行）
  try {
    const _c = db.command
    const dayKeyNow = resolveDayKey(event.dayKey, Date.now())
    const dupRes = await db.collection('entries')
      .where({
        _openid: OPENID,
        raw: raw,
        dayKey: dayKeyNow,
        deletedAt: _c.exists(false)
      })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get()
    const prev = dupRes.data && dupRes.data[0]
    if (prev) {
      console.log('幂等拦截(同天同文)：', prev._id)
      return dupReturn(prev)
    }
  } catch (e) {
    console.warn('幂等检查失败，按正常保存继续', e.message)
  }

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
  const now = clientNow(event)
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
  if (event.clientId) doc.clientId = String(event.clientId).slice(0, 40)
  const addRes = await db.collection('entries').add({ data: doc })
  doc._id = addRes._id
  doc.createdAt = now.toISOString()
  return { entry: doc }
}
