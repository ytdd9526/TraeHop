# 鬼鬼聚合 × TokenHub 移植方案（网关 + 风格 + 模型列表 + 延迟优化）

状态：待审查 → 待实施 | 起草：2026-10-06

## 0. 目标与范围

1. 把 `D:\项目\TokensAPI`（TokenHub，Go）的 **API 网关全部功能**移植进鬼鬼聚合（Electron/Node），功能零遗漏且体验更好
2. 全应用 UI 换肤为 `https://reverse.apivix.com/` 的终端黑客风（保留现有布局结构，只换视觉层）
3. 新增「模型」列表页：可筛选、可搜索，同时作为 `/v1/models` 的数据源
4. 网关延迟优化：代理开销 <30ms，流式首字节（TTFT）尽量贴近上游生成起点
5. 使用方式不复杂：默认端口自启、面板一键复制接入 URL/Key（Claude Code / Cursor / Cline 即插即用）

> 记忆库约束「本地 API 转换服务已移除、不得恢复」：本方案是**用户 2026-10-06 明确指令**，以移植 TokenHub 完整网关的新形态重建，该旧约束就此作废。

## 1. TokenHub 功能全景（移植基线，零遗漏清单）

### 1.1 HTTP 路由（gateway/server.js）

| 路径 | 方法 | 鉴权 | 功能 |
|---|---|---|---|
| `/v1/chat/completions` | POST | 主人 Key/分享 Key | OpenAI Chat，流式+非流式 |
| `/v1/completions` | POST | 同上 | 复用 openaiChat |
| `/v1/models` | GET | 同上 | 模型列表（含 provider:model 变体） |
| `/v1/messages` | POST | 同上 | Anthropic Messages，流式+非流式 |
| `/v1/messages/count_tokens` | POST | 同上 | token 计数 |
| `/status` | GET | 仅主人 Key | 服务/版本/账号池状态 |
| `/healthz` | GET | 无 | 健康检查 |

鉴权：`Authorization: Bearer <key>` 优先，回退 `x-api-key`；主人 Key 直接放行；分享 Key 解析后写入请求上下文。

### 1.2 模型路由（pool.ResolveModel 语义）

- `provider:model` 前缀解析：`wb`/`codebuddy`→workbuddy，`tr`→trae，`zc`/`glm`→zcode；未知段剥除
- 裸模型名 → `modelRoutes` 映射 → `defaultProvider`（不可用则遍历 enabled）
- `/v1/models`：默认 provider 模型在前，`exposePrefixModels=true` 时追加 `provider:model` 变体

### 1.3 协议转换

OpenAI：流式 chunk（role/content/reasoning_content/tool_calls，role 只发一次，带 usage 的 Finish + `[DONE]`）；非流式聚合出完整 `chat.completion`。
Anthropic：请求侧 system 提取、tools `input_schema→parameters`、`tool_choice`（auto/any/tool）、image base64 → OpenAI `image_url`、tool_result → tool 消息；流式事件 `message_start / content_block_delta(text|thinking|tool_use) / message_delta / message_stop`；非流式输出 content blocks + `usage` + `stop_reason` 映射。

### 1.4 账号池策略

- 候选 = enabled 且未 dead 且未冷却；轮询（rr）；`maxRotate=6`（上限候选×2）
- 请求前按需 Refresh；已写出内容的流不换号；客户端/模型错误不轮换；凭据失效且有 refreshToken 时原地重试
- 冷却表：quota 6h / rate 5min / server 30s / network 15s / captcha 10min / auth 1h；成功即清冷却
- 鬼鬼聚合已有账号结构（id/cookies/token/platform/edition/machineId）→ 新增适配层，不做数据迁移

### 1.5 分享钥匙（shares.js → gateway/shares.js）

`sk-share-` 前缀；按 provider 配置 enabled/limit/models 白名单/usedTokens/usedReqs；每次授权 +1 请求计数并落盘；主人 Key 之外的第二层鉴权，用于隧道公网暴露。

### 1.6 用量日志（usagelog.js → gateway/usagelog.js）

环形 500 条 + 原子落盘（tmp+rename）；字段：time/caller/provider/model/prompt/completion/totalTokens/durationMs/ok/errMsg；面板「用量」区块展示。

### 1.7 供应商（provider-*）

