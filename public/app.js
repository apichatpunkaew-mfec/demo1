// Frontend JS for Dynatrace + AI Dashboard
// Pure browser ES module. No bundler, no frameworks.

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
  health:       $('#health'),
  filterStatus: $('#filter-status'),
  filterSev:    $('#filter-severity'),
  filterSize:   $('#filter-pagesize'),
  summary:      $('#summary'),
  tbody:        $('#problems-tbody'),
  refresh:      $('#btn-refresh'),
  analyzeAll:   $('#btn-analyze-all'),
  modelSelect:  $('#model-select'),
  modal:        $('#modal'),
  modalTitle:   $('#modal-title'),
  modalBody:    $('#modal-body'),
  modalClose:   $('#modal-close'),
  askAi:        $('#btn-ask-ai'),
  // Chat
  chatFab:      $('#chat-fab'),
  chatPanel:    $('#chat-panel'),
  chatLog:      $('#chat-log'),
  chatForm:     $('#chat-form'),
  chatText:     $('#chat-text'),
  chatSend:     $('#chat-send'),
  chatClose:    $('#chat-close'),
  chatClear:    $('#chat-clear'),
  chatContext:  $('#chat-context'),
};

let currentProblems = [];
let availableModels = [];
let busy = false;

// Chat state — persistent across the page session, cleared by "Clear" or
// by attaching a different problem.
const chatState = {
  sessionId: 'sess-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36),
  open: false,
  streaming: false,
  attachedProblem: null,   // { problemId, title } | null
};

/* ------------------------------ helpers --------------------------- */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || res.statusText;
    throw new Error('HTTP ' + res.status + ': ' + msg);
  }
  return data;
}

/**
 * Post JSON and return a Response (caller streams the body). Throws on non-2xx.
 */
async function apiPostStream(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* ignore */ }
    throw new Error('HTTP ' + res.status + ': ' + (detail || res.statusText));
  }
  return res;
}

