import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';

export const defaults = {
  visitorDailyTests: 1, ipDailyTests: 8, globalDailyTests: 500, ipDailyVisitors: 32, globalDailyVisitors: 10000,
  visitorDailyTokens: 250000, ipDailyTokens: 1500000, globalDailyTokens: 10000000,
  sessionModelCalls: 28, visitorDailyCalls: 28, ipDailyCalls: 224,
  globalConcurrency: 3, visitorRequestsPerMinute: 60, ipRequestsPerMinute: 180,
  captchaVisitorThreshold: 15, captchaIpThreshold: 60, captchaNewVisitors: 3,
  maxAnswerChars: 1000, maxOutputTokens: 2500, publicOrigin: '', trustProxy: false
};
export function settingsFromEnv(env = process.env) {
  const result = {};
  for (const key of Object.keys(defaults)) {
    const name = key.replace(/[A-Z]/g, x => `_${x}`).toUpperCase();
    if (env[name] !== undefined) result[key] = typeof defaults[key] === 'number' ? Number(env[name]) : typeof defaults[key] === 'boolean' ? env[name] === 'true' : env[name];
  }
  return result;
}
export function networkAddress(ip) {
  ip = ip.toLowerCase();
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) return ip.slice(7);
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) throw new Error('无法识别客户端网络地址。');
  // Normalize compressed IPv6 and aggregate rotating addresses by /64.
  if (ip.includes('.')) {
    const pos = ip.lastIndexOf(':'); const v4 = ip.slice(pos + 1).split('.').map(Number);
    ip = ip.slice(0, pos + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const [left, right] = ip.split('::'); const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  const groups = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  return groups.slice(0, 4).map(x => Number.parseInt(x, 16).toString(16).padStart(4, '0')).join(':') + '::/64';
}
const reject = (message, status = 429, extra = {}) => Object.assign(new Error(message), { status, ...extra });

export class AbuseGuard {
  constructor(dataDir, options = {}) {
    this.settings = { ...defaults, ...options };
    for (const [key, value] of Object.entries(this.settings)) if (typeof defaults[key] === 'number' && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${key} 必须为正整数。`);
    if (this.settings.publicOrigin && new URL(this.settings.publicOrigin).origin !== this.settings.publicOrigin) throw new Error('PUBLIC_ORIGIN 必须是完整来源，例如 http://203.0.113.10，不带末尾斜杠。');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dataDir, 'access.sqlite'));
    chmodSync(path.join(dataDir, 'access.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY, network TEXT NOT NULL, day TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (scope TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, starts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,day));
      CREATE TABLE IF NOT EXISTS windows (scope TEXT NOT NULL, minute INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 0, challenges INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,minute));
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, owner TEXT NOT NULL, network TEXT NOT NULL, day TEXT NOT NULL, amount INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (owner TEXT PRIMARY KEY, network TEXT NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS passes (owner TEXT NOT NULL, network TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(owner,network));`);
    this.db.exec('CREATE TABLE IF NOT EXISTS mutations (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get('secret');
    if (!row) this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('secret', randomBytes(32).toString('hex'));
    this.secret = this.db.prepare('SELECT value FROM meta WHERE key=?').get('secret').value;
    this.lastPrune = 0;
  }
  close() { this.db.close(); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  day() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); }
  hash(value) { return createHmac('sha256', this.secret).update(value).digest('hex'); }
  scopes(v) { return [`v:${v.id}`, `ip:${v.network}`, 'global']; }
  row(scope, day = this.day()) { this.db.prepare('INSERT OR IGNORE INTO usage(scope,day) VALUES (?,?)').run(scope, day); return this.db.prepare('SELECT * FROM usage WHERE scope=? AND day=?').get(scope, day); }
  prune() {
    if (Date.now() - this.lastPrune < 60000) return;
    this.lastPrune = Date.now();
    // Expired in-flight reservations remain fully charged after a crash: never refund unknown bills.
    this.db.prepare('DELETE FROM pending WHERE expires<?').run(Date.now());
    this.db.prepare('DELETE FROM mutations WHERE expires<?').run(Date.now());
    this.db.prepare('DELETE FROM windows WHERE minute<?').run(Math.floor(Date.now() / 60000) - 2);
    this.db.prepare('DELETE FROM challenges WHERE expires<?').run(Date.now());
    this.db.prepare('DELETE FROM passes WHERE expires<?').run(Date.now());
    const cutoff = new Date(Date.now() - 32 * 86400000).toISOString().slice(0, 10);
    this.db.prepare('DELETE FROM usage WHERE day<?').run(cutoff);
  }
  identity(req, res) {
    this.prune();
    let address = req.socket.remoteAddress;
    if (this.settings.trustProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
      const forwarded = req.headers['x-real-ip'];
      if (typeof forwarded !== 'string' || !isIP(forwarded)) throw reject('代理配置错误。', 400);
      address = forwarded;
    }
    const network = this.hash(networkAddress(address));
    const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('mbti_visitor='))?.slice(13);
    let id;
    if (cookie && /^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(cookie)) {
      const [candidate, sig] = cookie.split('.');
      if (timingSafeEqual(Buffer.from(sig), Buffer.from(this.hash(`cookie:${candidate}`))) && this.db.prepare('SELECT id FROM visitors WHERE id=?').get(candidate)) id = candidate;
    }
    if (!id) {
      this.tx(() => {
        if (this.db.prepare('SELECT COUNT(*) AS count FROM visitors WHERE network=? AND day=?').get(network, this.day()).count >= this.settings.ipDailyVisitors || this.db.prepare('SELECT COUNT(*) AS count FROM visitors WHERE day=?').get(this.day()).count >= this.settings.globalDailyVisitors) throw reject('今天的新访客额度已用完，请明天再来。');
        id = randomUUID(); this.db.prepare('INSERT INTO visitors VALUES (?,?,?)').run(id, network, this.day());
      });
      const secure = this.settings.publicOrigin.startsWith('https:');
      res.setHeader('Set-Cookie', `mbti_visitor=${id}.${this.hash(`cookie:${id}`)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`);
    }
    return { id, network };
  }
  rate(v) {
    const minute = Math.floor(Date.now() / 60000);
    return this.tx(() => {
      const values = [];
      for (const scope of this.scopes(v).slice(0, 2)) {
        this.db.prepare('INSERT OR IGNORE INTO windows(scope,minute) VALUES (?,?)').run(scope, minute);
        this.db.prepare('UPDATE windows SET requests=requests+1 WHERE scope=? AND minute=?').run(scope, minute);
        // Count two buckets so a minute boundary does not give a sudden reset.
        values.push(this.db.prepare('SELECT SUM(requests) AS count FROM windows WHERE scope=? AND minute>=?').get(scope, minute - 1).count);
      }
      return values;
    });
  }
  enforceRate(counts) {
    if (counts[0] > this.settings.visitorRequestsPerMinute || counts[1] > this.settings.ipRequestsPerMinute) throw reject('操作太频繁，请两分钟后再试。', 429, { retryAfter: 120 });
  }
  requiresCaptcha(v, counts) {
    const pass = this.db.prepare('SELECT expires FROM passes WHERE owner=? AND network=?').get(v.id, v.network);
    if (pass?.expires > Date.now()) return false;
    const newVisitors = this.db.prepare('SELECT COUNT(*) AS count FROM visitors WHERE network=? AND day=?').get(v.network, this.day()).count;
    return counts[0] > this.settings.captchaVisitorThreshold || counts[1] > this.settings.captchaIpThreshold || newVisitors > this.settings.captchaNewVisitors;
  }
  challenge(v, code) {
    const minute = Math.floor(Date.now() / 60000), scope = `ip:${v.network}`;
    const recent = this.db.prepare('SELECT COALESCE(SUM(challenges),0) AS count FROM windows WHERE scope=? AND minute>=?').get(scope, minute - 1).count;
    if (recent >= 5) throw reject('验证码请求太频繁，请两分钟后再试。', 429, { retryAfter: 120 });
    this.db.prepare('INSERT OR IGNORE INTO windows(scope,minute) VALUES (?,?)').run(scope, minute);
    this.db.prepare('UPDATE windows SET challenges=challenges+1 WHERE scope=? AND minute=?').run(scope, minute);
    this.db.prepare('INSERT OR REPLACE INTO challenges VALUES (?,?,?,?,0)').run(v.id, v.network, this.hash(`captcha:${v.id}:${code.toUpperCase()}`), Date.now() + 300000);
  }
  verify(v, code) {
    const c = this.db.prepare('SELECT * FROM challenges WHERE owner=?').get(v.id);
    if (!c || c.network !== v.network || c.expires < Date.now() || c.tries >= 3) throw reject('验证码已过期或尝试次数过多，请换一张。', 400);
    this.db.prepare('UPDATE challenges SET tries=tries+1 WHERE owner=?').run(v.id);
    if (typeof code !== 'string' || !/^[2-9]{6}$/.test(code) || !timingSafeEqual(Buffer.from(c.digest), Buffer.from(this.hash(`captcha:${v.id}:${code}`)))) throw reject('验证码不正确，请重试。', 400);
    this.db.prepare('DELETE FROM challenges WHERE owner=?').run(v.id);
    this.db.prepare('INSERT OR REPLACE INTO passes VALUES (?,?,?)').run(v.id, v.network, Date.now() + 1800000);
  }
  limits(v) {
    const r = this.row(`v:${v.id}`);
    return { remainingTests: Math.max(0, this.settings.visitorDailyTests - r.starts), remainingTokens: Math.max(0, this.settings.visitorDailyTokens - r.tokens), resetTimezone: 'Asia/Shanghai', maxAnswerChars: this.settings.maxAnswerChars };
  }
  create(v, session) {
    this.tx(() => {
      const day = this.day();
      const limits = [this.settings.visitorDailyTests, this.settings.ipDailyTests, this.settings.globalDailyTests];
      this.scopes(v).forEach((scope, i) => { if (this.row(scope, day).starts >= limits[i]) throw reject(i === 0 ? '你今天已开始过一次探索，可继续已有访谈，明天再开始新的。' : i === 1 ? '这个网络今天的新测试额度已用完，请明天再来。' : '今天网站的新测试额度已用完，请明天再来。'); });
      this.scopes(v).forEach(scope => this.db.prepare('UPDATE usage SET starts=starts+1 WHERE scope=? AND day=?').run(scope, day));
      this.db.prepare('INSERT INTO sessions(id,owner,payload) VALUES (?,?,?)').run(session.id, v.id, JSON.stringify(session));
    });
  }
  get(v, id) {
    const r = this.db.prepare('SELECT payload FROM sessions WHERE id=? AND owner=?').get(id, v.id);
    if (!r) throw reject('找不到属于当前浏览器的访谈。请使用原来的浏览器继续。', 404);
    return JSON.parse(r.payload);
  }
  commit(v, session) { this.db.prepare('UPDATE sessions SET payload=? WHERE id=? AND owner=?').run(JSON.stringify(session), session.id, v.id); }
  lock(id) {
    this.db.prepare('DELETE FROM mutations WHERE id=? AND expires<?').run(id, Date.now());
    const result = this.db.prepare('INSERT OR IGNORE INTO mutations VALUES (?,?)').run(id, Date.now() + 120000);
    if (!result.changes) throw reject('上一个回答正在处理，请稍候。', 409);
  }
  unlock(id) { this.db.prepare('DELETE FROM mutations WHERE id=?').run(id); }
  reserve(v, sessionId, amount) {
    return this.tx(() => {
      const scopes = this.scopes(v), day = this.day(), settings = this.settings;
      const tokens = [settings.visitorDailyTokens, settings.ipDailyTokens, settings.globalDailyTokens];
      const calls = [settings.visitorDailyCalls, settings.ipDailyCalls, Number.MAX_SAFE_INTEGER];
      scopes.forEach((scope, i) => { const r = this.row(scope, day); if (r.tokens + amount > tokens[i] || r.calls >= calls[i]) throw reject(i === 0 ? '你今天的分析额度已用完，请明天继续。' : i === 1 ? '这个网络今天的分析额度已用完，请明天继续。' : '网站今天的分析额度已用完，请明天继续。'); });
      const session = this.db.prepare('SELECT attempts FROM sessions WHERE id=? AND owner=?').get(sessionId, v.id);
      if (!session || session.attempts >= settings.sessionModelCalls) throw reject('本次访谈的分析次数已用完，失败重试也计入次数。');
      if (this.db.prepare('SELECT COUNT(*) AS count FROM pending').get().count >= settings.globalConcurrency) throw reject('大家正在同时分析，请稍候重试。', 429, { retryAfter: 5 });
      if (this.db.prepare('SELECT id FROM pending WHERE owner=?').get(v.id)) throw reject('你有一个回答正在分析，请稍候。', 409);
      scopes.forEach(scope => this.db.prepare('UPDATE usage SET tokens=tokens+?, calls=calls+1 WHERE scope=? AND day=?').run(amount, scope, day));
      this.db.prepare('UPDATE sessions SET attempts=attempts+1 WHERE id=?').run(sessionId);
      const id = randomUUID(); this.db.prepare('INSERT INTO pending VALUES (?,?,?,?,?,?)').run(id, v.id, v.network, day, amount, Date.now() + 120000);
      return id;
    });
  }
  settle(id, actual) {
    this.tx(() => {
      const r = this.db.prepare('SELECT * FROM pending WHERE id=?').get(id); if (!r) return;
      // Missing usage, timeout and errors retain the full reservation conservatively.
      const amount = Number.isSafeInteger(actual) && actual >= 0 ? actual : r.amount;
      this.scopes({ id: r.owner, network: r.network }).forEach(scope => this.db.prepare('UPDATE usage SET tokens=tokens+? WHERE scope=? AND day=?').run(amount - r.amount, scope, r.day));
      this.db.prepare('DELETE FROM pending WHERE id=?').run(id);
    });
  }
}
