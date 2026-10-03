import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { dimensions } from '../questions.js';
import { validateJudgment } from '../engine.js';

async function fixture(t, mode = 'clear') {
  const requests = []; let fail = false; let invalid = false;
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); requests.push(input);
    if (fail) { res.writeHead(503); return res.end('{}'); }
    const data = JSON.parse(input.messages[1].content);
    const dim = dimensions.find(d => d.id === data.dimension);
    const value = { letter: dim.letters[0], confidence: mode === 'clear' ? .92 : .55, sufficient: mode === 'clear', reason: '依据三个不同场景判断，保留情境差异。', evidence: data.questionsAndAnswers.slice(0, 3).map(q => ({ question: q.number, quote: q.answer, interpretation: '具体情境中的偏好。' })), counterEvidence: '某些场景可能有不同偏好。', nextQuestion: '请讲一个相反的经历，你当时怎样选择？' };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: invalid ? 'invalid json' : JSON.stringify(value) } }] }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'realmbti-test-'));
  const app = createApp({ dataDir, settings: { captchaVisitorThreshold: 1000, captchaIpThreshold: 1000, visitorRequestsPerMinute: 1000, ipRequestsPerMinute: 1000 }, config: { baseUrl: `http://127.0.0.1:${mock.address().port}`, apiKey: 'test-only', model: 'test-model' } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => { await Promise.all([new Promise(r => app.close(r)), new Promise(r => mock.close(r))]); await rm(dataDir, { recursive: true, force: true }); });
  let cookie;
  const api = async (route, payload) => { const response = await fetch(url + route, { method: payload === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }); if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]; return { status: response.status, body: await response.json() }; };
  const answer = (s, text = `只有${s.current.dimension}维度的经历：我在熟悉的环境里主动讨论，并从交流中恢复精力。`) => api(`/api/sessions/${s.id}/answers`, { dimension: s.current.dimension, question: s.current.question, answerCount: s.current.answerCount, answer: text });
  return { api, answer, requests, dataDir, getCookie: () => cookie, setFail: v => { fail = v; }, setInvalid: v => { invalid = v; } };
}

test('complete 20-answer interview: correct order, minimum 5, hidden provisional results, durable files and isolated context', async t => {
  const f = await fixture(t); let s = (await f.api('/api/sessions', {})).body;
  for (let i = 0; i < 20; i++) {
    assert.equal(s.current.dimension, dimensions[Math.floor(i / 5)].id);
    assert.equal(s.current.answerCount, i % 5); assert.equal(s.result, undefined);
    const response = await f.answer(s); assert.equal(response.status, 200); s = response.body;
  }
  assert.equal(s.complete, true); assert.equal(s.result.type, 'ENTJ'); assert.equal(s.totalAnswers, 20);
  assert.equal(s.result.dimensions.length, 4); assert.equal(f.requests.length, 4);
  for (let i = 0; i < 4; i++) {
    const input = f.requests[i]; assert.equal(input.messages.length, 2);
    const data = JSON.parse(input.messages[1].content); assert.equal(data.dimension, dimensions[i].id);
    assert.equal(data.questionsAndAnswers.length, 5);
    assert.ok(data.questionsAndAnswers.every(q => q.answer.includes(`只有${dimensions[i].id}维度`)));
    for (let j = 0; j < i; j++) assert.ok(!input.messages[1].content.includes(`只有${dimensions[j].id}维度`));
    const file = JSON.parse(await readFile(path.join(f.dataDir, s.id, `${dimensions[i].id}.json`), 'utf8'));
    assert.equal(file.entries.length, 5); assert.equal(file.complete, true); assert.ok(file.judgment);
  }
  const exportResult = await f.api(`/api/sessions/${s.id}/export`); assert.equal(exportResult.status, 200); assert.equal(exportResult.body.records.length, 4);
  assert.equal((await f.api(`/api/sessions/${s.id}`)).body.result.type, 'ENTJ');
  const restoredApp = createApp({ dataDir: f.dataDir });
  await new Promise(r => restoredApp.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => restoredApp.close(r)));
  const restored = await fetch(`http://127.0.0.1:${restoredApp.address().port}/api/sessions/${s.id}`, { headers: { Cookie: f.getCookie() } });
  assert.equal((await restored.json()).result.type, 'ENTJ');
});

test('ambiguous answers continue to 40 and final report preserves uncertainty', async t => {
  const f = await fixture(t, 'unclear'); let s = (await f.api('/api/sessions', {})).body;
  assert.equal((await f.api(`/api/sessions/${s.id}/export`)).status, 409);
  for (let i = 0; i < 40; i++) { assert.equal(s.current.dimension, dimensions[Math.floor(i / 10)].id); s = (await f.answer(s)).body; }
  assert.equal(s.totalAnswers, 40); assert.equal(s.result.uncertain, true);
  assert.ok(s.result.dimensions.every(d => d.count === 10 && d.uncertain));
  assert.equal(f.requests.length, 24);
  assert.equal((await f.api(`/api/sessions/${s.id}/answers`, {})).status, 409);
});

test('upstream and malformed-response failures do not commit answers; retry and stale submission protection', async t => {
  const f = await fixture(t); let s = (await f.api('/api/sessions', {})).body;
  for (let i = 0; i < 4; i++) s = (await f.answer(s)).body;
  f.setFail(true); assert.equal((await f.answer(s)).status, 502);
  assert.equal((await f.api(`/api/sessions/${s.id}`)).body.current.answerCount, 4);
  f.setFail(false); f.setInvalid(true); assert.equal((await f.answer(s)).status, 502);
  assert.equal((await f.api(`/api/sessions/${s.id}`)).body.totalAnswers, 4);
  f.setInvalid(false); const next = await f.answer(s); assert.equal(next.status, 200); assert.equal(next.body.dimensionIndex, 1);
  assert.equal((await f.answer(s)).status, 409);
});

test('hallucinated, repeated, and out-of-range evidence cannot trigger early stopping', () => {
  const entries = [{ answer: '一段真实的回答内容' }, { answer: '另一段真实的回答内容' }, { answer: '第三段真实的回答内容' }];
  const value = { letter: 'E', confidence: .99, sufficient: true, reason: '判断', counterEvidence: '', evidence: [{ question: 1, quote: '一段真实', interpretation: '解释' }, { question: 1, quote: '真实的回答', interpretation: '重复题号' }, { question: 2, quote: '虚构引文', interpretation: '错误' }, { question: 99, quote: '没有回答', interpretation: '错误' }] };
  assert.equal(validateJudgment(value, dimensions[0], entries).sufficient, false);
  assert.throws(() => validateJudgment({ ...value, letter: 'T' }, dimensions[0], entries));
});

test('empty answers, oversized answers, cross-origin writes and missing credentials are rejected', async t => {
  const f = await fixture(t); const s = (await f.api('/api/sessions', {})).body;
  assert.equal((await f.answer(s, '')).status, 400); assert.equal((await f.answer(s, 'a'.repeat(4001))).status, 400);
  const app = createApp({ dataDir: await mkdtemp(path.join(os.tmpdir(), 'realmbti-nokey-')), config: { baseUrl: '', model: 'test', apiKey: '' } }); await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => app.close(r))); const url = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(url + '/api/sessions', { method: 'POST' })).status, 503);
  assert.equal((await fetch(url + '/api/sessions', { method: 'POST', headers: { Origin: 'https://other.example' } })).status, 403);
});
