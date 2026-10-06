# 鬼鬼聚合 项目进度文档

> 用途：功能误删后恢复的进度存档。任何模型/账号接手时，先读本文档即可了解项目全貌与当前状态。
> 最后更新：2026-10-06（§8：API 网关移植与渲染层落地）

## 0. 当前状态速览

- 应用形态：Electron 打包目录（根目录 TraeHop.exe），源码位于 `resources/app/`
- 源码加载：**已将旧的 `resources/app.asar` 重命名为 `app.asar.bak-20261004`**，TraeHop.exe 现在直接加载 `resources/app` 目录源码
- 已完成：恢复「自动签到」与「会话迁移」；「国内/国际双版本」改造；**架构重构**（主进程 IPC 模块化、渲染进程按 core/ui 拆分）；**多平台支持**（Trae / WorkBuddy 分组显示、独立签到、WorkBuddy 凭据读取）；**API 转换服务已移除**；**设备标识统一**（stableDeviceId 绑定 machineId）；**渲染性能优化**（asyncPool 并发控制、usage 缓存、RAF 节流、DocumentFragment 批量 DOM 插入）；**API 网关移植**（TokenHub 功能全量移植：OpenAI/Anthropic 双协议、账号池轮询冷却、分享钥匙、用量日志、bore 公网隧道、自动签到调度；渲染层网关面板 + 模型列表页 + 深色霓虹换肤）——见 §8
- 双版本现状：本机装有 TRAE SOLO CN / Trae CN / TRAE SOLO 三个客户端
- 待办：真实环境验证（重启应用后网关面板/模型页实测、chat 流式回归、隧道连通性）

## 1. 功能清单

| 功能 | 状态 | 入口 |
|---|---|---|
| 多账号管理（增删导入导出/备注分组） | ✅ | 账号页 |
| 国内/国际双版本分组显示 | ✅ 本次新增 | 账号页（两组并存时显示分组标题） |
| 从 Trae 导入（按版本） | ✅ 本次改造 | 账号页「从 Trae 导入」（双登录时弹选择框） |
| 手动切换 Trae IDE 会话 | ✅ | 账号卡片「切换」 |
| 重置环境后切换（清理+切换） | ✅ | 账号卡片「重置环境后切换」 |
| 会话迁移（跨账号搬项目+会话） | ✅ 本次恢复 | 账号卡片「迁移会话」 |
| 自动签到（全账号每日积分） | ✅ 本次恢复 | 账号页「一键签到」 |
| 浏览器登录 / 续登 | ✅ | 添加账号 / 续登按钮 |
| 用量查询与历史 / 通知 / 自动备份 | ✅ | 概览 / 设置页 |
| 环境清理 | ✅ | 清理页 |
| 国内版自动注册 | ❌ 按需求不恢复 | — |
| 国际版自动注册 | ✅ 本次恢复 | 账号页「自动注册」对话框 |
| 多平台账号管理（Trae / WorkBuddy） | ✅ 本次新增 | 账号页平台分组 |
| WorkBuddy 签到 | ✅ 本次新增 | 账号卡片「签到」按钮 |
| 本地 API 转换服务 | ❌ 已移除 | — |
| API 网关（OpenAI/Anthropic 兼容） | ✅ 本次新增 | 网关页（`http://127.0.0.1:8690`） |
| 模型列表与筛选 | ✅ 本次新增 | 模型页（搜索/提供商筛选/仅可用） |
| 分享钥匙（临时 API Key） | ✅ 本次新增 | 网关页「分享钥匙」面板 |
| 用量日志 | ✅ 本次新增 | 网关页「用量日志」面板 |
| 公网隧道（bore.pub） | ✅ 本次新增 | 网关页「公网隧道」开关 |
| 自动签到调度（网关侧） | ✅ 本次新增 | 网关设置「自动签到」开关 |

## 2. 架构与文件职责

```
resources/app/
├── electron/                 主进程
│   ├── main.js               入口：窗口/托盘/IPC 注册/启动流程编排
│   ├── preload.js            渲染进程 API 桥（contextBridge）
│   ├── context.js            主进程共享上下文（互斥锁、窗口引用、事件广播）
│   ├── ipc/                  IPC handler 按职责分组
│   │   ├── app.js            应用级 IPC（退出）
│   │   ├── accounts.js       账号增删改查/导入导出/当前账号/设备标识
│   │   ├── checkin.js        签到（全部/单个）
│   │   ├── migrate.js        会话迁移
│   │   ├── register.js       国际版自动注册
│   │   ├── machine.js        设备标识管理
│   │   └── utils.js          IPC 包装工具
│   ├── account-store.js      账号库（electron-store）：增删改查/Token 刷新/导出导入/备份
│   ├── trae-api.js           Trae 云 API：JWT 解析、GetUserToken、用量、用户信息
│   ├── trae-switcher.js      会话切换：写 storage.json 登录信息、machineId、开关/重启 Trae
│   ├── trae-checkin.js       [Trae 签到] API 路由、设备号管理、9074 抗限流、状态记录
│   ├── workbuddy-checkin.js  [WorkBuddy 签到] API 封装与状态解析
│   ├── workbuddy-reader.js   本机 WorkBuddy 凭据探测与解析
│   ├── checkin.js            签到总编排（Trae/WorkBuddy 统一入口）
│   ├── session-migrator.js   [迁移] 总编排：备份→解密→WAL→SQL迁移→重加密→回验→写回→切换
│   ├── sqlcipher-codec.js    [迁移] SQLCipher 页级 AES-256-CBC 解密/加密/WAL 帧校验合并
│   ├── trae-cleaner.js       环境清理
│   ├── browser-login.js      浏览器授权登录窗口
│   ├── edition-config.js     国内版/国际版双版本配置（登录域名/API base/注册模式）
│   └── trae-byte-crypto.js / trae-crypt.js / trae-reader.js / switch-check.js / tray.js 等支撑模块
├── tools/
│   └── trae_migrate_sql.py   [迁移] SQL 引擎（纯标准库 sqlite3，操作明文库）
├── src/
│   ├── index.html            UI 入口
│   ├── styles.css            样式（含平台分组、签到标签、动画）
│   ├── renderer/
│   │   ├── app.js            渲染进程初始化
│   │   ├── core/             核心层（状态、API 桥、国际化、工具）
│   │   │   ├── state.js      全局状态 + 平台常量
│   │   │   ├── api.js        API 桥包装
│   │   │   ├── i18n.js       中英翻译（selector 映射 + data-i18n）
│   │   │   └── utils.js      通用工具（asyncPool、RAF 节流、缓存）
│   │   └── ui/               视图层
│   │       ├── accounts.js   账号列表渲染/过滤/排序/用量加载
│   │       ├── overview.js   概览页
│   │       ├── settings.js   设置页
│   │       ├── checkin.js    签到对话框与流程
│   │       ├── migrate.js    迁移对话框
│   │       ├── add-account.js 添加账号流程
│   │       ├── actions.js    账号操作封装
│   │       ├── events.js     全局事件委托
│   │       └── ...           其他视图模块
│   └── locales/zh.json, en.json
└── package.json              main: electron/main.js；依赖 electron-store
```

## 3. 关键技术点

### 3.1 自动签到（trae-checkin.js）
- API：国内版固定 `api.trae.cn`（v2）；国际版候选探测（status 探测 404 换候选，claim 不探测）
- 请求头：`Authorization: Cloud-IDE-JWT`、`x-device-id`（sha256 派生 16 位数字）、`X-User-Region`
- 版本判定：账号 `region` 字段（CN/空 → 国内版，其余 → 国际版）
- 抗 9074 限流：claim 命中 9074 时**轮换全新设备号**重试一次；多账号 claim 之间错峰 4~6 秒
- 状态持久化：electron-store（traehop-checkin），按日期 key，已签账号当日跳过
- 签到结果 code：0 成功 / 9095 已签 / 9074 限流 / 1001,1002,401,403 鉴权失败→自动续 Token

### 3.2 会话迁移（session-migrator.js + tools/trae_migrate_sql.py）
流程（全自动，逐步日志回传渲染进程）：
1. 读当前登录账号（storage.json）与目标账号，相同则拒绝
2. 关闭 Trae IDE → 备份 `database.db`（+wal/shm）为 `database.db.bak-时间戳`
3. SQLCipher 页级解密（4096B 页 = ct[4016] + iv[16] + hmac[64]，页 1 前 16B 明文 salt）
4. WAL 合并（帧 checksum 校验后应用已提交帧）
5. Python SQL 引擎迁移：project 改挂/转归属 → chat_session/project_id 修整 → local_artifact 改主 → **迁入会话重分配新 session_id**（防服务端 4011）→ 一致性验证（悬空/不一致/残留/原生缺失）
6. 重加密（保留原 salt；hmac key = pbkdf2(key, salt^0x3a, 2, sha512)）→ 解密回验
7. 写回主库、删 wal/shm 与中间文件 → 切换登录目标账号并重启 Trae

前置条件：
- 数据库密钥：`%APPDATA%/TraeHop/dbkey.txt`（64 位 hex），或 settings.dbKey
- 本机 Python 3（引擎仅标准库，无 pip 依赖）
- **迁移前务必正常退出过 Trae 至少一次**（WAL 才完整）；异常时用 `.bak-时间戳` 覆盖回 `database.db` 恢复

### 3.3 IPC 契约
| Channel | 方向 | 说明 |
|---|---|---|
| `checkin:state` / `checkin:run` | 渲染→主 | 状态查询 / 全账号签到（互斥锁） |
| `checkin:log` | 主→渲染 | 签到日志流 |
| `migrate:sessions` | 渲染→主 | 迁移到指定账号（互斥锁），完成后 setCurrentAccount+广播 |
| `migrate:log` | 主→渲染 | 迁移日志流 |

## 4. 本次恢复记录（2026-10-04）

误删背景：账号列表页会话迁移、自动签到两功能的源码被误删（回收站无文件），以下文件经数据库快照逆向恢复并重新集成：

- 恢复：`trae-checkin.js`、`session-migrator.js`、`sqlcipher-codec.js`、`edition-config.js`、`tools/trae_migrate_sql.py`
- 接口补齐：`trae-switcher.js` 导出遗漏的 `killTrae`；`trae-checkin.js` 的版本判定改由 `region` 推导（原 `account.edition` 字段不存在）
- 集成：main.js（4 个 IPC + 互斥锁）、preload.js（5 个 API）、index.html（签到按钮 + 迁移按钮 + 2 对话框）、renderer.js（卡片迁移按钮 + 对话框流程 + 运行中禁关）、i18n.js + zh/en 文案、styles.css（.dialog-log）
- 校验：9 个 JS 文件 node --check 通过；zh/en.json JSON 合法；trae_migrate_sql.py ast 解析通过；Python 与 Node 字段契约（ok/native/migrated/mapping/artifacts/sessions）核对一致
- asar 处理：`resources/app.asar`（6 月旧版，不含上述功能）→ `app.asar.bak-20261004`