| Provider | Chat 端点 | 关键头 | 备注 |
|---|---|---|---|
| Trae | `POST {agentBase}/api/agent/v3/llm_utils_chat` | Cloud-IDE-JWT + X-Device-* 全族（与现有 trae-api.js 同源） | stream=true、function=solo_work_lite、SSE 事件 output/token_usage/done/error；错误码 1005→quota、401/403→auth、429→rate |
| WorkBuddy | `POST {chatBase}/v2/chat/completions` | Bearer + X-User-Id/X-Enterprise-Id/X-Domain/X-Product | 标准 OpenAI SSE；developer→system |
| ZCode | `POST {apiBase}/api/v1/zcode-plan/anthropic/v1/messages` | Bearer + X-ZCode-* + anthropic-version | AES-GCM 凭据解密（密钥=env 或 SHA256(`zcode-credential-fallback:<platform>:<home>:<username>`)，前缀 `enc:v1:`）；shape 注入；3007/3012→captcha |

鬼鬼聚合现状：Trae/WorkBuddy 账号体系已有（签到/用量/token 刷新全链现成）；**ZCode 账号体系没有**。

### 1.8 其余模块

- 隧道（tunnel）：公网分享——仅转发「API 专用监听端口」（面板/账号永不暴露），bore.pub 实现
- 调度器（scheduler）：自动签到（checkinHours [9,21]）、ZCode 活动领取、额度定期刷新（quotaRefreshSec=300）、token 提前刷新（refreshSkewMin=1440）
- 配置全表：host/port/apiKey/defaultProvider/modelRoutes/providers[].enabled/autoCheckin/checkinHours/wbIntlKeepalive/zCodeAutoClaim/zCodeClaimIntervalMin/zCodeInjectShape/quotaRefreshSec/traeAutoSwitch/refreshSkewMin/maxRotate/upstreamTimeoutSec(600)/connectTimeoutSec(15)/exposePrefixModels

## 2. 架构决策

### 2.1 网关宿主：Electron 主进程内嵌（不独立进程）

理由：直接复用 accountStore（token 刷新/用量/签到互斥锁全部现成）、无进程间数据同步、启停随应用生命周期。Node 主进程跑 HTTP 服务 + SSE 透传是完全成熟模式（事件循环异步 I/O，不阻塞 IPC）。

### 2.2 文件规划（全部新增，不动现有文件逻辑）

```
electron/gateway/
  server.js          # 路由注册 + http.createServer + 鉴权中间件
  pool.js            # 账号池（候选/轮询/冷却/maxRotate）
  sinks-openai.js    # OpenAI 流式/聚合 sink
  sinks-anthropic.js # Anthropic 流式/聚合 sink
  providers/
    trae.js          # 复用 ../trae-api.js 头族与 token
    workbuddy.js     # 复用 ../workbuddy-reader.js 凭据
    zcode.js         # AES-GCM 凭据 + anthropic 上游
  shares.js          # 分享钥匙
  usagelog.js        # 用量日志
  tunnel.js          # 公网隧道
  scheduler.js       # 仅做定时触发：复用现有签到聚合层（8s 错峰+已签跳过+主进程互斥锁），不重写签到逻辑
  config.js          # 网关配置（store key: gatewayConfig）
  http-agent.js      # Node 原生 https.Agent（keepAlive 连接池，专用长超时，零新增依赖）
electron/ipc/gateway.js   # IPC: gateway:get-config/save/status/start/stop
src/renderer/ui/gateway.js # 网关面板页（API 页）
src/renderer/ui/models.js  # 模型列表页
```

**导航定位**：「网关」「模型」做成**独立导航页**（追加导航项），不进设置页区块——避开设置页 i18n nth-child 序号错位风险（历史踩过）。

### 2.3 数据落地

`%APPDATA%/TraeHop/gateway/`：`shares.json`、`usagelog.json`、`config.json`（并入 store 时遵守 store key 规范）。账号数据不复制——账号池实时读 accountStore。

## 3. 延迟优化（3122ms → 目标）

**诚实前提**：非流式 chat 的 2.4~3.1s 耗时 = 上游模型（glm-5.3 级）完整生成时间，物理下限无法压缩。TokenHub 日志实证：`chat 完成 1.2~3.6s`、`stream 完成 16.2s`（长输出）——大头都是生成。**能优化的是代理开销与首字节延迟**：

