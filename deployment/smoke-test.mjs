// Runs the bundled upstream Worker against in-memory service adapters.
// This does not contact Cloudflare, send email, or create a production account.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { default as worker } from './build/worker-entry.js';

globalThis.fetch = async () => {
  throw new Error('External network is disabled during local smoke tests');
};

const sqlite = new DatabaseSync(':memory:');
const checks = [];
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.map(String).join(' '));

class PreparedStatement {
  constructor(sql, params = []) {
    this.sql = sql;
    this.params = params.map(value => value === undefined ? null : value);
  }
  bind(...params) { return new PreparedStatement(this.sql, params); }
  execute(arrays = false) {
    const statement = sqlite.prepare(this.sql);
    const hasRows = statement.columns().length > 0;
    if (arrays) statement.setReturnArrays(true);
    if (hasRows) return { success: true, results: statement.all(...this.params) };
    const result = statement.run(...this.params);
    return {
      success: true, results: [],
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }
  async all() { return this.execute(); }
  async raw() { return this.execute(true).results; }
  async run() { return this.execute(); }
  async first(column) {
    const row = this.execute().results[0];
    return row ? (column ? row[column] : row) : null;
  }
}

class MemoryKV {
  values = new Map();
  async put(key, value) { this.values.set(key, value); }
  async get(key, options) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return (options === 'json' || options?.type === 'json') ? JSON.parse(value) : value;
  }
  async delete(key) { this.values.delete(key); }
}

class MemoryR2 {
  values = new Map();
  async put(key, body, options = {}) {
    this.values.set(key, { body: await new Response(body).arrayBuffer(), ...options });
  }
  async get(key) {
    const value = this.values.get(key);
    if (!value) return null;
    return { ...value, body: value.body.slice(0), arrayBuffer: async () => value.body.slice(0) };
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }
}

const env = {
  db: {
    prepare: sql => new PreparedStatement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  },
  kv: new MemoryKV(), r2: new MemoryR2(),
  domain: ['example.test'], admin: 'admin@example.test',
  jwt_secret: randomBytes(32).toString('hex'), orm_log: false,
  setup_secret: randomBytes(32).toString('hex'), setup_mode: 'false',
  assets: { fetch: async () => new Response(await readFile(new URL('../mail-worker/dist/index.html', import.meta.url)), { headers: { 'Content-Type': 'text/html' } }) },
};
const ctx = { waitUntil() {} };
const origin = 'https://email.example.test';
const password = randomBytes(18).toString('base64url');
let token;

async function request(path, method = 'GET', body, setup = false) {
  const headers = { 'CF-Connecting-IP': '192.0.2.1' };
  if (setup) headers['X-Cloud-Mail-Setup'] = env.setup_secret;
  if (token) headers.Authorization = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(origin + '/api' + path, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, ctx);
}

async function api(path, method = 'GET', body) {
  const response = await request(path, method, body);
  const result = await response.json();
  assert.equal(result.code, 200, `${method} ${path}: ${result.message}`);
  return result.data;
}