### 4.1 国内 401 / 国际 GetUserToken 401 修复（2026-10-04 深夜）

现象：国内账号「刷新用量」401；国际账号 GetUserToken 401。

实测结论（无凭据探测）：
- `api.trae.cn` 额度接口 v1/v2 均在线，均 401（鉴权层）；国际 `api-sg-central` 仅有 v1（v2 为 404）
- GetUserToken 接口在线，无 cookie 时返回 401 + `ResponseMetadata.Error.Code=20101`（Token invalid）

根因与修复（`trae-api.js`）：
1. **额度/用户信息接口头族升级**：旧代码只带 `Authorization`，2026-10 网关要求完整设备头族（`X-User-Region` / `x-device-id` / `x-device-type` / `x-os-version` / `x-app-version` / UA `Trae/1.107.1`）——与签到链路对齐（AutoCheckin 同构造实测可用）
2. **国内额度切 v2**：`ENTITLEMENT_CANDIDATES` = CN→v2/CN、SG→v1/SG、US→v1/US；body 加 `full_data: true`
3. **响应双格式兼容**：`summarizeEntitlements()` 优先 `user_entitlement_pack_list`（完整数据），fallback `usage_summary`（v2 汇总 total/consumed）
4. **GetUserToken**：Origin/Referer 按 cookie 版本（cn→trae.cn，其余→trae.ai）+ 头族；401 时解析 body 错误码，20101/20102 明确提示「Cookie 已失效或被轮换，请重新浏览器续登」（国际账号 401 的真实原因即 cookie 被轮换）
5. **getUserInfoWithCookies**：cookie 模式去 Authorization 头（空 JWT 会干扰 cookie 鉴权），补头族
6. 删除废弃的 `buildHeaders`；deviceId 用 `sha256(traehop-api:<seed>)` 稳定派生（与签到模块设备号隔离，互不干扰限流状态）

冒烟验证：假 token → "API 返回 401"（业务层）；假 cookie → "GetUserToken 返回 401：Token invalid"（带真实原因）。真实 token 验证需在 TraeHop 点「刷新用量」。

### 4.2 国内/国际双版本改造（2026-10-04 深夜）

背景：用户有 4 个国内账号（纯数字用户名）+ 1 个国际账号（@maxxspace.com）。旧代码硬编码读 `%APPDATA%\Trae`（本机不存在，只有 TRAE SOLO CN / Trae CN / TRAE SOLO），导致「从 Trae 导入」必然报"未找到配置文件"；账号切换/清理/迁移也全部固定国内版目录。

核心机制：
1. **客户端注册表**（`platform-config.js`）：`CLIENTS = { cn: ['TRAE SOLO CN','Trae CN'], intl: ['TRAE SOLO','Trae'] }`，目录名=exe 名；`getPlatformConfig(edition)` 按版本返回完整路径配置；`listPlatformConfigs()` 枚举双版本
2. **版本推导**（`account-store.js` `editionOfAccount()`）：邮箱 `@maxxspace.com` → intl；其余按 `region`（非 CN 即 intl）；账号 brief 新增 `edition` 字段
3. **多客户端当前态**：`getTraeActiveUserIds()` 扫双版本 storage.json 收集所有已登录 userId（Set）；`syncCurrentFromTrae()` 返回 `traeUserIds` 集合，`isCurrent` 支持两版本同时高亮不同账号
4. **分版本导入**：IPC `accounts:list-trae-sessions`（探测双版本登录）+ `accounts:import-from-trae(edition)`；渲染层策略——单版本已登录直接导入，双版本均登录弹 `#edition-pick-dialog` 选择，均未登录提示"请先在对应客户端登录"
5. **切换/清理/迁移全链路版本路由**：
   - `trae-switcher.js`：`switchTraeAccount` 由 `editionOfAccount(account)` 推导目标版本 → `killTrae`/`getTraeDataPath`/`openTrae`/`scanTraePath` 全部按版本（进程名按 `TRAE SOLO CN.exe` 等，不再硬编码 `Trae.exe`）
   - `trae-cleaner.js`：`TraeCleaner(onLog, edition)`；`clean-and-switch` 按目标账号版本清理（**修复切国际账号误清国内版环境的严重错误**）
   - `session-migrator.js`：迁移限定同版本（源会话、数据库路径、进程关闭均按目标账号 edition），跨版本客户端互不干扰
   - `main.js` storage watcher 同时监听双版本 storage.json（任一客户端登录变更都会刷新）
6. **分组渲染**（`renderer.js`）：cn/intl 两组并存时显示分组标题（国内版 N / 国际版 N）；单组平铺。国际账号卡片带「国际版」tag

涉及文件：platform-config.js / trae-reader.js / account-store.js / trae-switcher.js / main.js / preload.js / session-migrator.js / switch-check.js / trae-cleaner.js / renderer.js / index.html / styles.css / zh.json / en.json（14 个文件，node --check 全过）

本机实测：TRAE SOLO CN 有 dGMF 加密登录（userId UID_MAIN 可解密）；TRAE SOLO 未登录（storage 无 auth 键）→ 导入时自动只导入国内版，选择框在双登录时才出现。

### 4.3 edition 持久化 + 用量版本路由 + 国际版自动注册（2026-10-05）

现象：刷新用量不区分版本——国内账号显示 0/0，国际账号报 GetUserToken 401；全部账号被分到「国际版」分组。

根因：历史账号 `region` 字段全部为 SG（GetUserInfo 不返回 region 时的默认值），版本判定只看 region → 国内账号被判国际版，用量请求打到国际集群返回空数据；分组渲染同样错乱。

修复一：**edition 字段持久化**（`account-store.js`）
1. `editionOfAccount()`：账号持久化 `edition`（intl/cn）优先；无则邮箱 `@maxxspace.com` → intl、`用户\d+`/纯数字名 → cn、region 兜底
2. `migrateAccountEditions()`：启动时一次性纠正历史账号——写入推导出的 `edition`，cn 账号 `region` 强制 `CN`（模块级 `editionMigrationDone` 防重入）
3. `buildAccountFromItem` / `applyItemToAccount` / `addAccountByToken` 均保存 `edition`；注册/导入新账号天然带版本；`toBrief` 返回 edition 供分组渲染
4. 签到 `trae-checkin.js editionOf()` 同步改为 edition 优先

修复二：**刷新用量按版本路由 API 基站**（`trae-api.js` + `account-store.js`）
- 新增 `entitlementCandidatesFor(edition)`：cn → 仅 `api.trae.cn` v2；intl → 仅 SG/US v1；不传 → 全列表（`validateToken` 添加账号时版本未知，保持探测）
- `fetchEntitlements(token, edition)` / `getUsageSummary(token, edition)` 加第二参数；`account-store.getAccountUsage` 传 `editionOfAccount(account)`，401 重刷后二次调用同样带版本
- 国际账号 GetUserToken 401（code 20101）= cookie 被服务端轮换失效，属业务失效非 bug——提示语已明确引导浏览器续登

修复三：**国际版自动注册恢复**（快照逆向找回）
- 文件：`trae-register.js`（注册编排：独立 session 分区隔离 Cookie/指纹 + 可见窗口 + 错峰注册 worker 池）、`ide-oauth.js`（IDE 同源 OAuth 拿 Token）、`temp-mail.js`（临时邮箱验证码）、`sms-provider.js`（短信备用）
- 链路：注册窗口填邮箱 → 验证码 → 落地登录 → `acquireTokenByIdeOAuth` 拿 Token → `addAccountByToken(token, {edition:'intl'})` 入库；失败回退 Cookie 直刷 + 站点 Token 截获
- IPC：`register:run`（`registerRunning` 互斥锁，total≤20 并发≤3，pace steady/fast）+ `register:cancel` + `register:log` 推送；preload 暴露 `runRegister/cancelRegister/onRegisterLog`
- UI：账号页「自动注册」按钮 + `#register-dialog`（数量/并发/节奏/礼包/代理），renderer 运行中禁关 + 完成刷新列表；zh/en `registerDialog.*` 文案
- 返回契约：`{ success, fail, total, pending, cancelled }`（注意字段名是 success/fail）

签到核查结论（多账号双版本，代码层确认无缺口）：`runCheckinAll` 顺序遍历全部账号，claim 后错峰（CLAIM_GAP_MS+随机）；`CHECKIN_CANDIDATES` cn=api.trae.cn v2 / intl=ug-normal+grow-normal.trae.ai v1+v2；status 探测 404 换候选；auth fail 自动 `ensureValidToken` 刷新一次重试；9074 换新设备号立即重试；当日已签（checked/already）跳过。

校验：11 个 JS `node --check` 通过，zh/en.json 合法；备份 `backups/traehop-20261004-235818.zip`。

### 4.4 用量 0/0 + GetUserToken 401 + 版本误判三连修复（2026-10-05）

用户反馈：66216348831 实际有 2000+ 积分但显示 0/0「用量已满」且被分到国际组；92eewfz5 刷新用量仍报 GetUserToken 401；签到汇总「成功2·已签2」与账号总数对不上。参照物：原版 traehop（github.com/kivenZhou/traehop）国际版显示正常 + 用户 AutoCheckin 项目（trae_credit_monitor.py 实测可用）。

根因与修复：

