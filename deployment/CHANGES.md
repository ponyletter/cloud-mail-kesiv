# 与上游的差异

基线：[`maillab/cloud-mail@f406890`](https://github.com/maillab/cloud-mail/commit/f406890090a436a52be11d455e171b074fb8fcab)。保留上游 Git 历史和 MIT 许可证。

## 本次服务上线时

| 层面 | 变更 |
| --- | --- |
| Vue 前端、后端业务源码 | `mail-vue/`、`mail-worker/` 保持基线版本 |
| Worker 入口 | 新增 `deployment/worker-entry.js`，首次初始化期间封闭公众访问；初始化接口还需私有请求头；转交官方 fetch/email/scheduled handler |
| Cloudflare 资源 | 新建本项目 Worker、D1、KV、R2 和站点域名绑定 |
| 数据与角色设置 | 初始化数据库、注册管理员；普通角色从禁止发信调整为每天 20 封，未授予管理权限 |
| Email Routing | 最初新增精确规则；用户确认后启用 Catch-all，导入三个既有转发邮箱并保留 Gmail 转发目标 |
| 检查 | 增加认证排查、普通用户收发模拟、真实 SMTP/附件/转发验证 |

因此项目包含部署层新增代码和持久化配置变化。邮件收发功能仍使用上游实现。

## 整理公开仓库时

- 增加参数化生产模板、部署步骤、问题排查、验证边界和 Roadmap。
- 通用化认证诊断脚本，报告写到私有配置目录。
- 本地测试覆盖入口保护、普通用户默认禁止发信、角色调整、收信归属、附件和转发回调。
- 增加 Git 内容密钥扫描，支持暂存区、全历史及本机已知密钥对照。
- 将上游部署流程和新增的只做构建检查的验证模板放到 `.github/reference/`。当前 GitHub OAuth 缺少 `workflow` scope，未启用 Actions；不会因推送代码自动改变服务。
- Git 默认忽略生产配置、原始审计结果、用户列表、会话日志与凭据。公共配置中的 ID 和邮箱均为示例。

这些仓库整理动作没有重新部署生产 Worker，也没有更改已有生产密码、MX 或 Resend 配置。
