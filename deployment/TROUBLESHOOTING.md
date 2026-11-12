# 实际遇到的问题与排查方法

下文按本次执行证据整理。公开记录省略了真实 Token、账户标识、用户地址和邮件内容。

## Cloudflare 401 / 10000：只读成功、D1 创建失败

现象：Token verify 为 active、域名账户正确、D1 GET 成功，但 POST 创建返回 401/10000。最初令牌来源于 Read All Resources 模板；审计创建快照显示 D1 Read 等读取组，没有相应写入组。该快照是历史证据，不应冒充当前策略读取结果。

最终使用新的自定义写入 Token 后，同一 Account 的 D1 列表、创建与后续部署均成功。问题解决的证据是原始 API 的写请求结果；没有通过反复修改无关权限来试错。

排查顺序：

1. 从唯一私有文件读取实际 Token，确认没有引号、换行、重复变量或错误 Account ID。
2. `/user/tokens/verify` 核对 active 和 Token ID，与后台实际令牌 ID 比对。
3. Zone 的 `account.id` 必须与 `CLOUDFLARE_ACCOUNT_ID` 一致。
4. 用相同 Token 与 Account 测 D1 GET，再测有明确用途的 POST；同时记录 HTTP 状态和 JSON errors。
5. 清除诊断子进程继承的旧 `CF_*`、`CLOUDFLARE_*`、Wrangler/OAuth、代理等冲突来源；只保留一条 Bearer 请求头。不要打印 Token。
6. 若身份、资源范围、已知写权限都匹配但仍失败，再用仅含必要权限的新令牌对照；不要只凭 `active` 宣称写权限齐全。

读取 Token 自身策略返回 403，可能只是缺少 API Tokens Read，不能推出 D1/Workers 部署权限不足。

工具用法见 [GUIDE.md](GUIDE.md)，`--test-create` 会真实创建指定资源，默认不开启。

## 管理员可以发信，普通用户提示无权限

本次普通默认角色为 `sendType=ban`，普通用户调用发信接口可复现业务 `code=403`，HTTP 却为 200。管理员按配置邮箱跳过角色限制，因此管理员测试不能覆盖普通用户行为。

处理：保留普通用户权限，仅将默认角色调整为 `day / 20`，确认具有 `email:send`、域名允许且用户未停用。重新登录/刷新客户端读取角色。之后用真实普通用户向站外地址发信，记录提供商接受 ID。

同域站内互发会绕过外部提供商，因此不能拿站内成功来证明 Resend 外发正常。

## 新用户注册成功但收不到外部邮件

本次最初只有管理员精确规则，Catch-all 关闭。注册只创建应用中的 user/account，并不会自动新增 Cloudflare 精确规则。

处理：用户确认后将 Catch-all 指向本 Worker。验证时新建一个没有精确规则的普通用户，从站外投递，确认 Worker 事件、D1 归属及用户自己的收件箱，附件下载进行 SHA-256 校验。该项已真实通过。

旧精确规则会先处理自己匹配的地址。要让旧 Gmail 转发地址也进入系统，应先创建站内账号，再修改原精确规则为 Worker，保留既有 Gmail 转发目标并重测。这项也已通过。

## 单一原地址仍缺少入站事件：尚未定因

对照中管理员、三个导入邮箱和新注册邮箱收到外部测试邮件；某个先前投递失败的普通地址没有对应 Worker 入站事件，但其新 plus 别名通过 Catch-all 成功进入同一用户/邮箱。说明普通用户接收处理与存储路径可工作，仍不能据此确定原地址在上游是退信、延迟、抑制或其他状态。

当前 Resend Key 是 Sending access，详情查询返回 `401 restricted_api_key`，无法从该 Key 读取投递时间线。待办是查询提供商控制台的原邮件 ID/SMTP 结果，或由 Gmail 等独立发件方复核；参阅[缺失邮件排查](https://resend.com/guides/email/users-never-got-login-code)。不得把“没看到入站事件”直接写成“已证明 Resend 抑制”。

不要为单一地址故障改根域 MX、破坏现有精确路由，或把全局 DNS 重配作为第一步。

## Python 客户端收到 Cloudflare 403 / 1010

本环境默认 urllib User-Agent 访问站点曾触发 1010，换为明确的浏览器风格诊断 User-Agent 后成功。应区分 WAF/客户端问题与后端业务错误，不应由此推断 Token 缺权限。此为环境实测现象，不能推广为所有 Cloudflare 站点的固定要求。

## Wrangler 本地 workerd 无法运行

本环境 glibc 与本地 workerd 不兼容；前端构建、Wrangler 打包和远程部署仍可完成。使用 Node 内存适配器验证业务路径，再通过远程真实 SMTP、D1/R2 和 Worker 日志验收。本地模拟不能代替 Cloudflare 运行时检查。

## Tail 看起来没有连接

JSON tail 不一定输出 `Connected` 文本。用一个已知 HTTP 请求并在新日志文件中观察对应事件确认连接；部分 query 值会被标为 `REDACTED`，不能再依赖随机 query 值的完整字符串匹配。检查请求路径、事件类型、outcome 和异常即可。

Worker 的 email 事件成功不等于已经读取 Gmail 收件箱。也不能只看路由汇总的一条 `dropped` 就断言整个处理失败：应结合对应会话的 Worker 保存、转发子事件及错误信息判断。

## 界面显示已发送，但缺少最终 delivered/bounced

Resend 发送 API 成功只表明请求被接受。最终状态需提供商事件或收件方确认。上游包含 `/api/webhooks` 接收入口，但本次遵守保留 Resend 配置的要求，没有新增 Webhook；签名验证及真实事件回填仍待单独验收。不要把“未配置回调”误诊为“发信功能没有实现”。