1. **积分解析优先级颠倒**（`trae-api.js summarizeEntitlements`）——国内 v2 响应的签到积分在顶层 `usage_summary.total_amount/consumed_amount`（AutoCheckin 只读这两个字段），`user_entitlement_pack_list` 只有套餐额度；原实现 pack_list 优先把积分解析成 0/0。**改为 usage_summary 优先**（有 total_amount 即采用，pack_list 仅补明细字段），pack_list 兜底（国际 v1 无 usage_summary，原版路径不受影响）。
2. **GetUserToken/GetUserInfo 带 IDE 设备头族被拒**（`trae-api.js`）——`/cloudide/api/v3/*` 是 web 会话端点，原版用浏览器头（Chrome/120 UA + Origin/Referer，无 X-User-Region/x-device-*）实测正常；我们昨天误加 IDE 头族（UA Trae/1.107.1 + 设备头）导致国际 cookie 报 401 "The user is not logged in"。**新增 `browserHeaders()`/`originForBase()`**：GetUserToken + GetUserInfoWithToken/Cookies 全部回归浏览器头（Origin 按基站 trae.cn/trae.ai）；**IDE 头族（`apiHeaders`）仅保留给 `/trae/api/*` 端点**（entitlement/签到——AutoCheckin 实测该族对 api.trae.cn v2 可用）。
3. **版本判定身份规则优先**（`account-store.js editionOfAccount` + `trae-checkin.js editionOf`）——edition-pick 点错/已存在旧记录都会污染持久化 edition 字段（66216348831 从国际客户端导入被标 intl）。**判定顺序改为：@maxxspace.com 邮箱→intl、纯数字/`用户\d+`名→cn 优先，edition 字段与 region 降为兜底**；启动迁移（migrateAccountEditions）按新规则自动纠正历史记录（66216348831 的 edition 重写为 cn、region=CN）。
4. **签到 early-fail 静默丢账号**（`trae-checkin.js checkinAccount`）——getAccount 失败/无 token/ensureValidToken 失败三个 early return 原先不 recordResult，账号在汇总里凭空消失（用户 5 个账号只见 4 条记录）。已补 recordResult + onLog。

数据链路验证（代码层）：66216348831（纯数字名）→ editionOfAccount=cn → getUsageSummary(token,'cn') → api.trae.cn v2 → usage_summary 优先 → displayUsed/Limit=真实积分；92eewfz5（@maxxspace.com）→ intl → SG/US v1（原版同路径）；签到 probeStatus(editionOf) → 对应集群。渲染层分组/「用量已满」tag 均消费 toBrief.edition 与 summary.displayLeft/exhausted，无需改动。

校验：3 个改动 JS `node --check` 通过；备份 `backups/traehop-20261005-000717.zip`。

### 4.5 注册验证码收不到修复：temp-mail 重写为 mail.tm（2026-10-05）

用户反馈：注册获取不到验证码；礼包是否自动领取；注册速度慢。

根因：**恢复的 `temp-mail.js` 是 mail.cx 旧版，与 `trae-register.js` 的调用契约错位**。trae-register.js 本就是为 mail.tm 写的（582 行注释"mail.tm 免费服务偶发抖动"、轮询传 `onDebug` 且消费 `m.subject`/`m.body`、start() 失败需抛错触发 3 次递增重试），而 mail.cx 版没有 onDebug、start() 静默降级、端点 `api.mail.cx/api/v1` 实测已 404——三重失效导致 90 秒收不到码超时。

修复（`temp-mail.js` 重写为 mail.tm）：
- 端点 `https://api.mail.tm`：GET /domains → 随机域名建账户（POST /accounts）→ POST /token 拿 Bearer → 轮询 GET /messages → GET /messages/{id} 读正文
- 契约对齐：start() 失败抛错（外层重试生效）、getEmail()、pollVerificationCode 支持 onDebug({subject, body})（注册日志转储邮件原文）
- **响应双格式兼容 listOf()**：domains/messages 实测为纯数组（新），旧 JSON-LD 是 `hydra:member`——只认后者会"无可用邮箱域名"
- 验证码提取：subject 优先 → 正文 6 位数字（HTML 剥标签）→ 字母数字混合 6 位兜底（**exec 全量扫描**，须同时含字母+数字；match 单次命中会被 VERIFY 等纯字母单词抢占后整体漏码）；轮询遍历收件箱全部未读消息（不只第一条）
- 实测：mail.tm domains 返回唯一域名 `maxxspace.com`（用户国际账号同源域名，证实原版注册链路）；端到端冒烟「邮箱创建 + 收件箱查询」通过

礼包与速度：
- 礼包领取 `claimAnniversaryGift` 已存在（注册成功→站点登录→勾选时自动开礼包页定位点击，日志「🎁 周年礼包已领取」），对话框复选框改为**默认勾选**
- 错峰节奏默认值 steady(30-90s) 改为 **fast(8-20s)**；单账号防风控节奏（模拟浏览/人性化输入/滑块人工兜底）保留——等码时长由邮件到达速度主导（mail.tm 正常 10-30s），总时长约 1.5-2 分钟/账号

校验：`node --check` 通过，extractCode 四组单测全过（6 位数字/混合码/纯字母拒绝/正文标签剥离）；备份 `backups/traehop-20261005-083907.zip`。

### 4.6 站点登录域名风控（domain at risk）绕过（2026-10-05）

用户反馈：注册后站点登录被拦——"sorry, the mailbox domain you are using is at risk. You can sign in with Google or GitHub, or change to other stable mailbox domains."

背景：trae.ai 把 mail.tm 的 maxxspace.com 域名标记为风险域名，拦截**网页登录表单**。探测结论：mail.gw / tempmail.lol / guerrillamail / maildrop / 1secmail 在本机网络全部不可达（fetch failed，被墙），无"稳定域名"临时邮箱可换——换域名路线走不通。

关键事实：风控拦截的是 `passport/web` 登录表单提交；账号注册（sign-up+验证码）成功、登录态 Cookie 已落地；IDE 授权链路（GetPCAuthCode 签发→回调 AuthCode→ExchangeToken）不走登录表单，且同域名的存量账号 92eewfz5 在 IDE 正常使用——**IDE 授权不查这个标记**。

原有 bug：`siteLogin` 在 `registerIntlFlow` 内部，风控文案（"at risk"）不含 `invalid|wrong|error|fail` 检测词，24 秒超时后抛错直接炸掉整个流程——**registerOne 的 IDE OAuth 回退链路根本执行不到，已注册成功的账号被浪费**。

修复（`trae-register.js`）：
1. `acquireTokenByIdeOAuth` 授权页轮询：新增 at-risk 风控检测，命中快速失败（不干等 110 秒回调超时），回退 Cookie 直刷
2. ~~siteLogin 改尽力而为 + at-risk 文案检测~~ → **2026-10-05 二次实测推翻，已彻底删除 siteLogin（函数+调用）**：
   - 用户实测"还是弹 at-risk"→ 预检方案失败：trae.ai 登录页对已登录用户**不会自动跳转**，照样渲染表单，填完提交必撞风控
   - 根本结论：注册即登录（`waitForLoginLanded` 已确认 sessionid 等 Cookie 落在 trae.ai 域），登录页/授权页/礼包页与注册页**同域**（www.trae.ai），Cookie 通用——站点登录表单是快照原版遗留的冗余步骤，注册后执行纯属自撞风控
   - 现流程：注册成功 → （勾选时）直接 loadURL(礼包页) 用已有登录态点 Claim → IDE 授权。注册窗口不再打开登录页，登录环节的 at-risk 弹窗彻底消失
   - 礼包领取为尽力而为，失败只打日志不阻断

残留风险：若授权页（/authorization）也弹 at-risk（登录态未识别时重定向到登录页），日志会记「授权页域名风控拦截」并回退 Cookie 直刷 GetUserToken，账号仍可入库；届时看日志定位。

校验：`node --check` 通过；备份 `backups/traehop-20261005-084729.zip`、`backups/traehop-20261005-085140.zip`、`backups/traehop-20261005-085735.zip`（删除 siteLogin 终版）。

### 4.7 参考项目吸收：资源拦截提速 + guerrillamail 邮箱 + 礼包 API 直调（2026-10-05）

