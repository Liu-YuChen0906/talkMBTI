import http from 'node:http';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dimensions } from './questions.js';
import { analyze, revision, needsAnalysis, refreshProgress } from './engine.js';
import { AbuseGuard, settingsFromEnv } from './abuse.js';
import { makeCaptcha } from './captcha.js';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), settings = settingsFromEnv(), captchaGenerator = makeCaptcha, config = { baseUrl: process.env.AI_BASE_URL || 'https://api.deepseek.com/v1', model: process.env.AI_MODEL || 'deepseek-chat', apiKey: process.env.AI_API_KEY || '' } } = {}) {
  const guard = new AbuseGuard(dataDir, settings), options = guard.settings;
  const file = id => path.join(dataDir, id);
  async function save(filename, value) { const temp = `${filename}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temp, filename); }
  const projections = new Map();
  function project(session) {
    const task = (projections.get(session.id) || Promise.resolve()).then(() => writeProjection(session));
    projections.set(session.id, task);
    task.finally(() => { if (projections.get(session.id) === task) projections.delete(session.id); });
    return task;
  }
  async function writeProjection(session) {
    // SQLite is authoritative. Projection errors do not turn committed answers into retries.
    try {
      if (session.discarded) { await rm(file(session.id), { recursive: true, force: true }); return; }
      await mkdir(file(session.id), { recursive: true, mode: 0o700 });
      await save(path.join(file(session.id), 'session.json'), session);
      for (const r of session.records) await save(path.join(file(session.id), `${r.dimension}.json`), r);
    } catch { console.error('Cannot update interview JSON files; authoritative records remain in SQLite. Check disk permissions/space.'); }
  }
  function fresh(index) { return { dimension: dimensions[index].id, entries: [], currentQuestion: dimensions[index].questions[0], complete: false }; }
  function load(visitor, id) {
    const session = guard.get(visitor, id);
    if (session.discarded) throw Object.assign(new Error('这次探索已清空，请继续新的探索。'), { status: 409 });
    if (session.version !== 3) {
      if (session.complete) { session.answersLocked = true; session.legacyFinalized = true; }
      for (const r of session.records) {
        r.revision ??= r.entries.length;
        if (r.judgment && r.analyzedRevision === undefined) r.analyzedRevision = r.revision;
      }
      while (session.records.length < dimensions.length) session.records.push(fresh(session.records.length));
      session.version = 3;
      refreshProgress(session);
      guard.commit(visitor, session);
    }
    return session;
  }
  function newSession() {
    return { id: randomUUID(), createdAt: new Date().toISOString(), dimensionIndex: 0, complete: false, answersLocked: false, records: dimensions.map((_, i) => fresh(i)), version: 3, model: config.model };
  }
  function view(session, visitor) {
    refreshProgress(session);
    const records = session.records;
    const state = { id: session.id, complete: session.complete, awaitingAnalysis: session.awaitingAnalysis, checkingAnswers: session.checkingAnswers, readyToFinalize: session.readyToFinalize, answersLocked: Boolean(session.answersLocked), dimensionIndex: session.dimensionIndex, totalAnswers: records.reduce((sum, r) => sum + r.entries.length, 0), completedDimensions: records.filter(r => r.complete).map(r => r.dimension), createdAt: session.createdAt, limits: guard.limits(visitor),
      history: records.map(r => ({ dimension: r.dimension, entries: r.entries, revision: revision(r), complete: r.complete, finished: r.finished, analysisError: r.analysisError || null })),
      pending: records.some(needsAnalysis) };
    if (!session.answersLocked && !session.readyToFinalize && !session.checkingAnswers) { const r = records[session.dimensionIndex]; state.current = { dimension: r.dimension, entries: r.entries, question: r.currentQuestion, answerCount: r.entries.length, maxQuestions: dimensions[session.dimensionIndex].questions.length }; }
    if (!session.answersLocked && !state.current) {
      const last = session.lastAnswer || session.records.flatMap((r, dimensionIndex) => r.entries.map((_, index) => ({ dimensionIndex, index }))).at(-1);
      if (last) {
        const record = records[last.dimensionIndex], entry = record.entries[last.index];
        state.lastQuestion = { ...last, ...entry, dimension: record.dimension, revision: revision(record), maxQuestions: dimensions[last.dimensionIndex].questions.length };
      }
    }
    if (session.complete) state.result = { type: records.map(r => r.judgment.letter).join(''), uncertain: records.some(r => r.uncertain), dimensions: records.map(r => ({ dimension: r.dimension, count: r.entries.length, uncertain: r.uncertain, ...r.judgment, nextQuestion: undefined })) };
    return state;
  }
  const workers = new Map(), queued = new Map();
  let closing = false;
  function schedule(visitor, id) {
    if (closing) return;
    if (!queued.has(visitor.id)) queued.set(visitor.id, new Set());
    queued.get(visitor.id).add(id);
    if (workers.has(visitor.id)) return;
    const task = runQueue(visitor).catch(error => console.error('Background analysis failed:', error.message));
    workers.set(visitor.id, task);
    task.finally(() => { workers.delete(visitor.id); queued.delete(visitor.id); });
  }
  async function runQueue(visitor) {
    const queue = queued.get(visitor.id);
    while (!closing && queue.size) {
      const id = queue.values().next().value;
      queue.delete(id);
      await work(visitor, id);
    }
  }
  async function work(visitor, id) {
    while (!closing) {
      if (guard.get(visitor, id).discarded) return;
      const snapshot = load(visitor, id);
      const index = snapshot.records.findIndex(needsAnalysis);
      if (index < 0) return;
      const record = snapshot.records[index], version = revision(record);
      let reservation, actual, judgment, failure;
      try {
        judgment = await analyze(dimensions[index], record.entries, { ...config, maxOutputTokens: options.maxOutputTokens,
          beforeRequest: amount => { reservation = guard.reserve(visitor, id, amount); },
          onUsage: used => { actual = used; } });
      } catch (error) { failure = error.message || '分析暂时失败，请重试。'; }
      finally { if (reservation) guard.settle(reservation, actual); }
      // Reload before merging: answers or edits may have arrived during the request.
      if (guard.get(visitor, id).discarded) return;
      const latest = load(visitor, id), target = latest.records[index];
      if (revision(target) !== version) continue;
      if (failure) target.analysisError = failure;
      else { target.judgment = judgment; target.analyzedRevision = version; delete target.analysisError; }
      refreshProgress(latest); guard.commit(visitor, latest); await project(latest);
    }
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
          const session = newSession();
          guard.create(visitor, session); await project(session); return send(201, view(session, visitor));
        }
        const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})(\/answers|\/export|\/edit|\/retry|\/finalize|\/restart)?$/);
        if (match) {
          const [, id, action] = match;
          if (req.method === 'GET') {
            const session = load(visitor, id);
            if (action === '/export') { if (!session.complete) return send(409, { error: '访谈完成后才能导出完整记录。' }); res.setHeader('Content-Disposition', 'attachment; filename="talkMBTI-report.json"'); return send(200, session); }
            if (!action) { schedule(visitor, id); return send(200, view(session, visitor)); }
          }
          if (req.method === 'POST' && action === '/restart') {
            load(visitor, id); guard.lock(id);
            let next, cleared;
            try { next = newSession(); cleared = guard.restart(visitor, id, next); }
            finally { guard.unlock(id); }
            await project(cleared); await project(next);
            return send(201, view(next, visitor));
          }
          if (req.method === 'POST' && ['/answers', '/edit', '/retry', '/finalize'].includes(action)) {
            const input = await body(req);
            load(visitor, id); guard.lock(id);
            let session;
            try {
              session = load(visitor, id);
              refreshProgress(session);
              if (action === '/finalize') {
                if (session.answersLocked) return send(200, view(session, visitor));
                if (input.confirmed !== true) return send(400, { error: '请确认提交后所有答案将不能修改。' });
                if (!session.readyToFinalize) return send(409, { error: '还有待完成或待确认的问题，请继续答题。' });
                const revisions = session.records.map(revision);
                if (!Array.isArray(input.revisions) || JSON.stringify(input.revisions) !== JSON.stringify(revisions)) return send(409, { error: '答案已更新，请重新确认后提交。' });
                session.answersLocked = true;
                session.finalizedAt = new Date().toISOString();
              } else if (action === '/retry') {
                if (session.complete) return send(409, { error: '结果已生成，不能重新分析本次探索。' });
                for (const record of session.records) delete record.analysisError;
              } else {
                if (session.answersLocked) return send(409, { error: '本次探索已最终提交，答案不能修改。' });
                if (typeof input.answer !== 'string' || !input.answer.trim() || Array.from(input.answer).length > options.maxAnswerChars) return send(400, { error: `请输入 1–${options.maxAnswerChars} 字的回答。` });
                if (action === '/edit') {
                  const record = session.records.find(r => r.dimension === input.dimension);
                  if (!record || !Number.isInteger(input.index) || !record.entries[input.index]) return send(400, { error: '找不到这条回答。' });
                  if (input.revision !== revision(record)) return send(409, { error: '回答已在其他页面更新，请刷新记录后修改。' });
                  record.entries[input.index].answer = input.answer.trim();
                  record.revision = revision(record) + 1;
                  delete record.judgment; delete record.analysisError;
                } else {
                  if (session.answersLocked || session.readyToFinalize || session.checkingAnswers) return send(409, { error: '问题进度已变化，请刷新后继续。' });
                  const record = session.records[session.dimensionIndex];
                  if (input.dimension !== record.dimension || input.question !== record.currentQuestion || input.answerCount !== record.entries.length) return send(409, { error: '问题进度已变化，请刷新后继续。' });
                  const version = revision(record);
                  record.entries.push({ question: record.currentQuestion, answer: input.answer.trim() });
                  record.revision = version + 1;
                  session.lastAnswer = { dimensionIndex: session.dimensionIndex, index: record.entries.length - 1 };
                  delete record.analysisError;
                }
              }
              refreshProgress(session); guard.commit(visitor, session);
            } finally { guard.unlock(id); }
            await project(session);
            send(200, view(session, visitor));
            schedule(visitor, id);
            return;
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
      send(error.status || 502, { error: error.name === 'TimeoutError' ? '请求超时，请检查已保存的进度后重试。' : error.status || !['SQLITE_ERROR','ERR_SQLITE_ERROR'].includes(error.code) ? error.message || '服务暂时不可用。' : '服务暂时不可用，请稍后再试。' });
    }
  });
  server.requestTimeout = 70000; server.headersTimeout = 15000;
  server.on('close', () => { closing = true; Promise.allSettled([...workers.values(), ...projections.values()]).then(() => guard.close()); });
  server.drainAnalysis = () => Promise.allSettled([...workers.values(), ...projections.values()]);
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.listen(port, '127.0.0.1', () => console.log(`talkMBTI → http://localhost:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    app.close(async () => { await app.drainAnalysis(); process.exit(0); });
    setTimeout(() => process.exit(1), 75000).unref();
  });
}
