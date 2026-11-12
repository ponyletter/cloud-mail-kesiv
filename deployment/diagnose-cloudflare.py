#!/usr/bin/env python3
"""Compare raw curl D1 requests using one private-file credential source.

Never prints credentials. --test-create creates the intended D1 database only;
it does not modify DNS, email routing, Resend, or token permissions.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
from urllib.parse import quote

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--env-file', type=Path, required=True)
parser.add_argument('--domain', required=True, help='Zone name whose owning account must match')
parser.add_argument('--database-name', help='Intended database name, required with --test-create')
parser.add_argument('--expected-token-id')
parser.add_argument('--d1-only', action='store_true', help='For a D1-only control token; reuse the account ID already verified with the primary token')
parser.add_argument('--report', type=Path)
parser.add_argument('--test-create', action='store_true')
parser.add_argument('--check-wrangler', action='store_true')
args = parser.parse_args()
if args.test_create and not args.database_name:
    parser.error('--test-create requires --database-name')
repo = Path(__file__).resolve().parents[1]
credentials = {}
for line in args.env_file.read_text(encoding='utf-8-sig').splitlines():
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    if line.startswith('export '):
        line = line[7:]
    if '=' not in line:
        continue
    name, value = line.split('=', 1)
    name = name.strip()
    if name in credentials:
        raise SystemExit('Duplicate variable in private configuration: ' + name)
    parts = shlex.split(value, comments=True)
    if len(parts) > 1:
        raise SystemExit('Unexpected whitespace in private configuration value')
    credentials[name] = parts[0] if parts else ''

token = credentials['CLOUDFLARE_API_TOKEN']
account_id = credentials['CLOUDFLARE_ACCOUNT_ID']
if not token or any(c.isspace() for c in token):
    raise SystemExit('Token is empty or contains whitespace')
if not re.fullmatch(r'[a-f0-9]{32}', account_id):
    raise SystemExit('Account ID has an unexpected format')

def redact(text):
    for name in ['CLOUDFLARE_API_TOKEN', 'RESEND_API_KEY']:
        value = credentials.get(name)
        if value:
            text = text.replace(value, '[REDACTED]')
    return re.sub(r'(?:cfut_|cfat_|re_)[A-Za-z0-9_-]{15,}', '[REDACTED]', text)

def quoted(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'

# Authentication is passed to curl over stdin, never argv or an inherited env.
# -q disables .curlrc; the clean environment omits proxies and legacy API keys.
curl_env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8'}

def curl_request(path, method='GET', body=None):
    private_headers = args.env_file.parent / 'auth-curl-response-headers.txt'
    private_headers.touch(mode=0o600, exist_ok=True)
    private_headers.chmod(0o600)
    config = [
        'silent', 'show-error', 'connect-timeout = 10', 'max-time = 30',
        'request = ' + quoted(method),
        'url = ' + quoted('https://api.cloudflare.com/client/v4/' + path),
        'header = ' + quoted('Authorization: Bearer ' + token),
        'header = ' + quoted('Content-Type: application/json'),
        'header = ' + quoted('Accept: application/json'),
        'header = ' + quoted('User-Agent: cloud-mail-auth-diagnostic/1.0'),
        'dump-header = ' + quoted(str(private_headers)),
        'write-out = "\\n__HTTP_STATUS__:%{http_code}\\n"',
    ]
    if body is not None:
        config.append('data = ' + quoted(json.dumps(body, separators=(',', ':'))))
    result = subprocess.run(
        ['curl', '-q', '--config', '-'], input='\n'.join(config) + '\n',
        env=curl_env, text=True, capture_output=True, timeout=40,
    )
    response_text, separator, status_text = result.stdout.rpartition('\n__HTTP_STATUS__:')
    status = int(status_text.strip()) if separator else 0
    try:
        data = json.loads(response_text)
    except json.JSONDecodeError:
        data = {'error': 'Non-JSON response', 'curl_error': redact(result.stderr.strip())}
    ray = None
    for line in private_headers.read_text(errors='replace').splitlines():
        if line.lower().startswith('cf-ray:'):
            ray = line.split(':', 1)[1].strip()
    return {'http_status': status, 'curl_exit_code': result.returncode, 'cf_ray': ray, 'response': data}

report = {
    'checked_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'credential_source': str(args.env_file),
    'token_sha256_prefix': hashlib.sha256(token.encode()).hexdigest()[:12],
    'configured_account_id': account_id,
    'request_authentication': 'Exactly one Authorization: Bearer header',
    'curl_configuration_disabled': True,
    'curl_environment': 'Clean; no Cloudflare variables, legacy keys, or proxies',
    'checks': {},
}

def record(name, result):
    report['checks'][name] = result
    print(redact(json.dumps({'check': name, **result}, ensure_ascii=False)), flush=True)

record('verify', curl_request('user/tokens/verify'))
verified = report['checks']['verify']['response'].get('result') or {}
report['verified_token_id'] = verified.get('id')
report['expected_token_id'] = args.expected_token_id
report['expected_token_id_matches'] = (verified.get('id') == args.expected_token_id) if args.expected_token_id else None
if verified.get('status') != 'active':
    raise SystemExit('Token is not active; creation test was not attempted')
if args.expected_token_id and not report['expected_token_id_matches']:
    raise SystemExit('Token ID differs from the supplied dashboard ID; creation test was not attempted')

if args.d1_only:
    report['zone_account_matches'] = None
    report['zone_account_check'] = 'Skipped for D1-only control; account must match the prior primary-token report'
else:
    zone_result = curl_request('zones?name=' + quote(args.domain, safe=''))
    zones = zone_result['response'].get('result') or []
    zone_result['response']['result'] = [
        {key: zone.get(key) for key in ['id', 'name', 'account']} for zone in zones
    ]
    record('zone_account', zone_result)
    report['zone_account_matches'] = any(
        zone.get('name') == args.domain and zone.get('account', {}).get('id') == account_id
        for zone in zones
    )
    if not report['zone_account_matches']:
        raise SystemExit('Account does not match the supplied zone; creation test was not attempted')

record('d1_list', curl_request('accounts/' + account_id + '/d1/database?per_page=100'))
databases = report['checks']['d1_list']['response'].get('result') or []
if args.test_create:
    if any(db.get('name') == args.database_name for db in databases):
        record('d1_create', {'skipped': True, 'reason': 'Intended database already exists'})
    else:
        record('d1_create', curl_request('accounts/' + account_id + '/d1/database', 'POST', {'name': args.database_name}))

if args.check_wrangler:
    clean = dict(os.environ)
    for name in list(clean):
        if name.startswith(('CLOUDFLARE_', 'CF_', 'WRANGLER_')) or name in ['NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']:
            clean.pop(name, None)
    clean.update({'CLOUDFLARE_API_TOKEN': token, 'CLOUDFLARE_ACCOUNT_ID': account_id, 'WRANGLER_SEND_METRICS': 'false'})
    result = subprocess.run(['corepack', 'pnpm', 'exec', 'wrangler', 'whoami'], cwd=repo/'mail-worker', env=clean, capture_output=True, text=True, timeout=60)
    record('wrangler_whoami', {'exit_code': result.returncode, 'output': redact(result.stdout + result.stderr)})

output = args.report or args.env_file.parent / 'cloudflare-auth-diagnostic.json'
with open(output, 'w', encoding='utf-8', opener=lambda path, flags: os.open(path, flags, 0o600)) as handle:
    os.fchmod(handle.fileno(), 0o600)
    handle.write(redact(json.dumps(report, ensure_ascii=False, indent=2)) + '\n')
print('Sanitized report saved: ' + str(output), flush=True)
