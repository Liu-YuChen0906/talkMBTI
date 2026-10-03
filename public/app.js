const app = document.querySelector('#app');
const dims = [ ['EI', '能量来源', 'E / I', '你如何与世界相处'], ['NS', '信息偏好', 'N / S', '你如何理解周围的信息'], ['TF', '决策方式', 'T / F', '你如何权衡重要的选择'], ['JP', '生活节奏', 'J / P', '你如何安排与应对变化'] ];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let session = null, busy = false, status;
const getId = () => localStorage.getItem('realmbti-session');
function draftKey() { return `realmbti-draft-${session?.id}-${session?.dimensionIndex}-${session?.current?.answerCount}`; }
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
  app.innerHTML = `<section class="landing"><div class="hero-copy"><div class="eyebrow"><span class="tiny-dot"></span> LESS QUIZ. MORE YOU.</div><h1>你不止是<br>四个<span class="italic">字母。</span></h1><p class="intro">不用在「同意」与「不同意」之间犹豫。<br>聊聊你的经历、选择和感受，<br>让 AI 在真实的故事里，发现你的性格倾向。</p><div class="hero-actions"><button class="primary" id="start">开始认识自己 <span>↗</span></button>${getId() ? '<button class="quiet" id="resume">继续上次的探索 →</button>' : ''}</div><div class="facts"><span>20–40 道开放式问题</span><span>随时暂停 · 自动保存</span></div><p id="error" class="error" hidden></p>${!status.configured ? '<div class="setup"><strong>服务准备中</strong><p>模型服务尚未就绪，请稍后再来。</p></div>' : '<div class="connected"><span class="tiny-dot"></span> 由 DeepSeek 分析 · 回答将发送至模型服务</div>'}</div><div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="art-label top-label">THE WAY YOU SEE</div><div class="blob blob-one">E<span>向外连接</span></div><div class="blob blob-two">N<span>发现可能</span></div><div class="blob blob-three">F<span>感受价值</span></div><div class="blob blob-four">P<span>自由探索</span></div><div class="art-center">you<span>独一无二的交点</span></div><div class="art-label bottom-label">NOT A BOX. A STARTING POINT.</div></div></section><section class="how"><div><span class="eyebrow">FOUR LENSES, ONE YOU</span><h2>从四个角度，<br>慢慢看清自己。</h2></div><div class="dimension-grid">${dims.map((d, i) => `<div class="dimension-card"><span class="number">0${i + 1}</span><strong>${d[2]}</strong><h3>${d[1]}</h3><p>${d[3]}</p></div>`).join('')}</div></section>`;
  document.querySelector('#start').onclick = start;
  document.querySelector('#resume')?.addEventListener('click', resume);
  const note = document.createElement('p'); note.className = 'quota-note';
  note.textContent = `无需注册 · 今天还可开始 ${status.limits?.remainingTests ?? 1} 次探索。已有访谈可继续；网络共享额度也可能影响使用。额度每天北京时间零点重置。`;
  document.querySelector('.hero-copy').append(note);
}
async function start() {
  if (getId() && !confirm('开始新的探索？已有记录仍保存在本机，但快捷续答入口会切换到新记录。')) return;
  const button = document.querySelector('#start'); button.disabled = true;
  try { session = await api('/api/sessions', { method: 'POST' }); localStorage.setItem('realmbti-session', session.id); render(); } catch (e) { error(e.message); button.disabled = false; }
}
async function resume() { try { session = await api(`/api/sessions/${getId()}`); render(); } catch (e) { error(e.message); } }
function render() { if (session.limits) status.limits = session.limits; session.complete ? results() : interview(); }
function interview() {
  const current = session.current, d = dims[session.dimensionIndex];
  app.innerHTML = `<section class="workspace"><aside class="sidebar"><span class="eyebrow">YOUR EXPLORATION</span><h2>一点一点，<br>靠近真实的你。</h2><nav aria-label="访谈进度">${dims.map((dim, i) => `<div class="step ${i === session.dimensionIndex ? 'active' : ''} ${i < session.dimensionIndex ? 'done' : ''}"><span class="step-icon">${i < session.dimensionIndex ? '✓' : `0${i + 1}`}</span><div><strong>${dim[1]}</strong><small>${i < session.dimensionIndex ? '已暂存 · 最后揭晓' : dim[2]}</small></div>${i === session.dimensionIndex ? '<span class="tiny-dot"></span>' : ''}</div>`).join('')}</nav><div class="save-note"><span>◌</span><p>已回答 ${session.totalAnswers} 题<br>已提交的回答已保存。<br>这一维结束后，AI 会开启新的上下文。</p></div><button id="pause" class="quiet">← 暂停并返回</button></aside><div class="question-panel"><div class="question-top"><span class="eyebrow">CHAPTER 0${session.dimensionIndex + 1} / ${d[1]}</span><span class="question-count">${current.answerCount + 1}<span> / 最多 10 题</span></span></div><div class="progress"><div style="width:${current.answerCount * 10}%"></div></div><div class="question-copy"><span class="pill">${current.answerCount >= 5 ? '根据你的故事，继续深入' : '从一个真实的场景开始'}</span><h1>${esc(current.question)}</h1><p>没有标准答案。可以说说你会怎么做，也可以讲一段真实经历。</p></div><form id="answer-form"><label for="answer" class="sr-only">你的回答</label><textarea id="answer" maxlength="1000" placeholder="我通常会……因为……\n比如有一次……" required></textarea><div class="input-footer"><span id="char-count">0 / 1000</span><span>Ctrl / ⌘ + Enter 提交</span></div><p id="error" class="error" role="alert" hidden></p><div class="submit-row"><span id="processing">${current.answerCount < 4 ? '至少回答 5 题后，AI 开始评估这一维。' : 'AI 会根据证据决定是否需要继续提问。'}</span><button class="primary" id="submit">提交回答 <span>→</span></button></div></form>${current.entries.length ? `<details class="history"><summary>回看这一维的 ${current.entries.length} 个回答</summary>${current.entries.map((e, i) => `<article><small>QUESTION ${i + 1}</small><h3>${esc(e.question)}</h3><p>${esc(e.answer)}</p></article>`).join('')}</details>` : ''}</div></section>`;
  const textarea = document.querySelector('#answer'); textarea.value = localStorage.getItem(draftKey()) || '';
  const maxChars = session.limits?.maxAnswerChars || 1000; textarea.removeAttribute('maxlength');
  const update = () => { document.querySelector('#char-count').textContent = `${Array.from(textarea.value).length} / ${maxChars}`; localStorage.setItem(draftKey(), textarea.value); };
  update(); textarea.addEventListener('input', update);
  textarea.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); document.querySelector('#answer-form').requestSubmit(); } });
  document.querySelector('#answer-form').onsubmit = submit;
  document.querySelector('#pause').onclick = () => { if (!busy) landing(); };
}
async function submit(e) {
  e.preventDefault(); if (busy) return;
  const textarea = document.querySelector('#answer'), answer = textarea.value.trim(); if (!answer) return error('先写一点你的想法，再继续。');
  if (Array.from(answer).length > (session.limits?.maxAnswerChars || 1000)) return error(`回答最多 ${session.limits?.maxAnswerChars || 1000} 字，请稍微精简。`);
  busy = true; const key = draftKey(), button = document.querySelector('#submit'); button.disabled = true; textarea.disabled = true; document.querySelector('#pause').disabled = true;
  document.querySelector('#processing').textContent = session.current.answerCount >= 4 ? 'AI 正在阅读你的故事、核对证据，请稍候…' : '正在保存你的回答…';
  document.querySelector('#error').hidden = true;
  try {
    const c = session.current; const next = await api(`/api/sessions/${session.id}/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer, dimension: c.dimension, question: c.question, answerCount: c.answerCount }) });
    localStorage.removeItem(key); session = next; render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) { error(err.message); button.disabled = false; textarea.disabled = false; document.querySelector('#pause').disabled = false; document.querySelector('#processing').textContent = '回答保留在输入框中，可以重试。'; } finally { busy = false; }
}
function results() {
  const result = session.result;
  app.innerHTML = `<section class="result-hero"><span class="eyebrow">YOUR PERSONALITY, IN YOUR WORDS</span><h1>故事里的你，<br>更倾向于 <span>${esc(result.type)}</span>。</h1><p>四个字母，是这次对话的起点。<br>真正值得记住的，是你为什么这样选择。</p><div class="result-meta">${session.totalAnswers} 个回答 · 4 个观察角度 · ${result.uncertain ? '部分维度仍有不确定性' : '四维均达到本次访谈的证据阈值'}</div><div class="hero-actions"><a class="primary" href="/api/sessions/${session.id}/export" download>保存完整记录 <span>↓</span></a><button class="quiet" id="again">重新探索 ↗</button></div></section><section class="results-grid">${result.dimensions.map((r, i) => `<article class="result-card"><div class="result-card-head"><div><span class="eyebrow">0${i + 1} / ${dims[i][1]}</span><h2>${esc(r.letter)} <span>${({ E: '外向', I: '内向', N: '直觉', S: '实感', T: '思考', F: '情感', J: '判断', P: '知觉' })[r.letter]}倾向</span></h2></div><span class="pill ${r.uncertain ? 'uncertain' : ''}">${r.uncertain ? '仍待探索' : '倾向明确'}</span></div><div class="confidence"><span>模型主观证据强度 ${Math.round(r.confidence * 100)}%</span><span>${r.count} 个回答</span></div><div class="progress"><div style="width:${r.confidence * 100}%"></div></div><p>${esc(r.reason)}</p><details><summary>看看来自你回答的依据</summary>${r.evidence.map(e => `<blockquote>“${esc(e.quote)}”<small>第 ${e.question} 题 · ${esc(e.interpretation)}</small></blockquote>`).join('') || '<p>有效原文证据不足，因此这一倾向需要更多探索。</p>'}<p class="counter">需要保留的另一面：${esc(r.counterEvidence || '本次回答未提供明显的相反证据，这不意味着不存在。')}</p></details></article>`).join('')}</section><p class="result-disclaimer">结果反映这次访谈中的偏好，不代表固定身份。模型置信度不是校准概率；本应用未经过心理测量效度验证。</p><p id="error" class="error" hidden></p>`;
  document.querySelector('#again').onclick = () => { landing(); start(); };
}
document.querySelector('#about').onclick = () => document.querySelector('#about-dialog').showModal();
document.querySelector('#close-about').onclick = () => document.querySelector('#about-dialog').close();
try { status = await api('/api/status'); landing(); } catch { app.innerHTML = '<p class="error">无法连接本地服务，请检查服务是否启动，然后刷新。</p>'; }
