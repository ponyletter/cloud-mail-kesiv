# 后续问题与开发计划

本分支复用上游收发、附件和用户管理功能，没有为上线重新实现一套邮箱后端。以下区分尚未定因的问题、尚未启用的集成和未来开发。

## 未解决的投递问题

- 某普通用户原地址的 Resend 投递缺少 Cloudflare 入站事件；同用户的新 plus 别名、其他既有地址、新注册账号已真实收信。待获取提供商 SMTP/抑制/延迟证据，或独立发件方复核。不能在缺少证据时归因为权限或抑制列表。

## 已有上游能力，但本次未启用或未完整验收

- Resend Webhook 的最终 delivered/bounced 状态回填与签名/重放保护验收。当前发送 Key 只负责发信。
- Workers AI、Turnstile、OAuth、Telegram、自定义 Webhook 等可选集成。本次未启用，不代表上游没有实现。
- 最终 Gmail 收件箱与多种独立外部发件方的完整端到端验证。

## 未来开发/运维

- 适配受保护入口的手动生产发布 Actions，使用受保护 environment、Secrets、备份与回滚；当前仅有验证工作流模板，GitHub OAuth 缺少 `workflow` 权限，尚未启用 Actions。
- D1/R2/KV 备份、恢复演练和迁移 runbook；不能只把已创建资源当作有备份。
- 面向多用户的账户共享外发额度、注册滥用保护及可观测告警。
- 全局 Gmail 转发的产品说明与按用户转发策略；当前沿用全局配置，可通过现有规则限制地址范围。
- 上游变更合并与数据库迁移的隔离环境验收。

仓库 Issues 记录具体证据和验收条件。Issue 不包含 Token、密码、邮件原文或完整收件人地址。

## GitHub 跟踪

| 状态 | Issue |
| --- | --- |
| 已解决 | [#1 D1 创建 401/10000：已确认旧只读令牌根因并解决](https://github.com/ponyletter/cloud-mail-kesiv/issues/1) |
| 已解决 | [#2 普通用户无法发信：默认角色由 ban 调整为 day/20](https://github.com/ponyletter/cloud-mail-kesiv/issues/2) |
| 已解决 | [#3 新注册用户外部收信：已启用 Catch-all 并接入原转发邮箱](https://github.com/ponyletter/cloud-mail-kesiv/issues/3) |
| 待处理 | [#4 调查单个旧地址的外部投递缺失：提供商日志证据待补充](https://github.com/ponyletter/cloud-mail-kesiv/issues/4) |
| 待处理 | [#5 配置并验证 Resend Webhook 的最终投递状态回填](https://github.com/ponyletter/cloud-mail-kesiv/issues/5) |
| 待处理 | [#6 实现适配受保护入口的手动生产发布与回滚流程](https://github.com/ponyletter/cloud-mail-kesiv/issues/6) |
| 待处理 | [#7 补充 D1/R2/KV 备份、恢复演练和上游迁移流程](https://github.com/ponyletter/cloud-mail-kesiv/issues/7) |
| 待处理 | [#8 评估公开注册的共享配额、滥用防护和告警](https://github.com/ponyletter/cloud-mail-kesiv/issues/8) |
| 待处理 | [#9 启用 GitHub 验证工作流：当前 OAuth 缺少 workflow 权限](https://github.com/ponyletter/cloud-mail-kesiv/issues/9) |