try {
  env.setup_mode = 'true';
  assert.equal((await worker.fetch(new Request(origin), env, ctx)).status, 503);
  env.setup_mode = 'false';
  checks.push('setup_gate_blocks_public_requests');
  assert.equal((await request('/init/' + env.jwt_secret)).status, 404);
  checks.push('initialization_endpoint_requires_private_setup_header');
  const home = await worker.fetch(new Request(origin), env, ctx);
  assert.match(await home.text(), /<html/i);
  checks.push('frontend_asset_response');

  const wrongInit = await request('/init/incorrect-test-secret', 'GET', undefined, true);
  assert.match(await wrongInit.text(), /mismatch/);
  assert.equal(await (await request('/init/' + env.jwt_secret, 'GET', undefined, true)).text(), 'success');
  assert.ok(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 10);
  assert.ok(sqlite.prepare('PRAGMA table_info(email)').all().some(column => column.name === 'sender_email'));
  assert.ok(sqlite.prepare('PRAGMA table_info(setting)').all().some(column => column.name === 'webhook_secret'));
  checks.push('official_database_initialization_and_current_schema');

  await api('/register', 'POST', { email: env.admin, password });
  const login = await api('/login', 'POST', { email: env.admin, password });
  assert.ok(login.token);
  token = login.token;
  const profile = await api('/my/loginUserInfo');
  assert.equal(profile.email, env.admin);
  assert.deepEqual(profile.permKeys, ['*']);
  checks.push('admin_registration_login_and_permissions');

  const failedLogin = await (await request('/login', 'POST', { email: env.admin, password: 'incorrect-test-password' })).json();
  assert.notEqual(failedLogin.code, 200);
  checks.push('wrong_password_rejected');

  await api('/setting/set', 'PUT', {
    title: 'Kesiv Mail', send: 0, receive: 0, addEmail: 0, manyEmail: 0,
    aiCode: 1, addEmailVerify: 1, registerVerify: 1,
    forwardStatus: 1, forwardEmail: '',
  });
  const settings = await api('/setting/query');
  assert.equal(settings.storageType, 'R2');
  assert.equal(settings.hasCfEmail, false);
  checks.push('settings_and_r2_binding_selection');

  const account = await api('/account/add', 'POST', { email: 'smoke-test@example.test' });
  assert.ok(account.accountId);
  const attachmentText = 'Local attachment integrity check.\n';
  await api('/email/send', 'POST', {
    accountId: profile.account.accountId, receiveEmail: [account.email],
    subject: 'local-internal-smoke', text: 'Local internal delivery',
    content: '<p>Local internal delivery</p>', sendType: 'send',
    attachments: [{ filename: 'smoke.txt', type: 'text/plain', content: Buffer.from(attachmentText).toString('base64') }],
  });
  const delivered = sqlite.prepare("SELECT * FROM email WHERE subject = 'local-internal-smoke' AND type = 0").get();
  assert.equal(delivered.account_id, account.accountId);
  assert.equal(delivered.status, 0);
  checks.push('internal_email_delivery_without_external_provider');

  const attachments = await api('/email/attList?emailId=' + delivered.email_id);
  assert.equal(attachments.length, 1);
  const downloaded = await worker.fetch(new Request(origin + '/attachments/' + attachments[0].key.replace(/^attachments\//, '')), env, ctx);
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), attachmentText);
  checks.push('internal_attachment_storage_download_and_integrity');

  await api('/setting/set', 'PUT', { forwardStatus: 0, forwardEmail: 'verified@example.net' });
  const mime = [
    'From: Local Sender <sender@example.net>', 'To: ' + env.admin,
    'Subject: local-inbound-smoke', 'Message-ID: <local-smoke@example.net>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="smoke-boundary"', '',
    '--smoke-boundary', 'Content-Type: text/plain; charset=utf-8', '', 'Local inbound fixture.',
    '--smoke-boundary', 'Content-Type: text/plain; name="inbound.txt"',
    'Content-Disposition: attachment; filename="inbound.txt"', 'Content-Transfer-Encoding: base64', '',
    Buffer.from('Inbound attachment fixture.').toString('base64'), '--smoke-boundary--', '',
  ].join('\r\n');
  const forwarded = [];
  const rejected = [];
  await worker.email({
    from: 'sender@example.net', to: env.admin, raw: new Blob([mime]).stream(),
    forward: async destination => forwarded.push(destination),
    setReject: reason => rejected.push(reason),
  }, env, ctx);
  assert.deepEqual(rejected, []);
  assert.deepEqual(forwarded, ['verified@example.net']);
  const received = sqlite.prepare("SELECT * FROM email WHERE subject = 'local-inbound-smoke'").get();
  assert.equal(received.account_id, profile.account.accountId);
  assert.equal(received.status, 0);
  const inboundAttachments = await api('/email/attList?emailId=' + received.email_id);
  assert.equal(inboundAttachments.length, 1);
  const inboundFile = await worker.fetch(new Request(origin + '/' + inboundAttachments[0].key), env, ctx);
  assert.equal(await inboundFile.text(), 'Inbound attachment fixture.');
  checks.push('simulated_inbound_mime_and_attachment_processing');
  checks.push('inbound_forward_callback_to_existing_verified_address');

  await api('/setting/set', 'PUT', { register: 1 });
  const blockedRegistration = await (await request('/register', 'POST', {
    email: 'uninvited@example.test', password,
  })).json();
  assert.notEqual(blockedRegistration.code, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM user').get().n, 1);
  checks.push('registration_can_be_closed_after_admin_setup');

  // Exercise ordinary users too: the administrator bypasses role restrictions.
  const adminToken = token;
  await api('/setting/set', 'PUT', { register: 0, forwardStatus: 1 });
  const ordinaryEmail = 'ordinary-local@example.test';
  await api('/register', 'POST', { email: ordinaryEmail, password });
  token = (await api('/login', 'POST', { email: ordinaryEmail, password })).token;
  const ordinaryProfile = await api('/my/loginUserInfo');
  assert.ok(!ordinaryProfile.permKeys.includes('*'));
  const ordinarySend = {
    accountId: ordinaryProfile.account.accountId, receiveEmail: [env.admin],
    subject: 'ordinary-send-smoke', text: 'Ordinary user permission check',
    content: '<p>Ordinary user permission check</p>', sendType: 'send', attachments: [],
  };
  const roleBlockedSend = await (await request('/email/send', 'POST', ordinarySend)).json();
  assert.equal(roleBlockedSend.code, 403);
  checks.push('ordinary_default_role_reproduces_send_denial');

  sqlite.prepare("UPDATE role SET send_type = 'day', send_count = 20 WHERE role_id = ?")
    .run(ordinaryProfile.role.roleId);
  await api('/email/send', 'POST', ordinarySend);
  const ordinarySent = sqlite.prepare("SELECT * FROM email WHERE subject = 'ordinary-send-smoke' AND type = 1").get();
  assert.equal(ordinarySent.user_id, ordinaryProfile.userId);
  checks.push('ordinary_daily_role_allows_sending_without_admin_permission');

  const ordinaryToken = token;
  token = adminToken;
  await api('/setting/set', 'PUT', { forwardStatus: 0 });
  token = ordinaryToken;
  forwarded.length = 0;
  rejected.length = 0;
  const ordinaryMime = mime
    .replace('To: ' + env.admin, 'To: ' + ordinaryEmail)
    .replace('local-inbound-smoke', 'ordinary-inbound-smoke')
    .replace('local-smoke@example.net', 'ordinary-smoke@example.net');
  await worker.email({
    from: 'sender@example.net', to: ordinaryEmail, raw: new Blob([ordinaryMime]).stream(),
    forward: async destination => forwarded.push(destination),
    setReject: reason => rejected.push(reason),
  }, env, ctx);
  assert.deepEqual(rejected, []);
  assert.deepEqual(forwarded, ['verified@example.net']);
  const ordinaryReceived = sqlite.prepare("SELECT * FROM email WHERE subject = 'ordinary-inbound-smoke'").get();
  assert.ok(ordinaryReceived);
  assert.equal(ordinaryReceived.user_id, ordinaryProfile.userId);
  assert.equal(ordinaryReceived.account_id, ordinaryProfile.account.accountId);
  assert.equal(ordinaryReceived.status, 0);
  checks.push('ordinary_inbound_handler_ownership_and_forwarding');
  const ordinaryAttachments = await api('/email/attList?emailId=' + ordinaryReceived.email_id);
  assert.equal(ordinaryAttachments.length, 1);
  const ordinaryFile = await worker.fetch(new Request(origin + '/' + ordinaryAttachments[0].key), env, ctx);
  assert.equal(await ordinaryFile.text(), 'Inbound attachment fixture.');
  checks.push('ordinary_inbound_attachment_visibility_and_integrity');

  const report = {
    checked_at_utc: new Date().toISOString(), scope: 'local_in_memory_simulation',
    production_deployed: false, external_email_sent: false,
    tests_passed: checks, migration_warnings: warnings.length,
    migration_warning_messages: warnings,
    limitation: 'SQLite and in-memory KV/R2 adapters do not validate Cloudflare runtime, DNS, SMTP delivery, or real forwarding.',
  };
  await writeFile(new URL('./smoke-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  console.warn = originalWarn;
  sqlite.close();
}