用户反馈：注册浏览器窗口页面加载很慢；并给出两个已实现同功能的参考项目（github.com/Yang-505/Trae-Account-Manager、github.com/kggzs/TraeAccountRegister），源码已下载到 `D:\下载\trae-ref\`，吸收三处关键做法。

**① 注册窗口资源拦截（提速主刀）**——对齐 TraeAccountRegister（Playwright 版 `handle_route`）：
`createRegisterWindow` 的 `onBeforeRequest` 合并拦截：`resourceType ∈ {image, font, media}` 且 URL 非核心域时 `cancel: true`。核心域放行 `trae.ai|trae.cn|captcha|verify|risk|bytedance|volc|snssdk|secsdk|tiktok`（滑块验证码资源不能拦）。第三方统计/字体/图片全砍，页面只剩功能性请求；passport/fired 侦测不受影响（都是 xhr）。多 worker 并行时渲染负载大降，同时缓解主窗口卡顿。

**② temp-mail.js 重构为双供应商**（guerrillamail 优先 → mail.tm 兜底）：
- 4.6 的"guerrillamail 不可达"结论被实测推翻（当时探测方式问题）：`api.guerrillamail.com/ajax.php` 国内直连可用，建号仅 1.2s（mail.tm 通常 5-15s）
- GuerrillaMailProvider：`get_email_address` 拿 sid_token → `set_email_user` 自定义 10 位随机本地名 → `get_email_list`/`fetch_email` 轮询
- **共享地址池陷阱**：新用户名下可能残留旧邮件（实测首建就有 1 条），若含 6 位数字会被误提取成验证码 → start() 尾部拉一次列表记 `baselineIds`，轮询只认会话建立后新到的邮件（冒烟验证 MSGS=0）
- 门面类 `TempMailClient` 契约不变（start 抛错/重试 3 次、getEmail、pollVerificationCode{onDebug}），trae-register.js 零改动；验证码提取逻辑 `extractVerificationCode` 抽成模块级共用
- 域名：默认 `guerrillamailblock.com`（上轮实测该域 + sharklasers.com + grr.la 三个在 trae.ai 发码均不被风控）——规避 maxxspace.com 的 at-risk 标记

**③ 周年礼包 API 直调替代网页点击**——对齐 Trae-Account-Manager（`trae_api.rs claim_birthday_bonus`）：
- 删除 `claimAnniversaryGift`（网页版 loadURL 礼包页+找按钮，慢且依赖页面结构）及 `GIFT_URL`/`JS_LOCATE_GIFT`
- `trae-api.js` 新增 `claimBirthdayBonus(token)`：`POST {api-sg-central|api-us-east}.trae.ai/trae/api/v1/pay/claim_birthday_bonus`，**站点头族**（browserHeaders('https://www.trae.ai')：浏览器 UA+Origin/Referer+`Cloud-IDE-JWT`，与 /trae/api/* 的 IDE 头族分界不同——参考项目实测站点头可调通），空 body
- 调用点挪到 `registerOne`：Token 入库成功后用实际拿到的 token（IDE OAuth → Cookie 直刷 → 站点拦截三条链路统一 `userToken` 变量）直调；400/409（已领/活动结束）视为业务拒绝记日志不报错；仅 intl 版调用

**校验**：`node --check` 三文件通过；残留引用（GIFT_URL/JS_LOCATE_GIFT/claimAnniversaryGift）已清零；冒烟 `PROVIDER=guerrillamail COST=1236ms MSGS=0`；备份 `backups/traehop-20261005-092033.zip`。

### 4.8 授权页 email 参数触发 at-risk 根因修复 + 注册日志落盘（2026-10-05）

用户实测反馈（4.7 改造后重启 TraeHop 跑注册）：注册过程中仍弹 "Sorry, the mailbox domain you are using is at risk. You can **sign in** with Google or GitHub..."，且日志显示"注册成功"后账号列表无新账号。

**诊断过程**（无日志只能逆向前端）：
- 进程启动时间 09:21:51 > 源码修改时间 → 排除"旧代码未生效"，确认跑的是 guerrillamail 新链路
- 裸调 `passport/web/email/send_code` 对四个临时邮箱域名统一返回 1031 "Enter a valid email address"（无会话/签名上下文触不到风控层），无法差分探测
- 抓 trae.ai 注册页前端 bundle（sign-up/page chunk 2929 = `sign-up/page.4e08bfa43c.js`，chunkName/hash 映射在 builder-runtime 的 `b.u` 函数）：注册组件的错误走 `toast.error(e.message)`——**at-risk 文案来自后端响应 message，前端无域名黑名单**；且注册页埋点上报 `trae.signup.duple_account` 带 `p.split("@")[1]`（邮箱域名）
- **文案说 "sign in" 而非 "sign up"** → 弹窗出自**登录组件**而非注册表单 → 注册链路（发码+提交）不拦 guerrillamail 域名（验证码能收到、Cookie 能落地），弹窗在 **IDE 授权页**：`buildAuthorizationUrl` 当时带 `email=注册邮箱` 参数（真实 IDE 客户端不知道用户邮箱、从不带此参数，是注册流程自己塞的），授权页见 email 即渲染登录组件预填邮箱 → 域名风控预检命中 → 弹 at-risk
- 授权页 at-risk 检测命中 → 抛错回退 Cookie 直刷/站点拦截 → 三链路全失败 → **邮箱账号已在 trae.ai 创建，但 TraeHop 无 Token 无法入库**（"注册成功但没账号"的真相）

**修复（三处）**：
1. `ide-oauth.js` `buildAuthorizationUrl` 删除 email 参数 + `trae-register.js` `acquireTokenByIdeOAuth` 签名去 email——授权页不再渲染登录组件，直接吃注册会话的同域 Cookie 登录态，绕开登录组件的域名风控
2. `trae-register.js` `runRegisterBatch` 注册日志落盘 `%APPDATA%/TraeHop/logs/register-{时间戳}.log`（IPC 日志窗口关即失，此前排查全靠用户复述；开头打印落盘路径，落盘失败不影响注册）
3. `renderer.js` 注册结束后无条件 `refreshAccounts()`（原 `success>0` 才刷，失败收尾后列表不刷新）

**校验**：`node --check` 三文件通过；备份 `backups/traehop-20261005-093249.zip`。

**加固（09:33 用户实测反馈后）**：用户重启 TraeHop 点过一次注册，`logs/register-20261005-093334.log` 落地为 **0 字节**——`fs.createWriteStream` 缓冲未 flush 进程即终止（强杀/崩溃），日志全丢。改为 `fs.appendFileSync` 同步追加写（日志频率低、无阻塞风险，进程被强杀已写内容不丢），时间戳由 UTC 改本地时区 `toTimeString().slice(0,8)` 便于与系统时间对照；移除无意义的 `logStream.end()` 收尾。备份 `backups/traehop-20261005-093726.zip`。

待验证：重启 TraeHop 注册 1 个 intl 账号——预期授权页直接显示确认按钮（不再有 at-risk）、日志 `🎉 [...] 已加入账号列表`、列表出现新账号（新账号在「国际版」分组，若当前停留在其他分组请切回查看）；若再失败，直接把 `%APPDATA%/TraeHop/logs/` 最新 register-*.log 内容发来即可精确定位。
另注：上次注册失败那个邮箱账号实际已创建在 trae.ai（只是没入库），日志落盘后可看到具体邮箱。

### 4.9 授权页 trae:// 协议截获 + 游客 sessionid 误判修复 + UI 两项（2026-10-05）

用户实测三份日志（09:33 / 09:38 / 09:42）+ 授权页/协议弹窗截图定位新根因：

**注册链路两个新根因**：
1. **新版授权页改走 trae:// 协议**：已登录态按钮文案变为 "open TRAE and upgrade"（旧版 "Log in and open TRAE"），自动化按旧文案匹配不到按钮只能干等（09:38 日志：打开授权页 35 秒无进展被用户停止）；且点击按钮后页面发起 `trae://` 协议跳转唤起本地 IDE、**不再跳 127.0.0.1:17388 HTTP 回调**，本机无协议处理程序 → Windows 弹"获取打开此'trae'链接的应用"系统对话框，流程彻底死锁（用户截图实证）
2. **游客 sessionid 假阳性**：`waitForLoginLanded` 以 cookie 名（sessionid/sid_guard/passport_auth_status）判定登录成功，但**游客也种 sessionid**——09:33 被 at-risk 拦截的注册（maxxspace.com）被误报"注册成功"，随后 Cookie 直刷 GetUserToken 401 实锤窗口内无登录态

**修复（trae-register.js）**：
1. 授权按钮 pattern 扩展为 `log\s*in\s*and\s*open|open\s*trae`（`AUTH_BUTTON_PATTERN`），兼容新旧文案
2. `acquireTokenByIdeOAuth` 挂 `will-navigate` + `did-start-navigation` + `setWindowOpenHandler` 三路截获 `trae://` 协议（preventDefault 阻断系统弹窗），`extractAuthCodeFromProtocolUrl` 从协议 URL 提取 AuthCode（authCode/authCodeInfo 裸值或 JSON 双格式）直接 ExchangeToken 换 Token；截获的完整 URL 落日志（若格式与预期不符下次可精确定位）；授权超时前输出页面文本快照
3. `waitForLoginLanded` 新增 `verify` 参数：Cookie 命中后窗口内同源直调 GetUserToken 实证，失败则继续轮询；`registerIntlFlow` 传 `verify: true`（cn 手机号流程不变）
4. `registerOne` Token 回退链路新增最优先回退：**注册窗口同源直调**（`fetchUserTokenInPage`：相对路径 fetch `/cloudide/api/v3/common/GetUserToken`，credentials:'include' 自动携带窗口 Cookie，免导出丢字段/域错配）——注册成功但授权协议断链时窗口登录态仍在，此路最稳；cn 站点域若无此端点返回 null 自然落到下环（Cookie 直刷 → captureSiteToken CDP 拦截）

**UI 两项**：
1. 概览页用量历史只显示当前使用账号（`loadUsageHistory` 按 `isCurrent` 账号 id 过滤 `accountId`，不再混入其他账号记录；isCurrent 语义=各版本客户端当前登录账号）
2. 导入按钮版本清晰化：工具栏"导入"→"导入文件"（与"从 Trae 导入"区分：前者=导出的备份文件，后者=扫描本机客户端登录账号，探测到双版本登录时弹 edition-pick 选择）；导入成功 toast 带版本（"已导入{edition}账号 {email}"，zh/en 同步）；工具栏"从 Trae 导入"、添加对话框"从 Trae 导入"tab、"导入当前账号"按钮三入口同流程

**校验**：`node --check` 双 JS 通过、双 locale JSON 合法；备份 `backups/traehop-20261005-095212.zip`。

**mail.tm 供应商移除（同轮）**：09:33 实证 maxxspace.com 注册提交被 at-risk 拦截（mail.tm 唯一活跃域名），其"兜底"= 必败死路（白等 2 分钟+游客 sessionid 误报成功）；`temp-mail.js` 删除 MailTmProvider 与死变量 CHARS_MIXED，单走 guerrillamail（多域名：guerrillamailblock.com/sharklasers/grr.la 等），建号失败由外层 3 次递增重试兜底（09:38 日志实证 guerrillamail 偶发 aborted 后重试成功）。备份 `backups/traehop-20261005-095401.zip`。

**再补三防护（09:42 第三份日志复盘后）**：09:42 批次（旧授权链路代码，协议截获修复 09:54 才完成）日志实证——注册真实成功（`oe5t4bsudb@guerrillamailblock.com`：页面跳转+登录态落地，账号已在 trae.ai 创建），但打开授权页后**零日志静默挂死**（连 110s 超时报错都没打），根因 = Electron `loadURL` 无超时、页面 pending 时永久 await 且无任何诊断线索，Token 未获取故未入库（该账号密码未留档已不可找回）。修复：①`loadURLWithTimeout` 竞速超时（注册页 30s/授权页 20s，超时不再等待继续流程并留日志，load 失败保留原抛错行为）；②注册凭证留档——账号入库后 `🎫 注册凭证：{邮箱} / 密码 {密码}` 落注册日志，断链丢 Token 可人工登录找回；③确认 GuerrillaMailProvider.start() 每次 `set_email_user` 随机新地址，无沿用已注册邮箱风险。备份 `backups/traehop-20261005-095709.zip`。

**工具栏导入按钮按版本拆分（用户二次反馈后）**：用户反馈"导入/从 Trae 导入两个按钮分不清国内版和国际版"——此前只改了文案（"导入文件"）没达意。拆分：`从 Trae 导入`（#btn-import-trae）→ **`导入国内版`（#btn-import-trae-cn）+ `导入国际版`（#btn-import-trae-intl）** 两个版本直达按钮，点击即探测对应版本（cn=TRAE SOLO CN/Trae CN，intl=TRAE SOLO/Trae）的登录账号直接导入，无登录明确提示（importDialog.noSessionCn/noSessionIntl，zh/en 同步）；同版本多客户端并存由主进程 readCurrentTraeToken 处理（原版行为）。i18n 联动：`accounts.importFromTrae` 拆为 `importFromTraeCn/importFromTraeIntl`（i18n.js 映射、zh/en.json 三处），`common.import` 改"导入文件"（文件导入对话框确认按钮同样适用）；renderer 的 setAccountsToolbarBusy 禁用按钮列表同步。添加账号对话框内"从 Trae 导入"tab 与"导入当前账号"保留通用探测+双版本弹窗逻辑不变。备份 `backups/traehop-20261005-100052.zip`。
待验证：重启 TraeHop 注册 1 个 intl 账号——预期日志依次出现 `📱 截获 trae:// 协议跳转：...`、`从 trae:// 协议链接提取到 AuthCode` 或 `🔑 注册窗口同源直调 User Token 成功`、`🎉 [邮箱] 已加入账号列表`；若协议 URL 无 AuthCode（新格式未覆盖），把日志里截获的完整 trae:// URL 发来即可适配。

