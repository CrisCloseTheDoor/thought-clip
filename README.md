# Thought Clip

一个低摩擦的微信小程序记录工具：按住说话、松手即存，AI 帮忙整理成结构化笔记，长期积累成自己的个人 context 资产。

## 功能

- **语音速记**：按住麦克风说话，松手自动保存，单次最长 60s；识别失败可降级为文字输入
- **AI 整理**：DeepSeek 清理语气词、自动分类（决策 / 反思 / 碎片）、抽关键词；也可完全关闭 AI，直接存原文
- **昨日复盘**：打开小程序时，若昨天有记录，顶部展示 AI 提炼的要点（原文记录模式下为统计摘要）
- **历史检索**：按天聚合浏览，可对比原始转写与整理后文本、编辑、删除
- **离线兜底**：断网时记录暂存本地，恢复网络后自动补传



## 界面展示

![界面截图](docs/screenshot.png)

## 技术架构

原生微信小程序 + 微信云开发，三个云函数：

| 云函数 | 职责 |
|--------|------|
| `asr` | 腾讯云语音转文字 |
| `saveEntry` | DeepSeek 整理 + 落库 |
| `dailyReview` | 昨日复盘摘要 |

数据按 openid 隔离，存于你自己的云开发环境（`entries` / `users` 两个集合）。AI Key 有三种模式：使用自己的 DeepSeek Key / 使用开发者提供的 API（需显式同意隐私说明）/ 原文记录（默认）。

## 快速上手

1. 打开小程序，首页即记录页
2. **按住屏幕中央的麦克风按钮说话，松手即自动保存**——不用起标题、不用选文件夹，几秒就记完一条
3. 首次使用默认为「原文记录」模式（直接存原话）。想要 AI 帮忙整理，去「设置 → AI 整理引擎」选一种模式：
   - **使用我的 DeepSeek Key**：填入自己的 Key，记录会自动清理语气词、分类、抽关键词
   - **使用开发者提供的 API**：点「同意隐私说明并启用」即生效，零配置
   - **原文记录**：不开启 AI，最省事、最隐私
4. 识别完成后，记录卡片会显示整理后的文字、类型（决策 / 反思 / 碎片）与关键词
5. 打开小程序时，若昨天有记录，顶部会出现「昨日复盘」卡片，帮你回顾前一天的重要事项
6. 「历史」页按天回看所有记录，可查看原始转写、编辑或删除
7. 断网时记录先暂存本地，恢复网络后自动补传，不用担心丢

> 单条录音最长 60 秒；识别是服务端转写，松手后约 1-3 秒出文字。

## 部署（开发者）

1. 注册微信小程序（个人主体免费）拿到 AppID，开通云开发并创建环境
2. 改 `project.config.json` 的 `appid`、`miniprogram/config.js` 的 `CLOUD_ENV`
3. 云开发控制台建集合 `entries`、`users`，权限设为「仅创建者可读写」
4. 在开发者工具中对 `cloudfunctions/` 下的 `asr`、`saveEntry`、`dailyReview` 分别右键「上传并部署：云端安装依赖」
5. 给 `asr` 云函数配置环境变量 `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`（腾讯云 API 密钥）；`saveEntry` / `dailyReview` 可选填 `DEEPSEEK_API_KEY`（开发者共享 Key）
6. 开发者工具「预览」扫码进入

## 说明

- 腾讯云 ASR 有免费额度（约 5000 次/月），日常使用基本不产生费用
- 昨日复盘为应用内展示，不做订阅消息推送（微信订阅模板标题不可自定义）

## 目录结构

```
thought-clip/
├── project.config.json          # AppID / miniprogramRoot / cloudfunctionRoot
├── miniprogram/
│   ├── app.js / app.json / app.wxss
│   ├── config.js                # 云环境 ID
│   ├── utils/                   # 日期工具 / 类型定义 / 离线队列
│   ├── components/              # mic-button / entry-card
│   └── pages/                   # index / history / detail / settings
└── cloudfunctions/
    ├── asr/                     # 腾讯云 ASR 语音转文字
    ├── saveEntry/               # AI 整理 + 落库
    └── dailyReview/             # 昨日复盘
```
