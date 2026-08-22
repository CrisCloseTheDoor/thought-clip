// 记录类型元信息（AI 分类结果）
const TYPE_META = {
  decision: { label: '决策', color: '#E8B44B' },
  reflection: { label: '反思', color: '#4FD1C5' },
  fragment: { label: '碎片', color: '#8A8F99' }
}

function typeMeta(type) {
  return TYPE_META[type] || TYPE_META.fragment
}

module.exports = { TYPE_META, typeMeta }