### 4.10 迁移页数校验误报 + Windows sleep 命令缺失修复（2026-10-05）

用户实测两处报错：
1. **会话迁移中止**：`当前账号 UID_MAIN → 目标账号 UID_TARGET` 流程走到"重加密"后报 `页数不一致 14726 != 14759，中止写回`。根因 = session-migrator.js 用**解密瞬间页数**（14726）与**重加密页数**做严格相等校验，但中间发生了 WAL 合并（应用 625 帧后库增长到 14759 页）与迁移写入（INSERT 会话/产物），页数本来就动态变化——该校验基准取错时点，凡 WAL 有提交帧的库**必然误报**，属设计缺陷非数据损坏（主库未被改动，写回前中止）。修复：删除页数相等校验，仅保留 `n2 < 1` 空输出 sanity；加密库正确性由既有"回验加密库"闭环（decryptDb 回验 + PRAGMA integrity_check + verify 会话数）完整覆盖，页数校验冗余且有害。
2. **切换账号报错**：`Command failed: sleep 0.5 'sleep' 不是内部或外部命令`。根因 = trae-switcher.js 两处 `execSync('sleep ...')`（killTrae 内 1.5s / switchTraeAccount 内 0.5s），Windows 无 sleep 命令直接抛错——switchTraeAccount 那处无 try/catch，storage.json 已写完但等待+自动拉起 IDE 失败，界面报错（实际登录信息已写入，半成功）。修复：新增 `syncSleep(sec)`（`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sec*1000)`，Node 主线程可用），两处替换，mac/win 统一。
3. **迁移日志乱码**：`迁移前 integrity=ok` 显示为 `Ǩ??ǰ integrity=ok`。根因 = Python 子进程 stdout 为管道时按 Windows locale（GBK）编码输出中文，JS 端按 UTF-8 解码。修复：spawn 加 `env: { ...process.env, PYTHONIOENCODING: 'utf-8' }`。

**顺手加固**：
- 迁移失败路径残留清理：旧代码成功路径才删临时文件，失败后明文库（`*.bak-*.plain`，含全部聊天明文）与加密库（`*.enc`）裸留磁盘——本次实测残留 7 个约 327MB。重构为 try/finally：`plain/enc/verify` 三临时文件无论成败统一清理（bak 备份保留）。
- 备份文件名尾点：stamp `slice(0,15)` 把 ISO 串的小数点切进来（`bak-20261005022046.` 尾点 → 子文件名 `..plain` 双点），改 `slice(0,14)`。
- 已清理本机残留：`%APPDATA%\TRAE SOLO CN\ModularData\ai-agent\` 下 7 个 .plain/.enc 临时文件已删除，全部 .bak 备份原样保留。

**校验**：`node --check` 双 JS 通过；备份 `backups/traehop-20261005-102609.zip`。
待验证：重启 TraeHop 重跑 `UID_MAIN → UID_TARGET` 迁移，预期走到"回验加密库 → 写回主库 → 切换并重启 Trae"全链路；切换账号按钮不再报 sleep 错误且自动拉起 IDE。

### 4.11 迁移 UNIQUE 冲突：local_artifact 产物撞约束（2026-10-05）

用户重启 TraeHop 重跑迁移，报 `SQL 引擎异常: Traceback ... do_migrate ... migrate_projects ... sqlite3.IntegrityError: UNIQUE constraint failed: local_artifact.user_id, local_artifact.source_project_id, local_artifact.entry_key`（错误被 runSqlScript 的 `slice(0,300)` 截断，复现拿全）。

**复现**：取本次迁移备份 `database.db.bak-20261005022755` + dbkey 解密（15345 页）+ walApply（264 帧）成明文库，直接跑 `trae_migrate_sql.py migrate` → 完整 traceback 确认炸点在 `UPDATE local_artifact SET user_id = ?`。

**根因（时间线闭环）**：上一轮点"切换账号"虽报 sleep 错，但登录信息**已写入成功**（§4.10 记录的半成功状态）——用户随后打开 Trae，客户端以目标账号 `UID_TARGET` 身份活动，在同一个本地库（全账号共享单库）生成了目标账号自己的 project / 原生会话 1 个 / local_artifact 产物。本次迁移把源账号产物 user_id 改为目标时，撞 `(user_id, source_project_id, entry_key)` 唯一约束——目标账号已有一份同键产物（同项目路径改挂后 source_project_id 相同 + entry_key 相同）。凌晨 02:20 那次没炸是因为当时"目标账号原生会话 0 个"（目标在本地库无任何行），切换发生在那之后。

**修复（trae_migrate_sql.py migrate_projects）**：无条件 UPDATE 改为 `NOT EXISTS` 跳过目标已有同键行，随后 `DELETE FROM local_artifact WHERE user_id = 源` 清掉源冲突行——保留目标现有产物（当前活跃账号写入、与服务器一致的版本），迁移不再炸；art_residue 检查照常通过（源产物清零）。

**复现库实测**：`目标账号原生会话 1 个 → 项目改挂 2 / 转归属 0，本地产物 1 条（1 条冲突按保留目标处理）→ 迁入会话 1 个 → session_id 重分配 → ok:true`；verify 通过（目标共 2 会话，旧 session_id 无残留）。临时复现文件已清理。

**校验**：备份 `backups/traehop-20261005-103049.zip`。
待验证：重启 TraeHop 重跑同一迁移，预期全链路走通并自动切到目标账号；后续若再有"曾切换过目标账号"的迁移场景也不再撞 UNIQUE。

### 4.12 机器码管理：每账号独立设备指纹 + 保会话清除登录（2026-10-05）

参考 [qingshanglei/Trae-Account-Manager2](https://github.com/qingshanglei/Trae-Account-Manager2)（Tauri/Rust，源码 `D:\下载\trae-ref2\`）的 machine.rs 机制移植并强化。用户痛点：**迁移/切换会话导致设备上限**、**重置环境会把会话清掉**。

**参考项目机制**：Trae 机器码 = `%APPDATA%\<客户端目录>\machineid` 文件（纯文本 UUID）+ `storage.json` 的 telemetry 三件套（`telemetry.machineId`=hash(machineid)、`sqmId`、`devDeviceId`）；每账号 Account.machine_id 绑定，切换时写盘。其 clear_trae_login_state 会删 `state.vscdb`（会话库）——这正是"清会话"元凶，本工具不采用。

**根因（设备上限）**：旧 `switchTraeAccount` 里 `account.machineId || generateMachineId()` 生成的机器码**从不回存账号库**——每次切换/迁移同一账号都换新设备指纹，服务端按设备累计，直到超限。

**修复与新增**：
1. `trae-switcher.js`：`switchTraeAccount` 首次生成机器码后经 `setAccountMachineId` 回存（每账号恒定一个设备指纹）；telemetry 逻辑抽 `applyTelemetryIds` 复用；新增 `readMachineInfo(edition)`（读 machineid + telemetry + 登录态，AUTH_KEY 明文/dGMF 加密两种格式都尝试解出邮箱）、`resetMachineId(edition)`（关 IDE → 新 UUID 写盘 + telemetry 三件套）、`clearLoginState(edition)`（关 IDE → storage.json 删 4 个 iCube 登录 key → 清 Cookies/Local Storage/Session Storage/IndexedDB/Local State；**state.vscdb、ModularData、workspaceStorage 一律不动，会话完整保留**）
2. `account-store.js`：`getCurrentMachineIdFromDisk(edition)` 加版本参数（旧版只读国内版目录，国际账号绑错）；`bindMachineId` 按账号 edition 读对应客户端机器码；新增 `setAccountMachineId`
3. IPC：`accounts:get-machine` 改双版本数组（cn+intl 各含 machineId/telemetry/hasLogin/loggedInEmail/installed）；新增 `machine:reset`、`machine:clear-login`（均广播 trae:account-changed）
4. UI：设置页新增「机器码管理」区块（#machine-group，位于 Trae IDE 路径之后）：每版本一行展示 machineid + telemetry.machineId + 已登录账号 + 绑定账号列表，操作有复制/刷新/重置机器码/清除登录状态（原生 confirm 确认）；renderer `loadMachinePanel`/`renderMachineRow`，进入设置页懒加载，语言切换重渲染
5. i18n 陷阱：设置页区块靠 `.settings-group:nth-child(N)` 定位，插入新区块后**隐私/用量监控/通知/自动备份的序号 4-7 全部 +1 修正为 5-8**，新区块用独立 id selector 接入
6. 账号详情对话框「绑定当前设备」随之修复：按账号版本读对应客户端 machineid（此前国际账号会绑到国内客户端的机器码）

**语义说明**：重置机器码=该客户端换全新设备身份（已绑定账号不受影响，切回该账号自动恢复其绑定值）；清除登录状态=登出（Token/Cookie/缓存清空，需重新登录）但会话与机器码保留。已积累设备数的账号需去网页端踢旧设备，修复后不再增长。

**校验**：7 个 JS node --check 通过、zh/en.json 合法；备份 `backups/traehop-20261005-105715.zip`。
待验证：重启 TraeHop → 设置页看机器码面板（国内版/国际版各一行）；切换同一账号两次，第二次面板"绑定账号"应显示该账号（机器码已固定不再变化）；清除登录状态后打开 IDE 应要求重新登录且会话仍在。

### 4.13 intl 注册取 Token 链路重构 + 提交环节四路信号（2026-10-05）

用户实测 intl 自动注册两轮全灭（09:58/10:02 日志），账号不入库。逐环节定位：

**根因一（取 Token 链路顺序颠倒）**：旧顺序 = IDE 授权优先 → 窗口内直调 → Cookie 直刷 → 站点拦截。实测新版授权页点击按钮后发起 `trae://trae.ai-ide?v=3.5.20` 协议跳转（**不带 AuthCode**），IDE 授权成死路；且授权页把注册窗口导航走/触发自关，回退的窗口内直调在 ERR_FAILED(-2) 或 Object has been destroyed 上全灭——Cookie 最新鲜的时刻（注册刚完成、窗口停在已登录站点页）被授权环节白白浪费。

