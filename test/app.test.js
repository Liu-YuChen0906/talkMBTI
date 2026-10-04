import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { dimensions } from '../questions.js';
import { validateJudgment } from '../engine.js';

async function fixture(t, mode = 'clear') {
  const requests = []; let fail = false; let invalid = false; let release; let barrier;
  const hold = () => { barrier = new Promise(r => { release = () => { barrier = null; r(); }; }); };
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); requests.push(input);
    if (barrier) await barrier;
    if (fail) { res.writeHead(503); return res.end('{}'); }
    const data = JSON.parse(input.messages[1].content);
    const dim = dimensions.find(d => d.id === data.dimension);
    const value = { letter: dim.letters[0], confidence: mode === 'clear' ? .92 : .55, sufficient: mode === 'clear', reason: '依据三个不同场景判断，保留情境差异。', evidence: data.questionsAndAnswers.slice(0, 3).map(q => ({ question: q.number, quote: q.answer, interpretation: '具体情境中的偏好。' })), counterEvidence: '某些场景可能有不同偏好。', nextQuestion: '请讲一个相反的经历，你当时怎样选择？' };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: invalid ? 'invalid json' : JSON.stringify(value) } }] }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'realmbti-test-'));
  const app = createApp({ dataDir, settings: { visitorDailyTests: 3, captchaVisitorThreshold: 1000, captchaIpThreshold: 1000, visitorRequestsPerMinute: 1000, ipRequestsPerMinute: 1000 }, config: { baseUrl: `http://127.0.0.1:${mock.address().port}`, apiKey: 'test-only', model: 'test-model' } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => { release?.(); await app.drainAnalysis(); await Promise.all([new Promise(r => app.close(r)), new Promise(r => mock.close(r))]); await rm(dataDir, { recursive: true, force: true }); });
  let cookie;
  const api = async (route, payload) => { const response = await fetch(url + route, { method: payload === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }); if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]; return { status: response.status, body: await response.json() }; };
  const answer = (s, text = `只有${s.current.dimension}维度的经历：我在熟悉的环境里主动讨论，并从交流中恢复精力。`) => api(`/api/sessions/${s.id}/answers`, { dimension: s.current.dimension, question: s.current.question, answerCount: s.current.answerCount, answer: text });
  return { api, answer, requests, dataDir, modelUrl: `http://127.0.0.1:${mock.address().port}`, hold, release: () => release?.(), drain: () => app.drainAnalysis(), setMode: v => { mode = v; }, getCookie: () => cookie, setFail: v => { fail = v; }, setInvalid: v => { invalid = v; } };
}

async function settled(f, id) {
  await f.drain();
  return (await f.api(`/api/sessions/${id}`)).body;
}
async function finalSubmit(f, s, extra = {}) {
  return f.api(`/api/sessions/${s.id}/finalize`, { confirmed: true, revisions: s.history.map(r => r.revision), ...extra });
}
async function answerAll(f, s) {
  for (let i = 0; !s.readyToFinalize && i < 60; i++) {
    assert.equal(s.awaitingAnalysis, false);
    if (s.current) {
      const response = await f.answer(s, '前者'); assert.equal(response.status, 200);
      s = response.body;
    }
    s = await settled(f, s.id);
  }
  assert.ok(s.readyToFinalize);
  return s;
}
async function finish(f, s) {
  s = await answerAll(f, s);
  assert.equal(s.result, undefined);
  const submitted = await finalSubmit(f, s); assert.equal(submitted.status, 200);
  s = await settled(f, s.id);
  assert.ok(s.complete);
  return s;
}

