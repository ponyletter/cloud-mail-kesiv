# 从零部署与维护

本指南对应上游 `maillab/cloud-mail` 的 `f406890090a436a52be11d455e171b074fb8fcab`，结合本次部署实测整理。官方文档会更新，升级前同时阅读[命令部署](https://docs.skymail.ink/deployment/command)、[Resend](https://docs.skymail.ink/sending/resend)、[邮件转发](https://docs.skymail.ink/system/forward)。

示例使用 `example.com` 邮箱域名和 `email.example.com` 网站域名。所有 ID、邮箱和密码须替换为自己的值。生产实测结果见 [TESTING.md](TESTING.md)，故障处理见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## 1. 准备工具和私有配置

本次使用 Node 22.23.2、Python 3、Corepack/pnpm、Wrangler 4.90。新环境优先使用兼容的 Linux/Node；旧系统本地 workerd 的限制见排查文档。模拟测试依赖内置 `node:sqlite`，建议使用本次版本或兼容的更新版本。

```bash
git clone https://github.com/ponyletter/cloud-mail-kesiv.git
cd cloud-mail-kesiv
git remote add upstream https://github.com/maillab/cloud-mail.git
corepack pnpm --version
corepack pnpm --dir mail-worker install --frozen-lockfile
corepack pnpm --dir mail-vue install --frozen-lockfile
```

在仓库外创建配置目录，使用编辑器创建 `~/.config/cloud-mail/deploy.env`，目录权限 `700`、文件权限 `600`。填入真实值时不要开启 shell 的命令回显：

```bash
umask 077
mkdir -p "$HOME/.config/cloud-mail"
```

私有环境文件内容：

```dotenv
CLOUDFLARE_API_TOKEN='REPLACE_WITH_CURRENT_TOKEN'
CLOUDFLARE_ACCOUNT_ID='REPLACE_WITH_ACCOUNT_ID'
RESEND_API_KEY='REPLACE_WITH_SENDING_KEY'
EMAIL_DOMAIN='example.com'
ADMIN_EMAIL='admin@example.com'
ADMIN_PASSWORD='SET_A_RANDOM_PASSWORD'
APP_URL='https://REPLACE_WITH_WORKER_HOST'
FORWARD_EMAIL='verified@example.net'
```

管理员密码为 6–30 字符，使用独立随机密码。没有转发需求可将 `FORWARD_EMAIL` 留空，并删除示例配置中的 `forward` binding。

```bash
chmod 700 "$HOME/.config/cloud-mail"
chmod 600 "$HOME/.config/cloud-mail/deploy.env"
set -a
source "$HOME/.config/cloud-mail/deploy.env"
set +a
```

Cloudflare Token 的资源范围必须覆盖目标账户与域名。按实际操作授予 D1、KV、R2、Workers Scripts、DNS、Email Routing Rules 的写入权限，以及相关账户/Zone 查询权限；自定义域与转发地址管理还需其对应 endpoint 要求的权限。`active` 只表示 Token 有效，不能证明所有资源都有写权限。

先检查同一 Token、Account 和域名：

```bash
python3 deployment/diagnose-cloudflare.py \
  --env-file "$HOME/.config/cloud-mail/deploy.env" \
  --domain "$EMAIL_DOMAIN" \
  --check-wrangler
```

这是只读检查。需要验证创建权限时才加 `--test-create --database-name cloud-mail-db`，它会创建指定的真实数据库。报告默认写入私有配置目录，不应公开发布。

## 2. 盘点旧业务，再创建独立资源

先在 Cloudflare 核对域名所属账户、Workers、D1、KV、R2、DNS、现有 MX、Email Routing 精确规则、Catch-all 和已验证转发地址。记录原规则 ID、优先级与动作。复用已有本项目资源时先核对 ID；不要仅凭同名重建或覆盖。

新资源可以用控制台创建，或在 `mail-worker` 中运行：

```bash
cd mail-worker
corepack pnpm exec wrangler d1 create cloud-mail-db
corepack pnpm exec wrangler kv namespace create cloud-mail-kv
corepack pnpm exec wrangler r2 bucket create cloud-mail-attachments
cd ..
```

保留返回的 D1/KV ID。R2 使用 Standard；其免费额度与账户其他桶共享。若账户提示开通计费，先确认计划和费用。此部署不依赖 Workers AI 或 Cloudflare 付费外发。

复制模板：

```bash
cp deployment/wrangler.example.toml deployment/wrangler.production.toml
```

填写自己的 Account ID、资源 ID、域名、管理员地址、已验证转发地址。`main` 保持 `./worker-entry.js`；`db`、`kv`、`r2`、`assets` binding 名称不能改。生产配置被 Git 忽略。

首次暂不打开自定义域和 Catch-all，`setup_mode` 保持 `"true"`。每小时 cron 配合源码中的 UTC 0 点检查重置每日发信计数，不等同于每小时重置。

## 3. 构建、上传密钥并关闭公众初始化窗口

仅新安装时生成密钥；已有服务必须沿用已有 JWT 密钥，否则会使原会话失效：

```bash
python3 - <<'PY'
from pathlib import Path
import json, os, secrets
p = Path.home() / '.config/cloud-mail/runtime-secrets.json'
data = {'jwt_secret': secrets.token_hex(32), 'setup_secret': secrets.token_hex(32)}
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(data, f)
print('Private runtime secrets created.')
PY
corepack pnpm --dir mail-vue run build
cd mail-worker
corepack pnpm exec wrangler deploy \
  --config ../deployment/wrangler.production.toml \
  --secrets-file "$HOME/.config/cloud-mail/runtime-secrets.json" --minify
cd ..
```

前端输出到 `mail-worker/dist`，与 Worker 一起部署。把返回的 workers.dev 地址写入私有环境文件的 `APP_URL`，重新加载该环境文件。

`setup_mode=true` 时公众访问返回 503；初始化调用还需 `X-Cloud-Mail-Setup` 私有请求头。包装保留官方 `email` 和 `scheduled` handler。

## 4. 初始化空数据库、注册管理员、设置普通角色

以下只用于首次空数据库部署。不要在已有生产数据库上重复初始化来排查普通收发故障。脚本从私有文件和环境取值，不打印密钥或完整初始化 URL：

```bash
python3 - <<'PY'
import json, os, urllib.request, urllib.error
from pathlib import Path
secrets = json.loads((Path.home()/'.config/cloud-mail/runtime-secrets.json').read_text())
origin = os.environ['APP_URL'].rstrip('/')
session = None
def call(path, method='GET', body=None, plain=False):
    headers = {'User-Agent': 'Mozilla/5.0 CloudMailSetup/1.0',
               'X-Cloud-Mail-Setup': secrets['setup_secret']}
    if session: headers['Authorization'] = session
    if body is not None: headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(origin+'/api'+path, method=method,
        headers=headers, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(request, timeout=60) as response: raw=response.read()
    except urllib.error.HTTPError as error:
        raise SystemExit('Bootstrap HTTP '+str(error.code)+'; check private configuration.') from None
    if plain: return raw.decode()
    result=json.loads(raw)
    if result.get('code') != 200:
        raise SystemExit('Bootstrap application error '+str(result.get('code')))
    return result.get('data')
assert call('/init/'+secrets['jwt_secret'], plain=True) == 'success'
credentials={'email':os.environ['ADMIN_EMAIL'], 'password':os.environ['ADMIN_PASSWORD']}
call('/register', 'POST', credentials)
session=call('/login', 'POST', credentials)['token']
forward=os.environ.get('FORWARD_EMAIL', '')
call('/setting/set', 'PUT', {
    'register':1, 'registerVerify':1, 'addEmailVerify':1,
    'send':0, 'receive':0, 'addEmail':0, 'manyEmail':0, 'aiCode':1,
    'forwardStatus':0 if forward else 1, 'forwardEmail':forward,
    'resendTokens':{os.environ['EMAIL_DOMAIN']:os.environ['RESEND_API_KEY']},
})
role=next(r for r in call('/role/list') if r['isDefault']==1)
fields=['roleId','name','permIds','banEmail','availDomain','accountCount']
change={key:role[key] for key in fields}
change.update({'sendType':'day','sendCount':20})
call('/role/set', 'PUT', change)
print('Administrator and ordinary-user limits configured; public registration remains closed.')
PY
```

应用 API 的 `Authorization` 直接放登录返回的 JWT，**不加 Bearer**；Cloudflare 和 Resend API 则使用 Bearer。应用可能 HTTP 200 但返回 JSON `code=403`，必须同时判断业务码。

## 5. 打开站点，接入域名、收信与转发

把私有生产配置的 `setup_mode` 改为 `"false"`。添加自己的 `routes` 自定义域配置，再部署：

```bash
cd mail-worker
corepack pnpm exec wrangler deploy --config ../deployment/wrangler.production.toml --minify
cd ..
```

`keep_vars=true` 与已有 Worker secrets 配合保留密钥。新域名应无其他业务；已有网站记录不要覆盖。确认 HTTPS 首页、静态资源和管理员登录正常。

邮件链路按顺序配置：

1. **Resend 外发**：验证发件域名，DNS 内容以 Resend 当前控制台为准。Sending access Key 足够发送，读取投递详情需要其他权限。本方案用 Cloudflare 收信，不启用另一套冲突的根域接收 MX。
2. **Cloudflare Email Routing**：已有可用 MX 保留。全新域按 Cloudflare 提供的记录配置；修改旧 MX 前先确认现有邮件服务的迁移方案。
3. **Gmail 转发目标**：先在 Cloudflare 验证目标地址，并核对 Worker 的 `forward` binding。系统设置中的转发开关为 `0=开启`、`1=关闭`。
4. **Catch-all**：在 Email Routing → Routing Rules 将 Catch-all 设为启用，动作选择 Worker，目标为本项目 Worker。这样新注册邮箱无需逐个建规则。API 对应 `PUT /zones/{zone_id}/email/routing/rules/catch_all`，动作是 `worker`、匹配器是 `all`；参阅[官方 API](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/subresources/catch_alls/methods/update/)。
5. **旧精确转发地址接入站内**：先创建对应独立用户并验证登录，再将原规则的动作由直接转发改为本 Worker，保留规则 ID、地址和优先级。确认 Worker 会保存并转发到原 Gmail 目标。仅启用 Catch-all 不会接管仍直接转发的精确规则。

当前转发是全局设置。如果开启，全体用户来信都可能同时转发到配置的目标；如果只需要指定地址转发，使用系统转发规则限制范围并单独验收。

管理员在系统设置开启公众注册，在普通角色中确认 `email:send`、`sendType=day`、`sendCount=20`、域名允许范围及收信黑名单。每用户每日 20 封仍受 Resend 账户总额度限制。

## 6. 验收新注册用户，而不只验管理员

1. 首页和静态文件 HTTP 200；公开访问 `/api/init/probe` 返回 404。
2. 重新注册普通用户，登录确认没有 `*` 管理员权限。
3. 向真实站外邮箱发信，检查应用 JSON 业务码和 Resend 邮件 ID；最终投递需收件方或提供商事件确认。
4. 从站外邮箱向该新用户发信，确认没有为它创建精确规则，仍可通过 Catch-all 收到。
5. 用该用户自己的会话读取收件箱，核对 D1 的 user/account 归属；带附件收信后下载并比对 SHA-256。
6. 对旧转发地址重做外部来信测试，检查 Worker 邮件事件和转发错误；如能访问 Gmail，再确认最终收件。

可在 `mail-worker` 中运行 `corepack pnpm exec wrangler tail <worker-name> --format json`。日志可能含认证请求头或邮件数据，应重定向到权限 600 的私有文件，仅对外分享脱敏结论。

## 7. 后续维护与升级

```bash
git fetch upstream
git log --oneline HEAD..upstream/main
# 审阅差异后再合并/变基；不要自动把上游最新版本直接发布到生产。
```

本分支固定了本次已测基线，上游之后的新提交不自动合入。先备份数据库并在隔离环境检查迁移，再构建、运行 [TESTING.md](TESTING.md) 中的检查，最后用已有生产配置手动部署。JWT 密钥、D1/KV/R2 ID、Catch-all 和原精确规则都应继续保留。

本仓库 `.github/reference/verify.yml` 是**只构建和测试**的工作流模板；上游部署流程也保存在该目录。当前 OAuth 凭据缺少 `workflow` 权限，GitHub 曾拒绝上传启用中的工作流，因此当前没有启用 Actions。后续经账户持有人配置相应权限后，可把验证模板移入 `.github/workflows/`。生产继续手动部署，本分支入口与初始化保护需要独立适配，不能直接启用旧部署流程。

API Key、管理员密码及账号密码保存在本机私有文件，公开仓库只含模板。需要公开 Issue 时仅附状态码、业务码、脱敏时间线和必要错误信息。
