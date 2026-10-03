import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dimensions } from './questions.js';
import { advance } from './engine.js';
import { AbuseGuard, settingsFromEnv } from './abuse.js';
import { makeCaptcha } from './captcha.js';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), settings = settingsFromEnv(), captchaGenerator = makeCaptcha, config = { baseUrl: process.env.AI_BASE_URL || 'https://api.deepseek.com/v1', model: process.env.AI_MODEL || 'deepseek-chat', apiKey: process.env.AI_API_KEY || '' } } = {}) {
  const guard = new AbuseGuard(dataDir, settings), options = guard.settings;
  const file = id => path.join(dataDir, id);
  async function save(filename, value) { const temp = `${filename}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temp, filename); }
  async function project(session) {
    // SQLite is authoritative. Projection errors do not turn committed answers into retries.
    try {
      await mkdir(file(session.id), { recursive: true, mode: 0o700 });
      await save(path.join(file(session.id), 'session.json'), session);
      for (const r of session.records) await save(path.join(file(session.id), `${r.dimension}.json`), r);
    } catch { console.error('Cannot update interview JSON files; authoritative records remain in SQLite. Check disk permissions/space.'); }
  }
  function fresh(index) { return { dimension: dimensions[index].id, entries: [], currentQuestion: dimensions[index].questions[0], complete: false }; }
  function view(session, visitor) {
    const records = session.records;
    const state = { id: session.id, complete: session.complete, dimensionIndex: session.dimensionIndex, totalAnswers: records.reduce((sum, r) => sum + r.entries.length, 0), completedDimensions: records.filter(r => r.complete).map(r => r.dimension), createdAt: session.createdAt, limits: guard.limits(visitor) };
    if (!session.complete) { const r = records[session.dimensionIndex]; state.current = { dimension: r.dimension, entries: r.entries, question: r.currentQuestion, answerCount: r.entries.length }; }
    else state.result = { type: records.map(r => r.judgment.letter).join(''), uncertain: records.some(r => r.uncertain), dimensions: records.map(r => ({ dimension: r.dimension, count: r.entries.length, uncertain: r.uncertain, ...r.judgment, nextQuestion: undefined })) };
    return state;
  }
  async function body(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 20000) throw Object.assign(new Error('请求内容过长。'), { status: 413 }); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('请求格式无效。'), { status: 400 }); }
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const origin = options.publicOrigin || `http://${req.headers.host}`;
      if (options.publicOrigin && req.headers.host !== new URL(origin).host) return send(403, { error: '访问来源不允许。' });
      if (req.method === 'POST' && ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site')) return send(403, { error: '不允许跨站请求。' });
      if (url.pathname.startsWith('/api/')) {
        const visitor = guard.identity(req, res), counts = guard.rate(visitor);
        guard.enforceRate(counts);
        if (req.method === 'GET' && url.pathname === '/api/status') return send(200, { configured: Boolean(config.apiKey), model: config.model, limits: guard.limits(visitor) });
        if (req.method === 'GET' && url.pathname === '/api/captcha') {
          const { code, image } = captchaGenerator(); guard.challenge(visitor, code);
          return send(200, { image, expiresIn: 300 });
        }
        if (req.method === 'POST' && url.pathname === '/api/captcha/verify') { const input = await body(req); guard.verify(visitor, input.code); return send(200, { verified: true }); }
        if (req.method === 'POST' && guard.requiresCaptcha(visitor, counts)) return send(403, { error: '操作较频繁，请完成验证码后继续。', captchaRequired: true });
        if (req.method === 'POST' && url.pathname === '/api/sessions') {
          if (!config.apiKey) return send(503, { error: '模型服务尚未配置，请联系网站管理员。' });
          const id = randomUUID(), session = { id, createdAt: new Date().toISOString(), dimensionIndex: 0, complete: false, records: [fresh(0)], model: config.model };
          guard.create(visitor, session); await project(session); return send(201, view(session, visitor));
        }
        const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})(\/answers|\/export)?$/);
        if (match) {
          const [, id, action] = match;
          if (req.method === 'GET') {
            const session = guard.get(visitor, id);
            if (action === '/export') { if (!session.complete) return send(409, { error: '访谈完成后才能导出完整记录。' }); res.setHeader('Content-Disposition', 'attachment; filename="realMBTI-report.json"'); return send(200, session); }
            if (!action) return send(200, view(session, visitor));
          }
          if (req.method === 'POST' && action === '/answers') {
            // Check ownership before acquiring the shared database lock.
            guard.get(visitor, id); guard.lock(id);
            let reservation, actual;
            try {
              const input = await body(req), session = guard.get(visitor, id);
              if (session.complete) return send(409, { error: '本次访谈已完成。' });
              const record = session.records[session.dimensionIndex];
              if (input.dimension !== record.dimension || input.question !== record.currentQuestion || input.answerCount !== record.entries.length) return send(409, { error: '问题进度已变化，请刷新后继续。' });
              if (typeof input.answer !== 'string' || !input.answer.trim() || Array.from(input.answer).length > options.maxAnswerChars) return send(400, { error: `请输入 1–${options.maxAnswerChars} 字的回答。` });
              const requestConfig = { ...config, maxOutputTokens: options.maxOutputTokens,
                beforeRequest: amount => { reservation = guard.reserve(visitor, id, amount); },
                onUsage: used => { actual = used; } };
              const next = await advance(session, record, input.answer.trim(), requestConfig);
              session.records[session.dimensionIndex] = next;
              if (next.complete) { if (session.dimensionIndex === 3) session.complete = true; else { session.dimensionIndex++; session.records.push(fresh(session.dimensionIndex)); } }
              guard.commit(visitor, session);
              if (reservation) { guard.settle(reservation, actual); reservation = undefined; }
              await project(session); return send(200, view(session, visitor));
            } finally { try { if (reservation) guard.settle(reservation, actual); } finally { guard.unlock(id); } }
          }
        }
        return send(404, { error: '接口不存在。' });
      }
      if (req.method === 'GET' && ['/', '/app.js', '/styles.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1), content = await readFile(path.join(root, 'public', name));
        res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css' : 'text/javascript', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); return res.end(content);
      }
      send(404, { error: '页面不存在。' });
    } catch (error) {
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      send(error.status || 502, { error: error.name === 'TimeoutError' ? '模型响应超时，回答尚未提交。请重试（重试计入额度）。' : error.status || !['SQLITE_ERROR','ERR_SQLITE_ERROR'].includes(error.code) ? error.message || '服务暂时不可用。' : '服务暂时不可用，请稍后再试。' });
    }
  });
  server.requestTimeout = 70000; server.headersTimeout = 15000;
  server.on('close', () => guard.close());
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.listen(port, '127.0.0.1', () => console.log(`realMBTI → http://localhost:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    app.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 75000).unref();
  });
}