test('clear preferences stop at five per dimension; explicit final submission, durable export and restart', async t => {
  const f = await fixture(t); let s = (await f.api('/api/sessions', {})).body;
  for (let i = 0; i < 20; i++) {
    assert.equal(s.current.dimension, dimensions[Math.floor(i / 5)].id);
    assert.equal(s.result, undefined);
    const response = await f.answer(s, '前者'); assert.equal(response.status, 200);
    s = await settled(f, s.id);
  }
  assert.equal(s.readyToFinalize, true); assert.equal(s.complete, false);
  assert.equal(s.awaitingAnalysis, false); assert.equal(s.lastQuestion.index, 4);
  assert.equal((await f.api(`/api/sessions/${s.id}/export`)).status, 409);
  assert.equal((await finalSubmit(f, s, { confirmed: false })).status, 400);
  assert.equal((await finalSubmit(f, s, { revisions: [0, 0, 0, 0] })).status, 409);
  s = (await finalSubmit(f, s)).body;
  assert.equal(s.complete, true); assert.equal(s.answersLocked, true);
  assert.equal(s.result.type, 'ENTJ'); assert.equal(s.totalAnswers, 20);
  assert.equal(f.requests.length, 4);
  await f.drain();
  for (let i = 0; i < 4; i++) {
    const data = JSON.parse(f.requests[i].messages[1].content);
    assert.equal(data.dimension, dimensions[i].id); assert.equal(data.questionsAndAnswers.length, 5);
    assert.deepEqual(data.questionsAndAnswers.map(q => q.question), dimensions[i].questions.slice(0, 5));
    const file = JSON.parse(await readFile(path.join(f.dataDir, s.id, `${dimensions[i].id}.json`), 'utf8'));
    assert.equal(file.entries.length, 5); assert.equal(file.complete, true);
  }
  assert.equal((await f.api(`/api/sessions/${s.id}/export`)).status, 200);
  const restoredApp = createApp({ dataDir: f.dataDir });
  await new Promise(r => restoredApp.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => restoredApp.close(r)));
  const restored = await fetch(`http://127.0.0.1:${restoredApp.address().port}/api/sessions/${s.id}`, { headers: { Cookie: f.getCookie() } });
  const state = await restored.json(); assert.equal(state.result.type, 'ENTJ'); assert.equal(state.answersLocked, true);
});

test('ambiguous preferences stop at ten unique questions; supplementary questions stay in answer phase', async t => {
  const f = await fixture(t, 'unclear'); let s = (await f.api('/api/sessions', {})).body;
  s = await finish(f, s);
  assert.equal(s.totalAnswers, 40); assert.equal(s.result.uncertain, true);
  assert.ok(s.result.dimensions.every(d => d.count === 10 && d.uncertain));
  for (const r of s.history) assert.equal(new Set(r.entries.map(e => e.question)).size, 10);
  assert.equal(f.requests.length, 24);
  assert.equal((await f.api(`/api/sessions/${s.id}/answers`, { answer: '前者' })).status, 409);
});

test('slow model never blocks saving; all-five checkpoint stays in answering until evidence is ready', async t => {
  const f = await fixture(t); f.hold(); let s = (await f.api('/api/sessions', {})).body;
  for (let i = 0; i < 20; i++) {
    assert.equal(s.current.dimension, dimensions[Math.floor(i / 5)].id);
    const previous = s;
    const saved = await Promise.race([f.answer(s, 'A'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('answer waited for model')), 2000); timer.unref(); })]);
    assert.equal(saved.status, 200); s = saved.body;
    assert.equal(s.awaitingAnalysis, false);
    assert.equal((await f.answer(previous, 'A')).status, 409);
  }
  assert.equal(s.checkingAnswers, true); assert.equal(s.totalAnswers, 20);
  assert.equal(s.readyToFinalize, false); assert.equal(s.current, undefined); assert.equal(s.result, undefined);
  assert.equal((await finalSubmit(f, s)).status, 409);
  f.release(); s = await settled(f, s.id); assert.equal(s.readyToFinalize, true); assert.equal(s.complete, false);
  s = (await finalSubmit(f, s)).body; assert.equal(s.complete, true);
});

test('after final submission, pending or weak analysis can never reopen questions or edits', async t => {
  const f = await fixture(t, 'unclear'); let s = (await f.api('/api/sessions', {})).body;
  for (let i = 0; i < 60 && !s.readyToFinalize; i++) {
    if (s.totalAnswers === 39) { f.hold(); s = (await f.answer(s, '前者')).body; break; }
    if (s.current) s = (await f.answer(s, '前者')).body;
    s = await settled(f, s.id);
  }
  assert.equal(s.totalAnswers, 40); assert.equal(s.readyToFinalize, true);
  s = (await finalSubmit(f, s)).body;
  assert.equal(s.answersLocked, true); assert.equal(s.awaitingAnalysis, true); assert.equal(s.current, undefined);
  assert.equal((await f.api(`/api/sessions/${s.id}/edit`, { dimension: 'EI', index: 0, revision: s.history[0].revision, answer: '后者' })).status, 409);
  f.release(); s = await settled(f, s.id);
  assert.equal(s.complete, true); assert.equal(s.current, undefined); assert.equal(s.result.uncertain, true);
  const calls = f.requests.length;
  assert.equal((await f.api(`/api/sessions/${s.id}/retry`, {})).status, 409);
  assert.equal((await f.api(`/api/sessions/${s.id}/edit`, { dimension: 'JP', index: 9, revision: s.history[3].revision, answer: '后者' })).status, 409);
  assert.equal((await finalSubmit(f, s)).body.complete, true);
  await f.drain(); assert.equal(f.requests.length, calls);
});

