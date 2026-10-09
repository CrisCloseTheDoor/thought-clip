/**
 * Thought Clip 全局配置
 * 部署时请修改：
 *   CLOUD_ENV —— 云开发环境 ID（云开发控制台首页可复制）
 */
module.exports = {
  CLOUD_ENV: 'cloud1-d7gdqyk00e567e1b3',

  // 云函数名（与 cloudfunctions 目录一致）
  CLOUD_FUNCTIONS: {
    SAVE_ENTRY: 'saveEntry',
    ASR: 'asr',
    DAILY_REVIEW: 'dailyReview',
    STATS: 'stats'
  }
}
