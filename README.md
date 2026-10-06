# TraeHop

Trae / WorkBuddy 账号聚合管理 · OpenAI / Anthropic 兼容 API 网关

## 功能

**账号管理**

- 多账号导入 / 会话迁移 / 一键切换
- 积分与额度实时监控
- 自动签到 · 定时刷新 Token · 积分耗尽自动冷却

**API 网关**

- OpenAI / Anthropic 双协议兼容，Claude Code、Cursor、Cline 直接接入
- 账号池轮询 · 差异化冷却 · 失败自动换号
- 模型列表筛选 · 分享钥匙 · 用量日志
- 公网隧道（bore 协议），随时把本地网关暴露到公网

**安全**

- 凭据本地加密存储，不上传任何账号数据

## 使用

1. 启动应用，导入 Trae / WorkBuddy 账号
2. 网关页复制 API Key 与接入地址
3. 客户端 Base URL 填 `http://127.0.0.1:8690`（带不带 `/v1` 均可），模型选 `trae:模型名` 或直接用模型名

## License

[MIT](LICENSE)