1. **流式透传零缓冲**：上游 SSE chunk 到达即 `res.write` 并立即 flush；Claude Code/Cursor 全部走流式 → 用户感知 = 上游开始输出的瞬间（TTFT 目标 <1s，之前 TokenHub 非流式要等全量 2-3s）
2. **连接池复用**：Node 原生 `https.Agent({ keepAlive: true, keepAliveMsecs: 60_000, maxSockets: 32 })` per-host——省每次 TCP+TLS 握手 ~150-300ms（Trae 上游 mchost.guru、WB 上游 tencent、zcode.z.ai）；**零新增依赖**（不引 undici，Electron 主进程自带）
3. **启动预热**：网关启动时对上游 base 并发 HEAD/TCP 预连接，首个请求不付握手成本
4. **头族静态化**：设备头/UA 构造一次缓存（TokenHub 每请求重构造 JSON 也有微开销）
5. **不走 fetchT 15s 兜底**：网关上游专用超时（connect 15s / upstream 600s，照抄 TokenHub 语义）——fetchT 15s 会掐死长生成
6. **JSON 零重复解析**：peek(model/stream) 后透传原文，只在 provider 需要改写时才解析（Trae 需改写 body；WB/ZCode 尽量流式透传原 body）

面板耗时展示口径改为「TTFT + 总时长」双指标，用户能看到优化效果。

## 4. 模型列表（新页面 + /v1/models）

- 新增「模型」导航页：数据源 = 各 provider `Models()`（Trae get_detail_param / WB console models / ZCode plans）+ 账号池状态
- 列：模型名（含 provider 前缀徽章）、提供商、可用账号数、今日剩余积分、状态（LIVE/冷却/无账号）
- 筛选：提供商 Tab（全部/Trae/WorkBuddy/ZCode）+ 搜索框（防抖）+ 「仅显示有可用账号」开关
- 操作：复制 `provider:model` 到剪贴板（一行命令接入）；收藏置顶（localStorage）
- `/v1/models` 端点数据与该页同源，模型信息缓存 1h（TokenHub Models() 同款）

## 5. 风格换肤（apivix 终端黑客风）

设计系统（基于 453 行结构快照重建；网络拿不到原始 CSS，色值按终端风标准实现，见 §8 校准步骤）：

| Token | 值 |
|---|---|
| 背景 | `#050807` 近黑 + 微网格背景（CSS 渐变绘制，无图片） |
| 主色 | 荧光青绿 `#22ff88`（链接/高亮/LIVE） |
| 辅色 | 青 `#39d2ff`、警示黄绿 `#b8ff2e`、错误 `#ff4d5e` |
| 文本 | 主 `#c8f5d8`、次 `#5e7a6c`、弱 `#31413a` |
| 字体 | JetBrains Mono（本地 woff2 内置，不联网）+ 中文大标题用系统黑体加粗 |
| 卡片 | 1px 边框 `#1b2e24` + 背景 `#0a0f0c` + 左上角 `◤` 角标 + 无圆角（或 2px） |
| 章节标题 | `// 01 · 名称` 等宽注释风格，主标题带 `⟨ ⟩` 包裹小字副标 |
| 统计数字 | 大号等宽数字 + 标签小字（概览页改造为 LIVE STATS 条） |
| 徽章 | `LIVE` 闪烁点（pulse 动画）、`[ 01 ]` 编号 |
| 动画 | 扫描线（顶部横扫 8s 循环）、卡片 hover 边框荧光、数字滚动、骨架屏 |
| 按钮 | 透明底 + 荧光边框，hover 时填充色反白 |

实施方式：**重写 `src/styles.css` 全量设计变量**，DOM 结构与类名不动（renderer JS 零改动），index.html 仅追加装饰节点（导航徽章、概览统计条结构按快照重建）。i18n 文案补齐新页面 key（zh/en）。字体文件放 `src/assets/fonts/`。

概览页对齐快照结构：顶部品牌语一行（⟨ 账号聚合 · 多平台 · 本地网关 ⟩）→ LIVE STATS 条（账号数/总积分/今日已签/网关状态四个数字卡）→ 章节编号化内容。

## 6. 实施阶段

| 阶段 | 内容 | 交付判定 |
|---|---|---|
| P1 网关核心 | server/auth/pool/sinks(Trae+WB)/IPC/基础面板页 | curl 打通 OpenAI+Anthropic 流式/非流式 |
| P2 完整功能 | shares/usagelog/模型页/调度器接入 | 分享钥匙全链 + 用量日志展示 |
| P3 扩展 | ZCode provider（含凭据解密/登录导入）/隧道 | zcode 账号可 chat |
| P4 换肤 | styles.css 重写 + index.html 装饰 + 字体内置 | 全页面新风格无布局破坏 |
| P5 调优验收 | 连接池/预热/耗时双指标/全回归 | TTFT<1s、代理开销<30ms、全部现有功能回归通过 |

每阶段改前备份 backups/（zip 时间戳），阶段完成跑 `node --check` + `check-modules.cjs` + 重启实测。

## 7. 风险与对策（自审）

