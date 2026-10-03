import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dimensions } from './questions.js';
import { advance } from './engine.js';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp({ dataDir = path.join(root, 'data'), config = { baseUrl: process.env.AI_BASE_URL || 'https://api.deepseek.com/v1', model: process.env.AI_MODEL || 'deepseek-chat', apiKey: process.env.AI_API_KEY || '' } } = {}) {
  const locks = new Set();
  const file = id => path.join(dataDir, id);
  async function save(filename, value) { const temp = `${filename}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temp, filename); }
  async function get(id) { try { return JSON.parse(await readFile(path.join(file(id), 'session.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') throw Object.assign(new Error('找不到这次访谈，请开始新的访谈。'), { status: 404 }); throw e; } }
  function fresh(index) { return { dimension: dimensions[index].id, entries: [], currentQuestion: dimensions[index].questions[0], complete: false }; }
  async function view(session) {
    const records = session.records;
    const count = records.reduce((sum, r) => sum + r.entries.length, 0);
    const state = { id: session.id, complete: session.complete, dimensionIndex: session.dimensionIndex, totalAnswers: count, completedDimensions: records.filter(r => r.complete).map(r => r.dimension), createdAt: session.createdAt };
    if (!session.complete) { const r = records[session.dimensionIndex]; state.current = { dimension: r.dimension, entries: r.entries, question: r.currentQuestion, answerCount: r.entries.length }; }
    else state.result = { type: records.map(r => r.judgment.letter).join(''), uncertain: records.some(r => r.uncertain), dimensions: records.map(r => ({ dimension: r.dimension, count: r.entries.length, uncertain: r.uncertain, ...r.judgment, nextQuestion: undefined })) };
    return state;
  }
  async function body(req) { let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 20000) throw Object.assign(new Error('请求内容过长。'), { status: 413 }); } try { return JSON.parse(text); } catch { throw Object.assign(new Error('请求格式无效。'), { status: 400 }); } }
  return http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: '不允许跨站请求。' });
      if (req.method === 'GET' && url.pathname === '/api/status') return send(200, { configured: Boolean(config.apiKey), model: config.model });
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        if (!config.apiKey) return send(503, { error: '请先在 .env 中设置 AI_API_KEY，再重启应用。' });
        const id = randomUUID(); const session = { id, createdAt: new Date().toISOString(), dimensionIndex: 0, complete: false, records: [fresh(0)], model: config.model };
        await mkdir(file(id), { recursive: true, mode: 0o700 });
        await save(path.join(file(id), 'EI.json'), session.records[0]);
        await save(path.join(file(id), 'session.json'), session);
        return send(201, await view(session));
      }
      const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})(\/answers|\/export)?$/);
      if (match) {
        const [, id, action] = match;
        if (req.method === 'GET') {
          const session = await get(id);
          if (action === '/export') { if (!session.complete) return send(409, { error: '访谈完成后才能导出完整记录。' }); res.setHeader('Content-Disposition', 'attachment; filename="realMBTI-report.json"'); return send(200, session); }
          if (!action) return send(200, await view(session));
        }
        if (req.method === 'POST' && action === '/answers') {
          if (locks.has(id)) return send(409, { error: '上一个回答正在处理，请稍候。' });
          locks.add(id);
          try {
            const input = await body(req); const session = await get(id);
            if (session.complete) return send(409, { error: '本次访谈已完成。' });
            const record = session.records[session.dimensionIndex];
            if (input.dimension !== record.dimension || input.question !== record.currentQuestion || input.answerCount !== record.entries.length) return send(409, { error: '问题进度已变化，请刷新后继续。' });
            if (typeof input.answer !== 'string' || !input.answer.trim() || input.answer.length > 4000) return send(400, { error: '请输入 1–4000 字的回答。' });
            // If AI fails, nothing is committed: the same answer can safely be retried.
            const next = await advance(session, record, input.answer.trim(), config);
            session.records[session.dimensionIndex] = next;
            if (next.complete) { if (session.dimensionIndex === 3) session.complete = true; else { session.dimensionIndex++; session.records.push(fresh(session.dimensionIndex)); } }
            // session.json is the atomic source of truth. Per-dimension files are durable projections.
            await save(path.join(file(id), 'session.json'), session);
            for (const r of session.records) await save(path.join(file(id), `${r.dimension}.json`), r);
            return send(200, await view(session));
          } finally { locks.delete(id); }
        }
      }
      if (req.method === 'GET' && ['/', '/app.js', '/styles.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const content = await readFile(path.join(root, 'public', name));
        res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css' : 'text/javascript', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' }); return res.end(content);
      }
      send(404, { error: '页面不存在。' });
    } catch (error) { send(error.status || 502, { error: error.name === 'TimeoutError' ? '模型响应超时，回答尚未提交。请重试。' : error.message || '服务暂时不可用。' }); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, '127.0.0.1', () => console.log(`realMBTI → http://localhost:${port}`));
}