test('upstream and invalid JSON failures preserve answers and retry without re-answering', async t => {
  const f = await fixture(t); f.setFail(true); let s = (await f.api('/api/sessions', {})).body;
  for (let i = 0; i < 5; i++) s = (await f.answer(s, '后者')).body;
  s = await settled(f, s.id);
  assert.equal(s.totalAnswers, 5); assert.ok(s.history[0].analysisError); assert.equal(s.current.dimension, 'NS');
  f.setFail(false); f.setInvalid(true);
  await f.api(`/api/sessions/${s.id}/retry`, {}); s = await settled(f, s.id);
  assert.equal(s.totalAnswers, 5); assert.ok(s.history[0].analysisError);
  f.setInvalid(false); await f.api(`/api/sessions/${s.id}/retry`, {}); s = await settled(f, s.id);
  assert.equal(s.history[0].complete, true); assert.equal(s.history[0].analysisError, null);
});

test('editing before final submission discards stale analysis and preserves other dimensions', async t => {
  const f = await fixture(t); f.hold(); let s = (await f.api('/api/sessions', {})).body;
  for (let i = 0; i < 6; i++) s = (await f.answer(s, '前者')).body;
  const payload = { dimension: 'EI', index: 0, revision: s.history[0].revision, answer: '后者' };
  const edited = await f.api(`/api/sessions/${s.id}/edit`, payload); assert.equal(edited.status, 200);
  assert.equal(edited.body.history[1].entries.length, 1);
  assert.equal((await f.api(`/api/sessions/${s.id}/edit`, payload)).status, 409);
  f.release(); s = await settled(f, s.id);
  assert.equal(f.requests.length, 2);
  assert.equal(JSON.parse(f.requests[1].messages[1].content).questionsAndAnswers[0].answer, '后者');
  assert.equal(s.history[0].entries[0].answer, '后者'); assert.equal(s.history[0].complete, true);
});