function fmtTime(ms) {
  if (!ms || ms < 0) return '-';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function entityChip(e) {
  return '<span class="entity" title="' + escapeHtml(e.entityId?.id || '') + '">' +
    '<span class="name">' + escapeHtml(e.name || e.entityId?.id || '?') + '</span>' +
    ' <span class="muted">[' + escapeHtml(e.entityId?.type || '') + ']</span>' +
  '</span>';
}

function setBusy(b) {
  busy = b;
  els.refresh.disabled = b;
  els.analyzeAll.disabled = b;
  $$('.row-actions .btn').forEach((btn) => (btn.disabled = b));
}

/* ------------------------------ loading --------------------------- */
async function loadHealth() {
  try {
    const h = await api('GET', '/api/health');
    els.health.innerHTML =
      '<span>Status: <b class="ok">' + escapeHtml(h.status) + '</b></span>' +
      '<span>Dynatrace: ' + (h.dynatrace.configured
        ? '<span class="ok">configured</span>'
        : '<span class="bad">missing token</span>') +
        ' &nbsp;<span class="muted">' + escapeHtml(h.dynatrace.baseUrl) + '</span></span>' +
      '<span>AI: ' + (h.ai.configured
        ? '<span class="ok">configured</span>'
        : '<span class="bad">missing key</span>') +
        ' &nbsp;<span class="muted">' + escapeHtml(h.ai.baseUrl) + ' &middot; ' + escapeHtml(h.ai.model || '(no model)') + '</span></span>';
  } catch (e) {
    els.health.innerHTML = '<span class="bad">Health failed: ' + escapeHtml(e.message) + '</span>';
  }
}

async function loadModels() {
  try {
    const data = await api('GET', '/api/models');
    availableModels = (data.data || []).map((m) => m.id);
    els.modelSelect.innerHTML = availableModels
      .map((id) => '<option value="' + escapeHtml(id) + '">' + escapeHtml(id) + '</option>')
      .join('');
  } catch (e) {
    els.modelSelect.innerHTML = '<option value="">(failed to load)</option>';
  }
}

/* ------------------------------ problems -------------------------- */
async function loadProblems() {
  const params = new URLSearchParams();
  if (els.filterStatus.value) params.set('status', els.filterStatus.value);
  if (els.filterSev.value)    params.set('severity', els.filterSev.value);
  if (els.filterSize.value)   params.set('pageSize', els.filterSize.value);

  els.tbody.innerHTML = '<tr><td colspan="7" class="empty">Loading&hellip;</td></tr>';
  try {
    const data = await api('GET', '/api/problems?' + params.toString());
    currentProblems = data.problems || [];
    renderSummary(data.summary);
    renderRows(currentProblems);
  } catch (e) {
    els.tbody.innerHTML =
      '<tr><td colspan="7" class="empty">' +
      '<span class="bad">Failed to load problems:</span> ' + escapeHtml(e.message) +
      '</td></tr>';
    renderSummary({ total: 0, open: 0, bySeverity: {}, byStatus: {} });
  }
}

function renderSummary(s) {
  if (!s) s = { total: 0, open: 0, bySeverity: {}, byStatus: {} };
  const sevLabel = {
    AVAILABILITY: 'Availability',
    ERROR: 'Errors',
    PERFORMANCE: 'Performance',
    RESOURCE_CONTENTION: 'Resource',
    MONITORING_UNAVAILABLE: 'Monitoring unavailable',
    CUSTOM_ALERT: 'Custom alerts',
    INFORMATION: 'Info',
  };
  const cards = [
    { label: 'Open', value: s.open ?? 0 },
    { label: 'Total (page)', value: s.total ?? 0 },
  ];
  for (const [sev, label] of Object.entries(sevLabel)) {
    cards.push({ label, value: s.bySeverity?.[sev] || 0, klass: sev.toLowerCase().replace(/_/g, '-') });
  }
  els.summary.innerHTML = cards.map((c) =>
    '<div class="card ' + (c.klass || '') + '">' +
      '<div class="label">' + escapeHtml(c.label) + '</div>' +
      '<div class="value">' + escapeHtml(c.value) + '</div>' +
    '</div>').join('');
}

function renderRows(problems) {
  if (!problems.length) {
    els.tbody.innerHTML = '<tr><td colspan="7" class="empty">No problems match the current filters.</td></tr>';
    return;
  }
  els.tbody.innerHTML = problems.map((p) => {
    const id = p.problemId || p.displayId || '?';
    const aff = (p.affectedEntities || p.impactedEntities || [])
      .slice(0, 3)
      .map(entityChip).join('');
    const more = ((p.affectedEntities?.length || 0) > 3 || (p.impactedEntities?.length || 0) > 3)
      ? '<span class="entity muted">+ more</span>' : '';
    return '<tr data-id="' + escapeHtml(id) + '">' +
      '<td><code>' + escapeHtml(p.displayId || id) + '</code></td>' +
      '<td>' + escapeHtml(p.title || '') + '</td>' +
      '<td><span class="badge sev-' + escapeHtml(p.severityLevel) + '">' + escapeHtml(p.severityLevel) + '</span></td>' +
      '<td><span class="badge st-' + escapeHtml(p.status) + '">' + escapeHtml(p.status) + '</span></td>' +
      '<td>' + aff + more + '</td>' +
      '<td>' + escapeHtml(fmtTime(p.startTime)) + '</td>' +
      '<td class="row-actions">' +
        '<button class="btn" data-action="details">Details</button>' +
        '<button class="btn primary" data-action="analyze">&#129302; Analyze</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

/* ------------------------------ modal ----------------------------- */
function openModal() { els.modal.classList.remove('hidden'); }
function closeModal() { els.modal.classList.add('hidden'); els.modalBody.innerHTML = ''; }

function renderAnalysis(problem, result) {
  const a = result.analysis;
  const usage = result.usage || {};
  if (!a) {
    return '<p class="bad">The AI returned a response but it wasn\'t parseable JSON.</p>' +
      '<h3>Raw model output</h3>' +
      '<pre>' + escapeHtml(result.raw) + '</pre>' +
      (result.parseError ? '<p class="muted">parse error: ' + escapeHtml(result.parseError) + '</p>' : '');
  }
  const conf = (typeof a.confidence === 'number')
    ? ' <span class="muted">(confidence ' + Math.round(a.confidence * 100) + '%)</span>'
    : '';
  const actions = (a.recommendedActions || []).map((x) => '<li>' + escapeHtml(x) + '</li>').join('') || '<li class="muted">none</li>';
  const runs = (a.runbooks || []).map((x) => '<li>' + escapeHtml(x) + '</li>').join('') || '<li class="muted">none</li>';
  return '<h3>Problem</h3>' +
    '<p><b>' + escapeHtml(problem.title || problem.displayId || '') + '</b>' +
      ' &nbsp;<span class="badge sev-' + escapeHtml(problem.severityLevel) + '">' + escapeHtml(problem.severityLevel) + '</span>' +
      ' &nbsp;<span class="badge st-' + escapeHtml(problem.status) + '">' + escapeHtml(problem.status) + '</span>' +
    '</p>' +
    '<h3>Summary</h3><p>' + escapeHtml(a.summary || '-') + '</p>' +
    '<h3>Likely root cause</h3><p>' + escapeHtml(a.likelyRootCause || '-') + '</p>' +
    '<h3>Impact</h3><p>' + escapeHtml(a.impact || '-') + '</p>' +
    '<h3>Severity assessment ' + escapeHtml(a.severity || '') + conf + '</h3>' +
    '<h3>Recommended actions</h3><ul>' + actions + '</ul>' +
    '<h3>Runbook / checklist</h3><ul>' + runs + '</ul>' +
    '<h3>Model</h3>' +
    '<p class="muted">' + escapeHtml(result.model || '') + ' &middot; ' +
      'tokens ' + escapeHtml(usage.total_tokens || usage.total || '?') +
      ' (prompt ' + escapeHtml(usage.prompt_tokens || '?') +
      ' + completion ' + escapeHtml(usage.completion_tokens || '?') + ')</p>';
}

async function showProblemDetails(problemId) {
  openModal();
  els.modalTitle.textContent = 'Problem ' + problemId;
  els.modalBody.innerHTML = '<p><span class="spinner"></span>Loading details&hellip;</p>';
  els.modalBody.dataset.currentProblemId = problemId;
  els.modalBody.dataset.currentProblemTitle = problemId;
  try {
    const data = await api('GET', '/api/problems/' + encodeURIComponent(problemId));
    const affected = (data.affectedEntities || []).map(entityChip).join(' ');
    const tags = (data.entityTags || []).map((t) =>
      '<span class="entity">' + escapeHtml(t.stringRepresentation || (t.key + ':' + t.value)) + '</span>'
    ).join(' ') || '<span class="muted">none</span>';
    const zones = (data.managementZones || []).map((z) =>
      '<span class="entity">' + escapeHtml(z.name) + '</span>'
    ).join(' ') || '<span class="muted">none</span>';
    const root = data.rootCauseEntity
      ? escapeHtml(data.rootCauseEntity.name) + ' <span class="muted">[' + escapeHtml(data.rootCauseEntity.entityId?.type || '') + ']</span>'
      : '<span class="muted">none identified</span>';
    els.modalBody.innerHTML =
      '<h3>' + escapeHtml(data.title || '') + '</h3>' +
      '<p class="muted" style="margin-top:-6px">problemId: ' + escapeHtml(problemId) + '</p>';
      '<p>' +
        '<span class="badge sev-' + escapeHtml(data.severityLevel) + '">' + escapeHtml(data.severityLevel) + '</span>' +
        ' <span class="badge st-' + escapeHtml(data.status) + '">' + escapeHtml(data.status) + '</span>' +
        ' <span class="muted">impact ' + escapeHtml(data.impactLevel || '') + '</span>' +
      '</p>' +
      '<h3>Affected entities</h3><p>' + (affected || '<span class="muted">none</span>') + '</p>' +
      '<h3>Root cause</h3><p>' + root + '</p>' +
      '<h3>Tags</h3><p>' + tags + '</p>' +
      '<h3>Management zones</h3><p>' + zones + '</p>' +
      '<h3>Raw payload</h3>' +
      '<pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>';
  } catch (e) {
    els.modalBody.innerHTML = '<p class="err">Failed: ' + escapeHtml(e.message) + '</p>';
  }
}

async function analyzeProblem(problemId) {
  openModal();
  els.modalTitle.textContent = 'AI analysis — ' + problemId;
  els.modalBody.innerHTML = '<p><span class="spinner"></span>Analyzing with AI&hellip;</p>';
  els.modalBody.dataset.currentProblemId = problemId;
  els.modalBody.dataset.currentProblemTitle = problemId;
  try {
    const model = els.modelSelect.value || '';
    const url = '/api/analyze/' + encodeURIComponent(problemId) + (model ? '?model=' + encodeURIComponent(model) : '');
    const result = await api('GET', url);
    els.modalBody.innerHTML = renderAnalysis(result.problem, result.analysis);
    if (result.problem && result.problem.title) {
      els.modalBody.dataset.currentProblemTitle = result.problem.title;
    }
  } catch (e) {
    els.modalBody.innerHTML = '<p class="err">Analysis failed: ' + escapeHtml(e.message) + '</p>';
  }
}

async function analyzeAllOpen() {
  if (busy) return;
  if (!currentProblems.length) return;
  setBusy(true);
  openModal();
  els.modalTitle.textContent = 'AI batch analysis';
  els.modalBody.innerHTML = '<p><span class="spinner"></span>Analyzing ' + currentProblems.length + ' problem(s)…</p>';
  try {
    const model = els.modelSelect.value || '';
    const result = await api('POST', '/api/analyze-all', {
      limit: currentProblems.length,
      status: els.filterStatus.value || 'OPEN',
      model,
    });
    const html = (result.results || []).map((r) => {
      const p = r.problem || {};
      if (!r.ok) {
        return '<h3>' + escapeHtml(p.displayId || p.problemId || '?') + ' — ' + escapeHtml(p.title || '') + '</h3>' +
          '<p class="err">' + escapeHtml(r.error) + '</p>';
      }
      return '<hr><h3>' + escapeHtml(p.displayId || p.problemId || '?') + ' — ' + escapeHtml(p.title || '') + '</h3>' +
        renderAnalysis(p, r.analysis);
    }).join('') || '<p class="muted">No problems to analyze.</p>';
    els.modalBody.innerHTML = '<p class="muted">Analyzed ' + result.count + ' problem(s).</p>' + html;
  } catch (e) {
    els.modalBody.innerHTML = '<p class="err">Batch analysis failed: ' + escapeHtml(e.message) + '</p>';
  } finally {
    setBusy(false);
  }
}

/* ------------------------------ chat ------------------------------ */
function renderChatEmpty() {
  els.chatLog.innerHTML = '<div class="chat-empty muted">Ask anything about Dynatrace problems or paste a problem from the table to discuss it.</div>';
}

function scrollChatToBottom() {
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function appendChatMessage(role, content, opts = {}) {
  // Remove the empty hint if it's still there.
  const empty = els.chatLog.querySelector('.chat-empty');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = 'chat-msg ' + role + (opts.streaming ? ' streaming' : '');
  if (role !== 'system') {
    const roleLabel = document.createElement('span');
    roleLabel.className = 'role';
    roleLabel.textContent = opts.roleLabel || (role === 'user' ? 'You' : 'AI');
    div.appendChild(roleLabel);
  }
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = content;
  div.appendChild(text);
  if (opts.id) div.dataset.msgId = opts.id;
  els.chatLog.appendChild(div);
  scrollChatToBottom();
  return div;
}

function updateChatMessage(id, content, streaming) {
  const div = els.chatLog.querySelector('[data-msg-id="' + id + '"]');
  if (!div) return;
  const text = div.querySelector('.text');
  if (text) text.textContent = content;
  div.classList.toggle('streaming', !!streaming);
  scrollChatToBottom();
}

function setChatBusy(b) {
  chatState.streaming = b;
  els.chatSend.disabled = b;
  els.chatSend.textContent = b ? '…' : 'Send';
  els.chatClear.disabled = b;
}

function updateChatContext() {
  if (chatState.attachedProblem) {
    els.chatContext.textContent = '· ' + chatState.attachedProblem.title + ' (' + chatState.attachedProblem.problemId + ')';
    els.chatContext.title = chatState.attachedProblem.title;
  } else {
    els.chatContext.textContent = '';
    els.chatContext.title = '';
  }
}

function openChat() {
  if (chatState.open) return;
  chatState.open = true;
  els.chatPanel.classList.remove('hidden');
  els.chatFab.classList.add('hidden');
  els.chatText.focus();
}

function closeChat() {
  chatState.open = false;
  els.chatPanel.classList.add('hidden');
  els.chatFab.classList.remove('hidden');
}

async function attachProblemToChat(problemId, problemTitle) {
  try {
    await api('POST', '/api/chat/attach-problem', {
      sessionId: chatState.sessionId,
      problemId,
    });
    chatState.attachedProblem = { problemId, title: problemTitle || problemId };
    updateChatContext();
    renderChatEmpty();
    appendChatMessage('system', '📎 Now discussing: ' + chatState.attachedProblem.title);
    openChat();
  } catch (e) {
    appendChatMessage('error', 'Could not attach problem: ' + e.message);
  }
}

async function clearChat() {
  if (chatState.streaming) return;
  try {
    await api('POST', '/api/chat/clear', { sessionId: chatState.sessionId });
  } catch { /* ignore — local clear still works */ }
  chatState.attachedProblem = null;
  updateChatContext();
  renderChatEmpty();
}

/**
 * Auto-grow the textarea up to its CSS max-height.
 */
function autoresizeTextarea() {
  const ta = els.chatText;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
}

async function sendChatMessage(text) {
  if (!text || !text.trim()) return;
  if (chatState.streaming) return;

  setChatBusy(true);
  appendChatMessage('user', text.trim());

  const botId = 'bot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  appendChatMessage('bot', '', { id: botId, streaming: true, roleLabel: 'AI' });

  let acc = '';
  try {
    const res = await apiPostStream('/api/chat/stream', {
      sessionId: chatState.sessionId,
      message: text.trim(),
      model: els.modelSelect.value || undefined,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let sawError = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Parse SSE events (blank-line delimited).
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let eventName = 'message';
        const dataLines = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        const payload = dataLines.join('\n');
        if (!payload) continue;
        try {
          const json = JSON.parse(payload);
          if (eventName === 'chunk' && json.delta) {
            acc += json.delta;
            updateChatMessage(botId, acc, true);
          } else if (eventName === 'done') {
            if (json.reply) acc = json.reply;
          } else if (eventName === 'error') {
            sawError = json.error || 'unknown error';
          }
        } catch { /* ignore malformed */ }
      }
    }
    if (sawError) {
      updateChatMessage(botId, '⚠️ ' + sawError, false);
      const div = els.chatLog.querySelector('[data-msg-id="' + botId + '"]');
      if (div) div.classList.remove('streaming');
    } else {
      updateChatMessage(botId, acc, false);
    }
  } catch (e) {
    updateChatMessage(botId, '⚠️ ' + e.message, false);
  } finally {
    setChatBusy(false);
    els.chatText.focus();
  }
}

/* ------------------------------ events ---------------------------- */
els.refresh.addEventListener('click', () => loadProblems());
els.analyzeAll.addEventListener('click', () => analyzeAllOpen());
els.modalClose.addEventListener('click', () => closeModal());
els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

[els.filterStatus, els.filterSev, els.filterSize].forEach((el) => {
  el.addEventListener('change', () => loadProblems());
});

els.tbody.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const tr = btn.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.getAttribute('data-id');
  if (btn.dataset.action === 'details') showProblemDetails(id);
  if (btn.dataset.action === 'analyze') analyzeProblem(id);
});

/* ---- chat wiring ---- */
els.chatFab.addEventListener('click', openChat);
els.chatClose.addEventListener('click', closeChat);
els.chatClear.addEventListener('click', clearChat);

els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.chatText.value;
  els.chatText.value = '';
  autoresizeTextarea();
  sendChatMessage(text);
});

els.chatText.addEventListener('input', autoresizeTextarea);
els.chatText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.chatForm.requestSubmit();
  }
});

els.askAi.addEventListener('click', () => {
  // Find the most recently rendered problem in the modal-body (carried via
  // data attributes set by the analysis/details renderers) OR fall back to
  // a small inline input dialog for the problem id.
  const id = els.modalBody.dataset.currentProblemId;
  const title = els.modalBody.dataset.currentProblemTitle || id;
  if (!id) {
    appendChatMessage('error', 'Open a problem details/analysis modal first, then click "Ask AI".');
    openChat();
    return;
  }
  attachProblemToChat(id, title);
});

// Show the floating chat button once everything else is ready.
els.chatFab.classList.remove('hidden');

/* ------------------------------ boot ------------------------------ */
(async function init() {
  await loadHealth();
  await loadModels();
  await loadProblems();
})();