| # | 风险 | 对策 |
|---|---|---|
| R1 | 网关上游被 fetchT 15s 兜底掐死 | 网关专用 http-agent，独立超时语义（§3.5），代码评审禁止 import fetchT 到 gateway/ |
| R2 | killTrae（迁移/切换）时网关请求中断 | 迁移本身杀 IDE 不杀网关（网关在鬼鬼聚合进程内）；但目标账号的 chat 会失败一次——客户端自动重试即可接受；`switchTraeAccount` 与 pool 共享账号锁，切换瞬间 pool 该账号短冷却 2min |
| R3 | 端口与 TokenHub.exe 冲突（8687） | 默认端口改 **8690**，启动时 EADDRINUSE 自动 +1 探测（TokenHub 同款逻辑），面板显示实际端口 |
| R4 | ZCode 凭据解密依赖 home/username 派生密钥 | Node `crypto` 1:1 复刻（SHA256 派生 + AES-256-GCM，nonce.tag.body），与 Go 版互通验证后再上 |
| R5 | 频控叠加：网关请求+签到+token 刷新同 IP | 网关只在真实 chat 时打上游；冷却表照抄；签到保持现有 8s 错峰；token 刷新保持昨天的 2.5s 错峰 |
| R6 | 444/「操作过于频繁」影响 chat | chat 错误分类照抄（rate→5min 冷却自动换号），UI 用量页已有 8s 重试兜底 |
| R7 | SSE 透传与 Electron 主进程结构化克隆冲突 | 透传走原生 http 流（string/Buffer），不过 IPC 边界；面板状态查询传普通对象（无 Infinity） |
| R8 | 换肤破坏现有功能定位 | 类名/DOM 不动，仅 CSS 层重写；P4 结束跑全页面回归（账号/迁移/签到/设置逐页点检） |
| R9 | 隧道外部依赖 bore 客户端 | P3 实施前精读 tunnel.go 确认其实现（子代理未覆盖），若依赖外部 CLI 则面板提示安装或降级为「仅局域网」 |
| R10 | 主进程内存增长（SSE 高并发） | 响应流背压（`res.write` 返回 false 时暂停上游读）、body 限 20MB（同 TokenHub）、用量环形 500 条（同 TokenHub） |
| R11 | 非流式耗时无法低于生成时间被误判为"没优化" | 面板耗时双指标（TTFT/总时长）+ 文案注明物理下限，验收口径以 TTFT 与代理开销为准 |
| R12 | 模型列表账号积分为 0 时仍被客户端选中 | pool 候选已过滤 quota 冷却；模型页状态列直接显示冷却原因 |
| R13 | 网关常驻依赖：若鬼鬼聚合从 TRAE 终端树内启动，killTrae 连坐会杀掉网关 | 已有的 findTraeAncestor 自检兜底（拦截迁移/切换）；文档明确：**网关要常驻必须桌面独立启动鬼鬼聚合**，面板检测到 Trae 祖先进程时显示警告横幅 |
| R14 | 绑定 0.0.0.0 时面板/账号数据暴露面 | 默认只绑 127.0.0.1；host 改 0.0.0.0（局域网共享）时面板显示醒目警告 + 强制要求分享钥匙/主人 Key；面板本身不走 HTTP（Electron IPC），永不暴露 |
| R15 | 双重签到：scheduler 定时 + 用户手动 | scheduler 仅定时触发现有签到聚合层（自带"今日已签跳过"+互斥锁），不重写签到逻辑，请求密度不变 |

## 8. 需要你配合的一步（风格精确校准）

本机网络直连不了 reverse.apivix.com（WebFetch 云端代理只有文本快照，CSS 原文拿不到）。你的浏览器能访问——**在该页 Ctrl+S 保存网页（选"网页，全部"）到 `d:\下载\TraeHop\.style-snapshot\`**，我就能逐字节校准色值/字体/动画/间距，把"高度还原"升级成"像素级一致"。不给也能做（按 §5 token 表实现），给了更精确。

## 9. 验收标准

1. TokenHub 路由全表（§1.1）逐个 curl 通过（流式+非流式+错误路径）
2. Claude Code / Cline 分别用 OpenAI/Anthropic 协议接入实测对话成功
3. 分享钥匙：白名单/限额/计数/停用逐项生效
4. 模型页：筛选/搜索/复制可用，与 /v1/models 一致
5. 全 UI 换肤后现有功能（账号/签到/迁移/注册/导入导出/设置）回归无破坏
6. 延迟：代理开销 <30ms（上游耗时 - 端到端耗时）；流式 TTFT <1s；面板双指标可见
7. 迁移/切换/签到与网关并行无死锁；killTrae 期间网关进程存活