test('last answer changes require fresh evidence and a fresh final confirmation', async t => {
  const f = await fixture(t); let s = await answerAll(f, (await f.api('/api/sessions', {})).body);
  const before = s; const original = s.history.slice(0, 3); f.hold();
  s = (await f.api(`/api/sessions/${s.id}/edit`, { dimension: 'JP', index: 4, revision: s.history[3].revision, answer: '后者' })).body;
  assert.equal(s.readyToFinalize, false); assert.equal(s.checkingAnswers, true); assert.equal(s.awaitingAnalysis, false);
  assert.equal((await finalSubmit(f, s)).status, 409);
  f.release(); s = await settled(f, s.id); assert.equal(s.readyToFinalize, true);
  assert.equal((await finalSubmit(f, before)).status, 409);
  s = (await finalSubmit(f, s)).body; assert.equal(s.complete, true);
  assert.deepEqual(s.history.slice(0, 3), original); assert.equal(f.requests.length, 5);
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

test('question bank is short, bounded-choice and globally unique; single-character evidence is valid', () => {
  const questions = dimensions.flatMap(d => d.questions);
  assert.equal(new Set(questions).size, 40);
  assert.ok(questions.every(q => q.length <= 36 && q.includes('还是') && !/回忆|经历|举例/.test(q)));
  const entries = ['A', 'B', 'A'].map(answer => ({ answer }));
  const value = { letter: 'E', confidence: .9, sufficient: true, reason: '判断', counterEvidence: '', evidence: entries.map((e, i) => ({ question: i + 1, quote: e.answer, interpretation: '偏好' })) };
  assert.equal(validateJudgment(value, dimensions[0], entries).sufficient, true);
});


test('restart resumes persisted pending analysis on visit, without duplicate answers', async t => {
  const f = await fixture(t); let s = await finish(f, (await f.api('/api/sessions', {})).body);
  const db = new DatabaseSync(path.join(f.dataDir, 'access.sqlite'));
  const saved = JSON.parse(db.prepare('SELECT payload FROM sessions WHERE id=?').get(s.id).payload);
  delete saved.records[0].analyzedRevision; delete saved.records[0].judgment;
  saved.records[0].complete = false; saved.complete = false;
  db.prepare('UPDATE sessions SET payload=? WHERE id=?').run(JSON.stringify(saved), s.id); db.close();
  const restored = createApp({ dataDir: f.dataDir, settings: { visitorRequestsPerMinute: 1000, ipRequestsPerMinute: 1000 }, config: { apiKey: 'test', model: 'mock', baseUrl: f.modelUrl } });
  await new Promise(r => restored.listen(0, '127.0.0.1', r));
  t.after(async () => { await restored.drainAnalysis(); await new Promise(r => restored.close(r)); });
  const read = async () => (await fetch(`http://127.0.0.1:${restored.address().port}/api/sessions/${s.id}`, { headers: { Cookie: f.getCookie() } })).json();
  const pending = await read(); assert.equal(pending.pending, true); assert.equal(pending.totalAnswers, 20);
  await restored.drainAnalysis();
  const done = await read(); assert.equal(done.complete, true); assert.equal(done.totalAnswers, 20); assert.equal(f.requests.length, 5);
});


test('one visitor can queue analysis for two sessions without losing either job', async t => {
  const f = await fixture(t); f.hold();
  let first = (await f.api('/api/sessions', {})).body;
  for (let i = 0; i < 5; i++) first = (await f.answer(first, '前者')).body;
  let second = (await f.api('/api/sessions', {})).body;
  for (let i = 0; i < 5; i++) second = (await f.answer(second, '后者')).body;
  f.release(); await f.drain();
  first = (await f.api(`/api/sessions/${first.id}`)).body;
  second = (await f.api(`/api/sessions/${second.id}`)).body;
  assert.equal(first.history[0].complete, true);
  assert.equal(second.history[0].complete, true);
  assert.equal(f.requests.length, 2);
});


test('three daily attempts including clear-and-restart; fourth rejected without clearing answers', async t => {
  const f = await fixture(t); let s = (await f.api('/api/sessions', {})).body;
  assert.equal(s.limits.remainingTests, 2);
  for (let attempt = 0; attempt < 2; attempt++) {
    s = (await f.answer(s, '前者')).body;
    const previous = s;
    const reset = await f.api(`/api/sessions/${s.id}/restart`, {});
    assert.equal(reset.status, 201); s = reset.body;
    assert.notEqual(s.id, previous.id); assert.equal(s.totalAnswers, 0);
    assert.equal(s.limits.remainingTests, 1 - attempt);
    assert.equal((await f.api(`/api/sessions/${previous.id}`)).status, 409);
    await assert.rejects(readFile(path.join(f.dataDir, previous.id, 'session.json')), { code: 'ENOENT' });
  }
  s = (await f.answer(s, '保留这个答案')).body;
  assert.equal((await f.api(`/api/sessions/${s.id}/restart`, {})).status, 429);
  assert.equal((await f.api('/api/sessions', {})).status, 429);
  const intact = (await f.api(`/api/sessions/${s.id}`)).body;
  assert.equal(intact.totalAnswers, 1); assert.equal(intact.history[0].entries[0].answer, '保留这个答案');
});

test('reset during background analysis prevents old answers or judgment being resurrected', async t => {
  const f = await fixture(t); f.hold(); let s = (await f.api('/api/sessions', {})).body;
  for (let i = 0; i < 5; i++) s = (await f.answer(s, '前者')).body;
  const previousId = s.id;
  s = (await f.api(`/api/sessions/${s.id}/restart`, {})).body;
  f.release(); await f.drain();
  assert.equal((await f.api(`/api/sessions/${previousId}`)).status, 409);
  await assert.rejects(readFile(path.join(f.dataDir, previousId, 'EI.json')), { code: 'ENOENT' });
  assert.equal((await f.api(`/api/sessions/${s.id}`)).body.totalAnswers, 0);
});


test('legacy generated reports stay locked after upgrade; unfinished old revisions are preserved', async t => {
  const f = await fixture(t); let s = await finish(f, (await f.api('/api/sessions', {})).body);
  const db = new DatabaseSync(path.join(f.dataDir, 'access.sqlite'));
  let saved = JSON.parse(db.prepare('SELECT payload FROM sessions WHERE id=?').get(s.id).payload);
  saved.version = 2; delete saved.answersLocked; delete saved.finalizedAt;
  db.prepare('UPDATE sessions SET payload=? WHERE id=?').run(JSON.stringify(saved), s.id);
  s = (await f.api(`/api/sessions/${s.id}`)).body;
  assert.equal(s.answersLocked, true); assert.equal(s.complete, true);
  assert.equal((await f.api(`/api/sessions/${s.id}/edit`, { dimension: 'EI', index: 0, revision: s.history[0].revision, answer: '后者' })).status, 409);
  f.hold();
  let other = (await f.api('/api/sessions', {})).body;
  for (let i = 0; i < 5; i++) other = (await f.answer(other, '前者')).body;
  saved = JSON.parse(db.prepare('SELECT payload FROM sessions WHERE id=?').get(other.id).payload);
  saved.version = 2; saved.records[0].revision = 8; saved.records[0].analyzedRevision = 5;
  saved.records[0].judgment = { letter: 'E', confidence: .99, sufficient: true };
  db.prepare('UPDATE sessions SET payload=? WHERE id=?').run(JSON.stringify(saved), other.id); db.close();
  other = (await f.api(`/api/sessions/${other.id}`)).body;
  assert.equal(other.history[0].revision, 8); assert.equal(other.history[0].complete, false);
  f.release(); await f.drain();
});