**修复（registerOne 取 Token 链路重排）**：
1. 首选：注册窗口同源直调 `GetUserToken`（窗口此刻仍在已登录站点页，Cookie 最新鲜、免导出丢字段），fetchUserTokenInPage 加 onLog 透出失败原因
2. 回退1：`getUserToken(cookieStr)` Cookie 直刷（多基地探测）
3. 回退2：IDE 授权（旧版 HTTP 回调链路，新版协议跳转无 AuthCode 大概率失败，仅兜底）
4. 回退3：`captureSiteToken(ses)` 重构——**新开隐藏窗口**（同 session 复用登录态）访问 account-setting 拦截站点自发 GetUserToken；不复用注册窗口（授权页残留协议跳转/自关行为会让 loadURL 瞬间 ERR_FAILED，09:58 实证）
5. `exportCookieString(ses)` 改收 session 参数（原来从 win 取，窗口销毁后无处可取）；注册凭证（邮箱/密码）**前移到链路开始前落日志**，全链断掉也可人工找回账号
6. 每环独立 try/catch 且失败原因全部落日志（旧版部分环静默吞错，排查时只见最后一个错误）

**修复（头族兼容）**：注册链路签发的是站点 Token（GetUserToken 直调），配 IDE 设备头族（X-User-Region/x-device-*）可能被拒 401/403。参考 Trae-Account-Manager（站点 Token + 站点头全链路可通，trae_api.rs build_headers 实证）：`trae-api.js fetchEntitlements` 与 `trae-checkin.js postCheckin` 均加 401/403 时浏览器头族重试，防新账号入库 validateToken 就 401 卡死。

**根因二（11:13/11:15 新故障：提交环节盲区）**：用户重启后重测，失败点**前移到 Sign Up 提交**——「注册请求未发出」3 次重试全灭。旧提交循环只监测两路信号（请求确认/URL 跳转），每轮 6s 盲等后换 pickIndex 重试：提交触发的风控滑块、报错横幅、at-risk 弹窗全被无视；重试换 pickIndex 还有误点导航链接风险。当天同 IP 已注册 3+ 账号，风控升级大概率在提交时弹滑块。

**修复（提交循环重写）**：
1. 每次点击后最长 24s **四路信号**并行监测：`fired.emailRegister`（matcher 放宽为 `/passport\/web\/email\/register/i` 防端点改名）/ URL 离开 /sign-up / 滑块出现（JS_DETECT_CAPTCHA，出现即置前窗口等人工 120s，解完继续等请求或跳转）/ 报错横幅（.error-message + 正文 'mailbox domain' at-risk 弹窗扫描，命中即明确抛错）
2. 四种点击策略：表单末按钮 → Sign Up 文本 pickIndex 1（对齐参考项目 nth(1)）→ **密码框聚焦回车**（键盘 submit，避开文本定位误点）→ 宽松文本兜底
3. 终败时 `SUBMIT-DUMP` 快照落日志（URL + 按钮清单 + 输入框值 + 正文 300 字），**不限测试模式**，远程定位全靠它

**校验**：3 个 JS node --check 通过；备份 `backups/traehop-20261005-111948.zip`。
待验证：完全退出 TraeHop（含托盘）重启 → 注册 1 个 intl 账号。预期：若风控弹滑块，注册窗口自动置前并等待手动完成（日志「🧩 提交时出现验证码」）；注册成功后日志依次出现「🔑 注册窗口同源直调 User Token 成功」「🎉 [邮箱] 已加入账号列表」，账号列表出现国际版新账号。若仍失败，看日志 SUBMIT-DUMP 行定位页面状态。

### 4.14 注册接口响应体直读 + verify 快速失败 + 概览版本切换（2026-10-05）

用户 11:21 重测（已加载上一轮取 Token 重排修复），新故障：**提交后 GetUserToken 持续 401（code 20310 get session empty）**，日志刷了几十行同样内容。

**根因（注册实际失败但代码以为请求发出了=成功）**：`fired.emailRegister` 只在 `onBeforeRequest` 标记"请求发出了"，不看响应成功失败。注册接口返回了业务错误（比如验证码错误/邮箱已注册/密码强度不够），但页面不跳转、.error-message 也没匹配到，代码就进入 `waitForLoginLanded(verify=true)` 死循环——游客 sessionid 一直有 → GetUserToken 一直 20310 → 一直等下去。40 次 × 500ms = 20 秒，但每次 `fetchUserTokenInPage` 都打一行日志，刷屏严重。

**修复一（注册响应直读）**：
- `registerIntlFlow` 新增 `netMonitor` 参数，提交前就挂 `netMonitor.waitResponse(/register_verify_login|passport\/web\/email\/register/i, 20000)`，CDP 直读响应体
- 点击后并行等四路信号：CDP 响应体 / URL 跳转 / 滑块 / 报错横幅 + at-risk 弹窗
- 拿到响应就解析 `ResponseMetadata.Error.Code`，有错误直接抛出「注册失败：code=XXX ...」，不再瞎等
- 成功才设 `requestSeen = true` 继续流程
- 滑块等待期间也同步等 CDP 响应，解完滑块注册结果立即到手

**修复二（verify 快速失败）**：`waitForLoginLanded` 的 verify 模式加 `emptySessionStreak` 计数器，连续 8 次 Token 实证 401 → `LOGIN-FAIL-DUMP` 页面快照（URL + 错误信息 + 表单数 + 正文 400 字）→ 立即返回 false，不再空转 20 秒

**修复三（概览区分版本）**：
- `index.html`：概览内容区顶部加三标签栏（全部 / 国内版 / 国际版），`.overview-tabs` + `.overview-tab`
- `styles.css`：标签栏样式（胶囊分段按钮，激活态主色填充）
- `renderer.js`：新增 `overviewEdition` 状态变量 + 事件委托点击切换；`updateOverview` 按版本过滤账号后算统计；选中版本下 0 账号时统计区全 0 / — / 0% 灰态，不跳空态页
- `zh.json` / `en.json` / `i18n.js`：`overview.tabAll / tabCn / tabIntl` 三词条
- 版本判定优先用 `account.edition`，缺失时按邮箱后缀（`@maxxspace.com` → intl）兜底

**校验**：3 个 JS node --check 通过 + zh/en.json JSON 校验通过；备份 `backups/traehop-20261005-114843.zip`。
待验证：重启 TraeHop → 注册 1 个 intl 账号。预期日志不再刷屏死循环，注册失败时直接看到「注册接口返回错误：HTTP XXX code=XXX ...」，成功时正常入库。概览页顶部可切换全部/国内/国际，统计数据对应筛选。

### 4.15 发码请求检测盲区修复：三路信号（2026-10-05）

用户 11:52 重测，新故障：**Send Code 点击后请求未发出，重试 3 次全空转**，日志出现「字段[^email$]值丢失("")」后仍失败。

**根因（请求实际发出但代码检测不到）**：发码确认只认死正则 `/passport\/web\/email\/send_code/i`（onBeforeRequest 标记 `fired.emailSendCode`）。若 trae.ai 更换发码接口路径（风控频繁改接口），页面真实发出请求、服务端也受理了，但标记永远不置 true → 6 秒后重试 → 页面此时已进入"等待验证码"状态并重渲染表单（email 值被清空 = 日志里的「字段值丢失」铁证）→ 重填后再次点击 = 重复发码 → 3 次全空转抛错。

**修复（`trae-register.js`）**：
- 新增 `JS_SENDCODE_STATE` 页面状态脚本：检测发码按钮倒计时（`\d+s`/resend/重新/再…）、按钮禁用态、验证码输入框出现——**前端受理发码的最可靠信号，与接口路径无关**
- 发码循环改三路信号：① onBeforeRequest URL 正则（已放宽到 `send[_-]?code|verify[_-]?code|email[_-]?(send|verify)`）② CDP 响应体（`netMonitor.waitResponse(/send|verify+code/, 20s)`，响应体明确报错 `"error"`/`success:false` 时**不**确认成功，等页面状态走重试）③ 页面倒计时/验证码框状态
- 点击前预检 `JS_SENDCODE_STATE`：若页面已处于等待验证码状态（上一轮实际发码成功但检测失败），直接确认，**避免重复发码触发风控**
- 3 次全失败时 `SENDCODE-DUMP` 页面快照（URL + 按钮清单 + 输入框值 + 正文 300 字）落日志

**校验**：node --check 通过；备份 `backups/traehop-20261005-115547.zip`。
待验证：重启 TraeHop → 注册 1 个 intl 账号。预期日志出现「发码请求已确认（页面 countdown:Resend in 60s / CDP 响应 HTTP 200）」，不再误报"请求未发出"；若页面真没受理（网络 abort），SENDCODE-DUMP 直接暴露页面实际状态。

### 4.16 本地 API 转换服务（2026-10-05）

用户需求：把 Trae 账号池的积分/额度转化为**本地 OpenAI/Anthropic 兼容 API**，供 Claude Code、Cursor、Cline、Windsurf 等工具调用；账号池=分组（全部/国内版/国际版）+ 可选账号 + 每账号积分上限，积分聚合给 API 调用。参考 dsh-trae-api / trae2api-web / Buddy Switch / Trae-Relay 四类社区工具的设计。

**实现（`electron/api-server.js` 新文件 + 五层集成）**：
- 上游链路：`POST {AgentHost}/api/agent/v3/llm_utils_chat`，`Authorization: Cloud-IDE-JWT <token>` + x-uid/x-device-id(sha256(machineId) 前32位)/x-machine-id 设备头族；cn=trae-api-cn.mchost.guru、intl=a0ai-api-sg.byteintlapi.com；body `{messages, model, function:'inline_chat', stream:true, request_id, session_id}`；上游 SSE 事件 output(增量)/token_usage/done/error
- 对外契约：`GET /v1/status`（免鉴权探测）、`GET /v1/models`、`POST /v1/chat/completions`（OpenAI 流式/非流式）、`POST /v1/messages`（Anthropic 流式/非流式）；Bearer API Key 校验（timingSafeEqual）；模型映射 MODEL_MAP（claude-*/gpt-4o/mimo → Trae 内部 glm-*/DeepSeek-*）+ INTERNAL_MODELS 直通 + auto 默认
- 账号池：buildPool 按 group/accountIds 过滤 → 每账号 usageOf（getUsage，USAGE_TTL 5 分钟缓存）取剩余额度 → quotaCap 上限 → quotaLeft=cap-consumed 本地记账；**用量拉取失败不排除账号**（有上限按上限、无上限视为不限制，仅靠 consumed 记账）；pickAccount 选 quotaLeft 最大者，配额尽/冷却自动轮换
- 配额与冷却：token_usage 事件记账（无 usage 事件时按字符估算）；429→60s 软冷却、403/409→12h 硬冷却（疑似套餐额度耗尽）、连续错误 3 次→10min 冷却
- 401 自愈：token 失效 → ensureToken.flush 后重试一次 → 仍失败进冷却换下一账号
- 请求体转换：OpenAI 与 Anthropic 双向归一为上游 messages（system/user/assistant/tool_calls/tool 全角色；Anthropic tool_use → function tool_calls）；tools 注入为 system 提示（上游内联模式）
- 流式转发：上游 SSE → OpenAI `data:` chunk（content/reasoning_content/tool_calls delta + finish_reason + [DONE]）或 Anthropic `message_start/content_block_*/message_delta/message_stop`；非流式上游强制 stream:true 收集全量后按 JSON 输出

