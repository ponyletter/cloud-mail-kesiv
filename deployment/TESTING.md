# 验证方式与边界

## 已完成的生产测试

本次生产验证使用管理员、三个原有转发邮箱导入后的独立普通用户，以及一个无精确路由的新注册测试用户。结果来自实际部署，不是只看配置文件。

| 项目 | 已验证结果 | 边界 |
| --- | --- | --- |
| 网站与静态资源 | HTTPS 200 | 本次检查时可用 |
| 初始化入口 | 未授权 404，初始化阶段公众 503 | 管理员仍需保管 setup secret |
| 管理员与普通用户登录 | 成功，普通用户无 `*` 管理权限 | 密码未公开 |
| 普通用户外发 | 应用成功，Resend 返回邮件 ID | 不代表已读取收件方最终收件箱 |
| Catch-all | 无精确规则的新注册用户收到真实外部邮件 | 域名与对应 user/account 必须配置正确 |
| 邮件归属 | 普通用户自己的 API 可读收件记录 | 不据此宣称完成全量安全审计 |
| 入站/发件附件 | R2 下载成功、SHA-256 一致 | 本次小型附件样本 |
| 旧地址导入 | 三个用户收信保存并执行 Gmail 转发 | 原规则 ID/匹配/优先级保留 |
| Gmail 转发 | 对应 Worker `outcome=ok`，无异常或转发错误 | 未登录 Gmail 读取最终收件箱 |
| 某普通用户新 plus 别名 | 外部 SMTP 成功进入其原 user/account | 原地址的提供商投递问题仍未定因 |
| 旧业务 | DNS/MX、Resend 验证记录未变；仅按授权调整路由 | 真实账户与审计日志保留在私有目录 |

原始邮件 ID、账户 ID、邮箱列表、真实资源配置和会话日志不发布到公开仓库。

## 可复现的本地检查

```bash
corepack pnpm --dir mail-vue run build
cd mail-worker
corepack pnpm exec wrangler deploy \
  --config ../deployment/wrangler.preflight.toml \
  --dry-run --outdir ../deployment/build
cd ..
node deployment/smoke-test.mjs
python3 deployment/scan-secrets.py
```

烟雾测试运行真实打包后的受保护 Worker，使用 Node SQLite、内存 KV/R2 与模拟 forward 回调，覆盖初始化门禁、管理员注册/登录、错误密码、普通角色原始发信拒绝与配额角色启用、站内收发、普通用户入站归属、MIME 附件和转发回调。不会发送真实外部邮件。

它不会验证 DNS、Cloudflare 的真实绑定/资源权限、SMTP、提供商最终投递、Gmail 最终接收或真实 Edge 隔离。数据库初始化里兼容旧版本字段的 migration warning 单独记录，并没有据此直接判失败。

本机公开前额外运行：

```bash
python3 deployment/scan-secrets.py --staged --secrets-file /path/to/private-bundle.json
python3 deployment/scan-secrets.py --history --secrets-file /path/to/private-bundle.json
```

私有 JSON 可含真实 Token、API Key、密码、JWT/setup secret；扫描器只报告文件与类型，不打印命中值。通用正则不是完整 DLP，仍需审阅新增文件。`deployment/.gitignore` 默认不提交未明确允许的部署产物。

`.github/reference/verify.yml` 模板包含前端构建、Worker dry-run、烟雾测试和通用密钥扫描，不使用生产 Cloudflare/Resend 凭据。当前 GitHub OAuth 缺少 `workflow` 权限，模板尚未启用；上述命令已在本地验证，不能将本地通过表述成 GitHub CI 已通过。
