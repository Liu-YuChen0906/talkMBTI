const app = document.querySelector('#app');
const dims = [ ['EI', '能量来源', 'E / I', '你如何与世界相处'], ['NS', '信息偏好', 'N / S', '你如何理解周围的信息'], ['TF', '决策方式', 'T / F', '你如何权衡重要的选择'], ['JP', '生活节奏', 'J / P', '你如何安排与应对变化'] ];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let session = null, busy = false, status, pollTimer, screen = 'landing', cursor = null;
const getId = () => localStorage.getItem('realmbti-session');
function displayedQuestion() {
  if (cursor) {
    const record = session.history[cursor.dimensionIndex], entry = record?.entries[cursor.index];
    if (entry) return { ...cursor, dimension: record.dimension, question: entry.question, answer: entry.answer, revision: record.revision, editing: true, maxQuestions: Math.max(10, record.entries.length) };
    cursor = null;
  }
  if (!session.current) {
    if (session.lastQuestion && !session.answersLocked) return { ...session.lastQuestion, editing: true, checking: session.checkingAnswers, finalizing: session.readyToFinalize };
    return null;
  }
  return { ...session.current, dimensionIndex: session.dimensionIndex, index: session.current.answerCount, editing: false };
}
function draftKey(question = displayedQuestion()) {
  return `realmbti-draft-${session?.id}-${question?.dimensionIndex}-${question?.index}${question?.editing ? '-edit' : ''}`;
}
function answeredQuestions() {
  return session.history.flatMap((record, dimensionIndex) => record.entries.map((_, index) => ({ dimensionIndex, index })));
}
function nextAnswered(question) {
  const all = answeredQuestions();
  const position = all.findIndex(q => q.dimensionIndex === question.dimensionIndex && q.index === question.index);
  return all[position + 1] ?? null;
}
function navigate(target) {
  if (busy || session.answersLocked) return;
  cursor = target; render();
}
function previousQuestion() {
  const question = displayedQuestion(), all = answeredQuestions();
  if (!question?.editing) {
    if (question?.index > 0) return { dimensionIndex: question.dimensionIndex, index: question.index - 1 };
    return all.filter(q => !question || q.dimensionIndex < question.dimensionIndex).at(-1) ?? null;
  }
  const position = all.findIndex(q => q.dimensionIndex === question.dimensionIndex && q.index === question.index);
  return all[position - 1] ?? null;
}
async function rawApi(url, options) { const r = await fetch(url, { credentials: 'same-origin', ...options }); const body = await r.json(); return { r, body }; }
async function api(url, options) {
  let { r, body } = await rawApi(url, options);
  if (body.captchaRequired) { await verifyHuman(); ({ r, body } = await rawApi(url, options)); }
  if (!r.ok) throw new Error(body.error || '请求失败'); return body;
}
let captchaTask;
function verifyHuman() {
  if (captchaTask) return captchaTask;
  const dialog = document.querySelector('#captcha-dialog');
  captchaTask = new Promise((resolve, reject) => {
    let verified = false;
    const message = document.querySelector('#captcha-error'), input = document.querySelector('#captcha-code');
    async function refresh() {
      message.textContent = ''; input.value = '';
      try { const { r, body } = await rawApi('/api/captcha'); if (!r.ok) throw new Error(body.error); document.querySelector('#captcha-image').src = body.image; } catch(e) { message.textContent = e.message; }
    }
    document.querySelector('#captcha-refresh').onclick = refresh;
    document.querySelector('#captcha-cancel').onclick = () => dialog.close();
    dialog.onclose = () => { captchaTask = null; verified ? resolve() : reject(new Error('验证已取消，回答保留，可以稍后再试。')); };
    document.querySelector('#captcha-form').onsubmit = async e => {
      e.preventDefault(); const button = document.querySelector('#captcha-submit'); button.disabled = true;
      try {
        const { r, body } = await rawApi('/api/captcha/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: input.value.trim() }) });
        if (!r.ok) throw new Error(body.error); verified = true; dialog.close();
      } catch(e) { message.textContent = e.message; } finally { button.disabled = false; }
    };
    dialog.showModal(); refresh();
  });
  return captchaTask;
}
function error(message) { const box = document.querySelector('#error'); if (box) { box.textContent = message; box.hidden = false; } }
function landing() {
  screen = 'landing'; cursor = null; clearTimeout(pollTimer);
  app.innerHTML = `<section class="landing"><div class="hero-copy"><div class="eyebrow"><span class="tiny-dot"></span> LESS QUIZ. MORE YOU.</div><h1>你不止是<br>四个<span class="italic">字母。</span></h1><p class="intro">几个字，就能表达你的偏好。<br>从简短的日常选择开始，<br>一点点认识自己的性格倾向。</p><div class="hero-actions"><button class="primary" id="start">开始认识自己 <span>↗</span></button>${getId() ? '<button class="quiet" id="resume">继续上次的探索 →</button>' : ''}</div><div class="facts"><span>20–40 道简短问题 · 证据足够就结束</span><span>随时暂停 · 自动保存</span></div><p id="error" class="error" hidden></p>${!status.configured ? '<div class="setup"><strong>服务准备中</strong><p>模型服务尚未就绪，请稍后再来。</p></div>' : '<div class="connected"><span class="tiny-dot"></span> 由 DeepSeek 分析 · 回答将发送至模型服务</div>'}</div><div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="art-label top-label">THE WAY YOU SEE</div><div class="blob blob-one">E<span>向外连接</span></div><div class="blob blob-two">N<span>发现可能</span></div><div class="blob blob-three">F<span>感受价值</span></div><div class="blob blob-four">P<span>自由探索</span></div><div class="art-center">you<span>独一无二的交点</span></div><div class="art-label bottom-label">NOT A BOX. A STARTING POINT.</div></div></section><section class="how"><div><span class="eyebrow">FOUR LENSES, ONE YOU</span><h2>从四个角度，<br>慢慢看清自己。</h2></div><div class="dimension-grid">${dims.map((d, i) => `<div class="dimension-card"><span class="number">0${i + 1}</span><strong>${d[2]}</strong><h3>${d[1]}</h3><p>${d[3]}</p></div>`).join('')}</div></section>`;
  document.querySelector('#start').onclick = start;
  document.querySelector('#resume')?.addEventListener('click', resume);
  const note = document.createElement('p'); note.className = 'quota-note';
  note.textContent = `无需注册 · 每天最多 3 次探索，今天还剩 ${status.limits?.remainingTests ?? 3} 次。已有访谈可继续；网络共享额度也可能影响使用。额度每天北京时间零点重置。`;
  document.querySelector('.hero-copy').append(note);
}
async function start() {
  if (getId() && !confirm('开始新的探索？已有记录仍保存在本机，但快捷续答入口会切换到新记录。')) return;
  const button = document.querySelector('#start'); button.disabled = true;
  try { session = await api('/api/sessions', { method: 'POST' }); localStorage.setItem('realmbti-session', session.id); render(); } catch (e) { error(e.message); button.disabled = false; }
}
async function resume() { try { session = await api(`/api/sessions/${getId()}`); render(); } catch (e) { error(e.message); } }
function render() {
  screen = 'session'; clearTimeout(pollTimer);
  if (session.limits) status.limits = session.limits;
  if (session.answersLocked) cursor = null;
  if (cursor) interview();
  else if (session.complete) results();
  else if (session.awaitingAnalysis) review();
  else interview();
  const controls = document.createElement('section'); controls.className = 'record-controls';
  controls.innerHTML = `<button class="quiet" id="restart" ${session.limits?.remainingTests > 0 ? '' : 'disabled'}>清空重做 · 今天剩余 ${session.limits?.remainingTests ?? 0} 次</button>${session.history.some(r => r.analysisError) && !session.complete ? '<p>回答已保存，部分分析未完成。请稍后重试。</p><button class="quiet" id="retry-analysis">重试分析</button>' : ''}`;
  app.append(controls);
  document.querySelector('#restart').onclick = restart;
  document.querySelector('#retry-analysis')?.addEventListener('click', async () => {
    if (busy) return; busy = true;
    try { session = await api(`/api/sessions/${session.id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); render(); }
    catch (e) { error(e.message); } finally { busy = false; }
  });
  if (!cursor && !session.complete && (session.checkingAnswers || session.awaitingAnalysis) && session.pending) pollTimer = setTimeout(poll, 4000);
}
async function poll() {
  if (screen !== 'session') return;
  if (cursor) return;
  if (busy) { pollTimer = setTimeout(poll, 4000); return; }
  try { session = await api(`/api/sessions/${session.id}`); render(); }
  catch (e) { error(e.message); pollTimer = setTimeout(poll, 15000); }
}
async function restart() {
  if (busy || !session.limits?.remainingTests) return;
  if (!confirm(`清空本次回答并重新开始？今天还剩 ${session.limits.remainingTests} 次机会。`)) return;
  busy = true;
  const oldId = session.id;
  try {
    session = await api(`/api/sessions/${oldId}/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    for (const key of Object.keys(localStorage)) if (key.startsWith(`realmbti-draft-${oldId}-`)) localStorage.removeItem(key);
    localStorage.setItem('realmbti-session', session.id); cursor = null; render();
  } catch (e) { error(e.message); } finally { busy = false; }
}
function review() {
  app.innerHTML = `<section class="result-hero"><span class="eyebrow">YOUR ANSWERS, SUBMITTED</span><h1>探索完成，<br>正在整理结果。</h1><p>你已确认最终提交，所有回答已锁定。${session.pending ? '结果就绪后会自动显示，也可以稍后回来查看。' : '分析暂未完成，请稍后重试。'}</p><button class="quiet" id="pause">暂停并返回</button><p id="error" class="error" role="alert" hidden></p></section>`;
  document.querySelector('#pause').onclick = landing;
}
function interview() {
  const current = displayedQuestion(), d = dims[current.dimensionIndex];
  const previous = previousQuestion(), next = current.editing ? nextAnswered(current) : null;
  const record = session.history[current.dimensionIndex];
  app.innerHTML = `<section class="workspace"><aside class="sidebar"><span class="eyebrow">YOUR EXPLORATION</span><h2>一点一点，<br>靠近真实的你。</h2><nav aria-label="访谈进度">${dims.map((dim, i) => `<button type="button" data-dimension="${i}" ${session.history[i].entries.length || session.current?.dimension === dim[0] ? '' : 'disabled'} class="step ${i === current.dimensionIndex ? 'active' : ''} ${session.completedDimensions.includes(dim[0]) ? 'done' : ''}"><span class="step-icon">${session.completedDimensions.includes(dim[0]) ? '✓' : `0${i + 1}`}</span><span><strong>${dim[1]}</strong><small>${session.completedDimensions.includes(dim[0]) ? '已完成 · 最后揭晓' : dim[2]}</small></span>${i === current.dimensionIndex ? '<span class="tiny-dot"></span>' : ''}</button>`).join('')}</nav><div class="save-note"><span>◌</span><p>已回答 ${session.totalAnswers} 题<br>已提交的回答已保存。<br>可以随时回看和修改。</p></div><button id="pause" class="quiet">← 暂停并返回</button></aside><div class="question-panel"><div class="question-top"><span class="eyebrow">CHAPTER 0${current.dimensionIndex + 1} / ${d[1]}</span><span class="question-count">${current.index + 1}<span> / 最多 ${current.maxQuestions} 题</span></span></div><div class="progress"><div style="width:${(current.index + (current.editing ? 1 : 0)) / current.maxQuestions * 100}%"></div></div><div class="question-copy"><span class="pill">${current.finalizing ? '最后一题 · 确认最终提交' : current.checking ? '回答已暂存' : current.editing ? '已回答 · 可以重新提交' : current.index >= 5 ? '再确认一个偏好' : '简短选择，凭直觉回答'}</span><h1>${esc(current.question)}</h1><p>回答一个选项、前者 / 后者，或随便聊聊，我们会懂你。</p></div><form id="answer-form"><label for="answer" class="sr-only">你的回答</label><textarea id="answer" maxlength="1000" placeholder="选一个，或随便聊聊……" required></textarea><div class="input-footer"><span id="char-count">0 / 1000</span><span>Ctrl / ⌘ + Enter 提交</span></div><p id="error" class="error" role="alert" hidden></p><div class="final-consent"><label ${current.finalizing ? '' : 'hidden'}><input type="checkbox" id="final-confirmation"> 我已确认，提交后所有答案将不能修改。</label></div><div class="question-navigation"><button type="button" class="quiet" id="previous-question" ${previous ? '' : 'disabled'}>← 上一题</button>${current.editing ? `<button type="button" class="quiet" id="next-question">${next ? '下一题 →' : '返回当前进度 →'}</button>` : ''}</div><div class="submit-row"><span id="processing">${current.finalizing ? '最后一题已暂存。确认后锁定全部答案。' : current.checking ? '正在确认是否还需要补题，可回看已答题。' : current.editing ? '重新提交后会保存修改，并进入下一题。' : '几个字就好，按你通常的偏好回答。'}</span><button class="primary" id="submit" ${current.checking || current.finalizing ? 'disabled' : ''}>${current.finalizing ? '确认提交并生成结果' : '提交回答'} <span>→</span></button></div></form><nav class="question-list" aria-label="选择题目"><span>跳转题目</span>${record.entries.map((_, index) => `<button type="button" class="question-link ${current.editing && index === current.index ? 'selected' : ''}" data-question="${index}" ${current.editing && index === current.index ? 'aria-current="step"' : ''}>${index + 1}</button>`).join('')}${session.current?.dimension === current.dimension ? `<button type="button" class="question-link ${current.editing ? '' : 'selected'}" id="current-question">${record.entries.length + 1} · 继续答题</button>` : ''}</nav>${current.editing && next ? '<button type="button" class="quiet" id="return-progress">返回当前进度 →</button>' : ''}</div></section>`;
  const textarea = document.querySelector('#answer'), key = draftKey(current);
  textarea.readOnly = Boolean(current.checking); textarea.value = localStorage.getItem(key) ?? (current.editing ? current.answer : '');
  const maxChars = session.limits?.maxAnswerChars || 1000; textarea.removeAttribute('maxlength');
  const update = () => { document.querySelector('#char-count').textContent = `${Array.from(textarea.value).length} / ${maxChars}`; localStorage.setItem(key, textarea.value); };
  const updateFinal = () => {
    if (!current.finalizing) return;
    const changed = textarea.value.trim() !== current.answer;
    const consent = document.querySelector('#final-confirmation');
    consent.disabled = changed;
    document.querySelector('#submit').disabled = !changed && !consent.checked;
    document.querySelector('#submit').innerHTML = `${changed ? '保存修改' : '确认提交并生成结果'} <span>→</span>`;
  };
  update(); updateFinal(); textarea.addEventListener('input', () => { update(); updateFinal(); });
  document.querySelector('#final-confirmation')?.addEventListener('change', updateFinal); textarea.focus({ preventScroll: true });
  textarea.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); document.querySelector('#answer-form').requestSubmit(); } });
  document.querySelector('#answer-form').onsubmit = submit;
  document.querySelector('#previous-question').onclick = () => navigate(previous);
  document.querySelector('#next-question')?.addEventListener('click', () => navigate(next));
  document.querySelector('#return-progress')?.addEventListener('click', () => navigate(null));
  document.querySelector('#current-question')?.addEventListener('click', () => navigate(null));
  for (const button of document.querySelectorAll('[data-question]')) button.onclick = () => navigate({ dimensionIndex: current.dimensionIndex, index: Number(button.dataset.question) });
  for (const button of document.querySelectorAll('[data-dimension]')) button.onclick = () => {
    const dimensionIndex = Number(button.dataset.dimension);
    navigate(session.history[dimensionIndex].entries.length ? { dimensionIndex, index: 0 } : null);
  };
  document.querySelector('#pause').onclick = () => { if (!busy) landing(); };
}
async function submit(e) {
  e.preventDefault(); if (busy || session.answersLocked) return;
  const textarea = document.querySelector('#answer'), answer = textarea.value.trim(); if (!answer) return error('先写一点你的想法，再继续。');
  if (Array.from(answer).length > (session.limits?.maxAnswerChars || 1000)) return error(`回答最多 ${session.limits?.maxAnswerChars || 1000} 字，请稍微精简。`);
  const c = displayedQuestion();
  if (c.checking) return;
  const finalize = c.finalizing && answer === c.answer;
  if (finalize && !document.querySelector('#final-confirmation').checked) return error('请先确认：提交后所有答案将不能修改。');
  busy = true; const key = draftKey(c), button = document.querySelector('#submit'); button.disabled = true; textarea.disabled = true; document.querySelector('#pause').disabled = true;
  document.querySelector('#processing').textContent = '正在保存你的回答…';
  document.querySelector('#error').hidden = true;
  try {
    let updated = session;
    if (finalize) {
      updated = await api(`/api/sessions/${session.id}/finalize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true, revisions: session.history.map(r => r.revision) }) });
    } else if (!c.editing || answer !== c.answer) {
      const payload = c.editing ? { answer, dimension: c.dimension, index: c.index, revision: c.revision } : { answer, dimension: c.dimension, question: c.question, answerCount: c.answerCount };
      updated = await api(`/api/sessions/${session.id}/${c.editing ? 'edit' : 'answers'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }
    localStorage.removeItem(key); session = updated; cursor = finalize || c.finalizing ? null : c.editing ? nextAnswered(c) : null; render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) { error(err.message); button.disabled = false; textarea.disabled = false; document.querySelector('#pause').disabled = false; document.querySelector('#processing').textContent = '回答保留在输入框中，可以重试。'; textarea.focus({ preventScroll: true }); } finally { busy = false; }
}
function results() {
  const result = session.result;
  app.innerHTML = `<section class="result-hero"><span class="eyebrow">YOUR PERSONALITY, IN YOUR WORDS</span><h1>日常选择中的你，<br>更倾向于 <span>${esc(result.type)}</span>。</h1><p>四个字母，是这次对话的起点。<br>真正值得记住的，是你为什么这样选择。</p><div class="result-meta">${session.totalAnswers} 个回答 · 4 个观察角度 · ${result.uncertain ? '部分维度仍有不确定性' : '四维均达到本次访谈的证据阈值'}</div><div class="hero-actions"><a class="primary" href="/api/sessions/${session.id}/export" download>保存完整记录 <span>↓</span></a><button class="quiet" id="again">清空重做 ↗</button></div></section><section class="results-grid">${result.dimensions.map((r, i) => `<article class="result-card"><div class="result-card-head"><div><span class="eyebrow">0${i + 1} / ${dims[i][1]}</span><h2>${esc(r.letter)} <span>${({ E: '外向', I: '内向', N: '直觉', S: '实感', T: '思考', F: '情感', J: '判断', P: '知觉' })[r.letter]}倾向</span></h2></div><span class="pill ${r.uncertain ? 'uncertain' : ''}">${r.uncertain ? '仍待探索' : '倾向明确'}</span></div><div class="confidence"><span>模型主观证据强度 ${Math.round(r.confidence * 100)}%</span><span>${r.count} 个回答</span></div><div class="progress"><div style="width:${r.confidence * 100}%"></div></div><p>${esc(r.reason)}</p><details><summary>看看来自你回答的依据</summary>${r.evidence.map(e => `<blockquote>“${esc(e.quote)}”<small>第 ${e.question} 题 · ${esc(e.interpretation)}</small></blockquote>`).join('') || '<p>有效原文证据不足，因此这一倾向需要更多探索。</p>'}<p class="counter">需要保留的另一面：${esc(r.counterEvidence || '本次回答未提供明显的相反证据，这不意味着不存在。')}</p></details></article>`).join('')}</section><p class="result-disclaimer">结果反映这次访谈中的偏好，不代表固定身份。模型置信度不是校准概率；本应用未经过心理测量效度验证。</p><p id="error" class="error" hidden></p>`;
  document.querySelector('#again').disabled = !session.limits?.remainingTests;
  document.querySelector('#again').onclick = restart;
}
document.querySelector('#about').onclick = () => document.querySelector('#about-dialog').showModal();
document.querySelector('#close-about').onclick = () => document.querySelector('#about-dialog').close();
try { status = await api('/api/status'); landing(); } catch { app.innerHTML = '<p class="error">无法连接本地服务，请检查服务是否启动，然后刷新。</p>'; }