**集成**：
- `main.js`：getApiServer() 惰性创建（deps=accountStore.getApiConfig/listAccounts/ensureValidToken/getAccountUsage）；IPC `api:get-config`/`api:save-config`（按 enabled 启停/重启）/`api:status`/`api:start`/`api:stop`；whenReady 按配置自动启动；before-quit 停止
- `preload.js`：暴露 getApiConfig/saveApiConfig/apiStatus/apiStart/apiStop
- `account-store.js`：DEFAULT_API_CONFIG + getApiConfig/saveApiConfig（独立 store key `apiServer`，不走 settings 白名单）
- 设置页 UI（index.html 机器码管理后新增 `#api-server-group`）：启用开关/端口/API Key/分组/每账号积分上限/默认模型 + 状态面板（运行态、请求/错误计数、接口地址、池内账号数、可调用积分/已消耗）+ 启动/停止/刷新按钮；`.input`/`.api-status*` 样式
- i18n：zh/en `apiServer.*` 文案；**注意 textPairs 的 nth-child 陷阱**：插入新 settings-group 后原 5-8 序号整体 +1，已同步改 6-9

**修复**：`ApiServer.stop()` 若直接 `server.close()` 会被 SSE 长连接挂死 → `closeAllConnections()` 先掐连接再 close（Node 18.2+）

**校验**：5 个 JS node --check 过、zh/en.json 合法；mock deps 冒烟测试通过（status 200/models 27 个/无鉴权 401/坏 key 401/未知路径 404/stop 正常）；备份 `backups/traehop-20261005-122435.zip`。
待验证：重启 TraeHop → 设置页启用服务 → Claude Code 配 `ANTHROPIC_BASE_URL=http://127.0.0.1:9220` 或 Cursor 配 OpenAI 兼容端点实测一次流式对话；账号池余额展示与每账号上限扣减。

### 4.17 注册"接口返回错误"误判修复（2026-10-05）

用户反馈：11:57 批次注册日志 `❌ 注册接口返回错误：HTTP 200 success`，注册流程直接 throw，未走到 Token 入库。

**根因**：trae-register.js 注册响应解析把所有 `d.message` 当错误——注册接口（register_verify_login/passport/web/email/register）返回 `{"message":"success"}` 是**成功响应**，却被 `else if (d?.error || d?.message) → apiErr = "success"` 误判失败。

**参照项目**（用户提供，源码在 D:\下载\trae-ref3\）：
- `CN-Air84/TraeAccountCreatorPlus`（S-Trespassing/Trae-Account-Creator 复活改进版，Python/Playwright）：注册成功判定=`page.wait_for_url("setting" in url)`，URL 跳转优先、接口响应不做成败主判；失败只查 `.error-message`；礼包部分注释"周年礼包活动结束了"（活动已结束，claim API 400/409 记日志不报错，无需改）；成功=保存 Cookie+session storage
- `zc-zhangchen/any-auto-register`（Web UI 批量注册工具）：仅内置 chatgpt/icloud 平台实现（无 Trae 专门代码），核心价值=验证码自动处理/代理池/任务调度基建，与本次修复无直接关联

**修复**（trae-register.js 注册响应解析段）：
1. 响应体完整落日志（`注册接口响应：HTTP {status} {body前400字符}`），不再盲猜
2. 宽容解析：`ResponseMetadata.Error.Code` 存在→明确失败；`error/message` 为 success/ok/successful/succeed（大小写不敏感）→**视为成功**（记 bodyNote）；其他文本→失败；非 JSON→不据此判定
3. 最终成败仍由 waitForLoginLanded(verify) 的窗口内 GetUserToken 实证兜底（连续 8 次 session empty 快速失败+dump），游客 sessionid 假阳性防线保留

**校验**：node --check 通过；备份 `backups/traehop-20261005-122936.zip`。
待验证：重启 TraeHop 注册 1 个 intl 账号——预期日志出现「注册接口响应：HTTP 200 {"message":"success"}」→「✅ 注册接口返回成功」→「✅ 登录 Cookie 已落地，窗口内 Token 实证通过」→ 账号入库国际版分组；若响应体实为错误结构，日志会完整暴露供下一步适配。

**补丁（12:31，IPC 序列化崩溃）**：`api:save-config` 报 `Error: An object could not be cloned`——根因=§4.16 buildPool 的"用量拉取失败不排除账号"兜底用 `Infinity`（无上限时 realLeft/quotaLeft=Infinity），status() 原样返回 pool 给 IPC，**Infinity 无法被 Electron 结构化克隆**（同一批次的 /v1/status 端点 JSON.stringify 也会把 Infinity 变 null）。修复=status() 出口统一清洗：`safePool` 把非有限值归一为 -1（语义=不限），totalLeft 只累加有限正值；renderer 的 fmt 兼容 -1 显示 `∞`。mock getUsage 抛错触发 Infinity 路径冒烟验证：pool[0] 输出 `usageLeft:-1 quotaLeft:-1`、JSON 往返 + structuredClone 均通过（cooldown:null 为正常可克隆值，勿误判）。备份 `backups/traehop-20261005-123126.zip`。

**补丁（12:40，API 服务端口互斥锁）**：`listen EADDRINUSE: address already in use 127.0.0.1:9220`——根因=main.js `whenReady` 里按配置自动 `startApiServer()` 与用户点击「启动」触发的 `api:start`/`api:save-config` **并发**调用 `srv.start()`，两次 `http.createServer().listen(9220)` 竞争同一端口，后到者报 EADDRINUSE（此前端口一直被当前 TraeHop 多进程组占用的表象即此竞态）。修复=api-server.js `start()` 加 `this.starting` 互斥锁：`if (this.server || this.starting) return this.status()`，并发调用直接复用进行中启动的结果，不再二次 listen；同时 EADDRINUSE 错误提示明确化（提示关闭占用进程或改端口）。国内账号积分链路确认：`AGENT_HOSTS.cn=trae-api-cn.mchost.guru` + `getAccountUsage` 内部按 editionOfAccount 自动路由（国内走 api.trae.cn v2 usage_summary），国内版积分直接支持，无需额外配置。备份 `backups/traehop-20261005-124003.zip`。

**补丁（12:43，api:save-config Promise 未 await 崩溃）**：保存 API 服务配置仍报 `Error: An object could not be cloned`——上次只修了 status() 内 Infinity（§4.16 补丁），本次根因=main.js `api:save-config` 返回对象里写 `status: srv.status()`，**status() 是 async 方法，未 await 时该字段是 Promise 对象**，Electron IPC 结构化克隆无法克隆 Promise → 每次保存必炸。连带修复 `const running = srv.status().running`（同步取 async 方法属性恒 undefined，导致版本判断恒走 start 分支，靠互斥锁兜底才没二次 listen）。修复=`await srv.status()` 取 running + 返回值 `status: await srv.status()`。全量排查 main.js 其余调用点（api:start/api:stop/api:status）均属 async 函数直接 return Promise，自动展平，无同类问题。备份 `backups/traehop-20261005-124239.zip`。

**补丁（12:52，上游 400 诊断盲区）**：第三方客户端「测试并添加」报 `所有账号不可用：上游 HTTP 400 (503)`。命令行复现三种请求（stream:false/true/带 tools）均 200，客户端请求体与本地构造不同，复现不出 400；根因未明，先补诊断：handleChat 非 2xx 分支读取上游响应体前 400 字符并入 lastErr（原只记状态码，上游拒绝原因不可见）。重启后客户端重测，报错文案将带出上游真实 400 响应体以定位。备份 `backups/traehop-20261005-125148.zip`。

## 5. 备份与恢复

- 备份脚本：`backup.ps1`（项目根），运行后源码快照存入 `backups/traehop-时间戳.zip`
- 数据库备份：迁移时自动生成 `database.db.bak-时间戳`（与库同目录）
- 恢复数据库：备份文件复制回 `database.db`（若备份名带尾点，用 `\\?\` 前缀路径访问）
- 迁移前必须：托盘右键**正常退出 TRAE SOLO CN**（避免 WAL 未合并）

## 6. 历史教训（勿再踩）

1. 功能源码误删后回收站无备份（Shift+Del / TRAE 内删除）→ **每次完成功能必须跑 `backup.ps1`**
2. 仅改 `session_project` 映射会导致会话悬空 → 必须同步 `chat_session.project_id` 外键与 `local_artifact` 产物（已在 Python 引擎处理）
3. 数据库迁移工具拒绝在 TRAE 运行时执行 → 先退出再操作
4. Electron 打包目录同时存在 `app` 与 `app.asar` 时注意加载优先级，改动源码后确认实际加载的是 `app` 目录

## 7. 架构重构与多平台支持（2026-10-06）

### 7.1 目标
- 代码高质量、高性能，功能与重构前保持完全一致
- 主进程 IPC 按职责模块化拆分
- 渲染进程从单一 `renderer.js` 拆分为 `core` + `ui` 两层
- 新增 WorkBuddy 平台支持，保留 Trae 全部既有行为

### 7.2 主进程改造
- 新增 `electron/context.js`：集中管理互斥锁（checkin/migrate/register）、主窗口引用、账号变更广播
- 新增 `electron/ipc/` 目录：
  - `accounts.js`：账号增删改查、导入导出、当前账号、设备标识
  - `checkin.js`：全账号签到 + 单个账号签到
  - `migrate.js`：会话迁移（WorkBuddy 账号拒绝迁移）
  - `register.js`：国际版自动注册
  - `machine.js`：设备标识重置/清除登录态
  - `app.js` / `utils.js`：应用退出与包装工具
- `electron/main.js` 仅保留窗口/托盘创建、启动流程与 IPC 注册调度

### 7.3 渲染进程改造
- `src/renderer/core/`：
  - `state.js`：全局状态、平台常量、折叠状态持久化
  - `api.js`：主进程 API 桥包装
  - `i18n.js`：国际化 selector 与 `data-i18n` 处理
  - `utils.js`：通用工具，新增 `asyncPool`（并发控制）、`rafDebounce`（RAF 节流）、`memoize`（缓存）
- `src/renderer/ui/`：
  - `accounts.js`：账号列表、平台分组、过滤/排序、用量加载
  - `actions.js`：账号操作封装（切换、清理后切换、签到单个、Token 刷新）
  - `events.js`：全局事件委托
  - `overview.js` / `settings.js` / `checkin.js` / `migrate.js` / `add-account.js` / `history.js` / `stats.js` 等
- `src/renderer/app.js`：统一初始化入口

### 7.4 多平台支持
- 账号数据结构新增 `platform` 字段（`'trae'` / `'workbuddy'`，旧数据默认 `'trae'`）
- 账号页按平台分组展示（Trae / WorkBuddy），支持折叠，折叠状态持久化到 `localStorage`
- WorkBuddy 账号卡片简化显示：名称、uid、endpoint、签到状态
- Trae 账号卡片保留完整功能：用量、切换、迁移、重置后切换、续登、Token 刷新
- 全局添加账号流程改为两步：先选平台，再按平台显示添加方式

### 7.5 WorkBuddy 签到
- 凭据路径：
  - Windows：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
  - macOS：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`
  - Linux：`~/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info`
- 签到接口：`POST {endpoint}/v2/billing/meter/daily-checkin`
- 状态查询：`POST {endpoint}/v2/billing/meter/checkin-activity-status`
- 检测到加密信封 `$wbEncrypted` 时提示用户手动提取明文 Token

### 7.6 设备标识与签到优化
- 统一设备号生成：`stableDeviceId(machineId)` = `sha256(machineId)` → BigInt → 16 位数字
- 签到时 deviceId 优先从账号已绑定的 machineId 推导；旧数据无 machineId 时生成并回存
- 移除 `rotateDeviceId`，解决多设备号导致的新 9074 问题
- 9074 限流处理：延迟 `CLAIM_GAP_MS * 2` 后重试一次，仍 9074 则标记为限流
- 单个账号签到按钮：每个 Trae / WorkBuddy 卡片均显示，已签账号显示绿色标签
- 全局一键签到前预检今日已签账号并跳过

### 7.7 性能优化
- `loadAllUsage` 使用 `asyncPool` 限制并发为 5，避免同时大量请求造成 UI 阻塞
- 用量接口结果按账号缓存 60 秒，过滤/排序/切换页面时减少重复请求；手动刷新按钮绕过缓存
- `renderAccountList` 使用 RAF 节流，输入搜索/过滤时减少连续重渲染
- 账号列表 DOM 使用 `DocumentFragment` 批量插入，替代 `innerHTML` 全量字符串替换

### 7.8 已移除功能
- 本地 API 转换服务（`api-server.js`、设置页 API 服务区块、相关 IPC 与 store key）已全部删除，避免遗留死代码

### 7.9 关键文件清单
- 新增：`electron/context.js`、`electron/ipc/*.js`、`electron/checkin.js`、`electron/workbuddy-checkin.js`、`electron/workbuddy-reader.js`、`src/renderer/app.js`、`src/renderer/core/*.js`、`src/renderer/ui/*.js`
- 大幅改动：`electron/main.js`、`electron/preload.js`、`electron/account-store.js`、`electron/trae-checkin.js`、`src/index.html`、`src/styles.css`、`src/locales/zh.json`、`src/locales/en.json`
- 删除：`electron/api-server.js`（保留未引用）、index.html 中 `#api-server-group`

### 7.10 风险与验证点
- WorkBuddy 加密凭据无法自动解密，需用户手动提取 Token
- 大量账号（>100）时列表渲染仍需验证滚动流畅度；当前已通过 RAF + 缓存 + 并发控制缓解
- 重构后必须重启应用，旧进程仍跑旧授权链路
- 账号版本推导：身份规则 → `edition` 字段 → `region` 兜底，确保旧数据兼容

## 8. API 网关移植（2026-10-06）

### 8.1 范围
- 移植自 `D:\项目\TokensAPI`（TokenHub，Go 单文件），保留工具布局仅做风格迁移
- ZCode 相关功能按需求未实现

### 8.2 主进程新增（`electron/gateway/`）
- `config.js`：配置加载/校验/落盘（`%APPDATA%\TraeHop\gateway\config.json`），API Key 生成（`sk-` + 18B hex）
- `errors.js`：ProviderError 分类（quota/rate/auth/model/client/server/network/stream）+ 响应体分类器
- `httpx.js`：Node 原生 `http(s).Agent` 连接池复用（keep-alive，零依赖）
- `sse.js`：SSE 事件流解析（Trae 自定义帧 + WorkBuddy OpenAI 风格帧）
- `providers/trae.js`：Trae 上游（solo 协议、get_detail_param 模型列表 1h 缓存、seedModels 兜底）
- `providers/workbuddy.js`：WorkBuddy 上游（/console/enterprises/personal/models）
- `pool.js`：账号池（轮询 rr、candidates 冷却过滤、applyPolicy 差异化冷却：quota 6h/限流 5min/网络 15s、quota 时 Trae 额度探测防误冷却、AUTH+无 cookies 标记 dead）
- `sinks.js`：OpenAIStreamSink / AnthropicStreamSink / 聚合 sink / UsageRecorder
- `server.js`：HTTP 服务与路由（`/v1/chat/completions`、`/v1/completions`、`/v1/models`、`/v1/messages`、`/v1/messages/count_tokens`、`/status` owner-only、`/healthz` 免鉴权）、Anthropic→OpenAI 请求转换、鉴权（主 Key + 分享钥匙）、CORS、用量记录
- `shares.js`：分享钥匙（`gateway/shares.json`，per-provider 开关/模型白名单/Token 上限/用量统计）
- `usagelog.js`：用量环形日志（`gateway/usagelog.json`，上限 500 条）
- `tunnel.js`：bore 协议客户端（bore.pub 中继、连接池预热保活）
- `scheduler.js`：定时任务（签到 60s 轮、token 刷新 1h、额度探测、积分耗尽自动冷却 6h）
- `index.js`：GatewayManager 统一启停/状态

### 8.3 接线
- `ipc/gateway.js`：17 个 IPC handler；`preload.js`：`traeAccounts.gateway.*` 桥；`main.js`：启动时按 `autoStart` 自动启动、退出时停止
- `account-store.js`：新增 `listAccountsRaw()` 供池读取

### 8.4 渲染层新增
- `src/renderer/ui/gateway.js`：网关面板（状态 5s 轮询、启停/重启/重置 Key、配置表单、隧道、分享钥匙 CRUD+行内编辑、用量日志表格）
- `src/renderer/ui/models.js`：模型列表（搜索 RAF 节流、提供商筛选、仅可用开关、计数、复制 id）
- `navigation.js`：gateway/models 切页懒加载；`app.js`：事件绑定接入
- `index.html`：网关页 + 模型页结构（data-i18n 全覆盖）；`locales/zh|en.json`：gateway/models 键组
- `styles.css`：gw-*/model-* 样式 + 深色霓虹换肤（--primary #22d3ee、渐变大标题、导航光条）

### 8.5 已修复的关键 bug（冒烟测试抓出）
1. pool.chat 首次调用必崩：`rr.get()` 未初始化 → `undefined % N` = NaN → `cands[NaN].id` TypeError → 已加 `|| 0`
2. healthz 被鉴权拦截 → 路由表加 `noAuth` 标记
3. handleHealth 同步函数返回 undefined 导致 `.catch` 崩 → `Promise.resolve()` 包装
4. smoke 首跑误写真实 `%APPDATA%\TraeHop\gateway\usagelog.json` 2 条测试记录 → 已清理，后续验证脚本须先隔离 APPDATA

### 8.5b 真机联调修复（2026-10-06 下午，用户实测抓出）
1. **AggregateSink.finish 字段/方法名冲突（P0）**：构造函数 `this.finish = ''`（存 finish_reason）遮蔽原型方法 `finish(f)`，上游成功返回后 `sink.finish(...)` 必崩 `this.inner.finish is not a function`（502）→ 字段改名 `finishReason`。此前冒烟只测负路径（无账号/坏 JSON），从未走"上游成功"正路径，故漏测；教训：**凡"成功路径"必须有真实上游 E2E**。已补真实账号 E2E：2168ms 返回、finish_reason/usage 正常
2. **无 /v1 前缀路由 404**：客户端 Base URL 不带 `/v1` 时报 `未知路由 POST /chat/completions` → 路由表补全无前缀兼容路由（/chat/completions、/completions、/models、/messages、/messages/count_tokens），Base URL 带不带 `/v1` 均可用

### 8.6 验证结论（2026-10-06）
- 主进程 18 文件 `node --check` 全过；渲染层 5 文件（.mjs 复制法）全过
- require 图 76 模块全部可解析；渲染层 30 个 DOM id 引用全部存在；zh/en i18n 键全覆盖
- 隔离环境 headless 冒烟 9/9 PASS：healthz 200、404、401×2、models 200、无账号负路径（OpenAI+Anthropic）、坏 JSON 400、count_tokens 200
- 真实 chat 流式回归：待重启应用后由用户实测（此前记录 gateway chat trae:glm-5.3 2.4s~3.1s）

### 8.7 延迟优化要点
- 流式零缓冲透传（首字节即写）；上游连接 keep-alive 池复用；启动即 warm DNS/TLS；模型列表 1h 缓存

### 8.8 开源上传准备与换图标（2026-10-06 下午）
- 换图标：用户提供新 logo（鬼鬼企鹅），中心裁方生成 16~512 八档 PNG，打包多尺寸 icon.ico（227KB）+ icon.icns（2MB）+ icon.png（512，574KB）；原图标备份 backups/icons-old-20261006-*
- 运行时窗口/托盘/favicon/侧栏 logo 全部读 build/icon.png，替换即生效；**exe 文件本身图标内嵌于二进制，需 electron-builder 重打包才会变**
- 开源安全：白名单式 .gitignore（默认排全部，仅放行源码/docs/LICENSE/PROGRESS/backup.ps1/构建配置）；源码 JWT/密钥扫描 0 命中
- 已排除的高危项：`_import_5accounts.staging.json`（含真实 token+cookies）、`_aiagent_plain.db`（92MB 解密库）、全部 _probe/_db/_dll/_solo 逆向产物、node_modules、exe/dll/pak 运行时、backups/
- git 2.49 经华为云镜像安装（winget 连不上 GitHub）；仓库已 init（main 分支）+ 首个提交 0ef1b38，98 个文件，敏感模式扫描 0 命中
- LICENSE 采用 MIT（允许二改）；commit 身份为仓库级 -c 占位（TraeHop），未动全局 git 配置
