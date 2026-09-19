/* ===================================================================
 *                       A P I   T E S T E R
 * ===================================================================
 *  A floating panel that lets you hit every endpoint in the app,
 *  edit the request payload, save presets (localStorage), and watch
 *  the response inline. Endpoint catalog is the single source of
 *  truth — update it whenever a route is added/changed on the server.
 * =================================================================== */

/**
 * Endpoint catalog. Each entry has:
 *   id        — stable key used in history & presets
 *   method    — HTTP verb
 *   path      — path template with :param placeholders
 *   title     — short label shown in the dropdown
 *   group     — bucket for visual organization in the dropdown
 *   desc      — what this endpoint does (shown in UI)
 *   rateLimit — hint to user (matches server config)
 *   body      — sample JSON body (POST only). Use null to disable.
 *   query     — array of default {key,value} for query params
 *   pathParams— array of {name, sample} for path placeholders
 *   stream    — true if it returns SSE (chat/stream)
 */
const TESTER_ENDPOINTS = [
  // ----- meta -----
  {
    id: 'health', method: 'GET', path: '/api/health',
    group: 'meta', title: 'Health',
    desc: 'Liveness + config summary (Dynatrace + AI).',
    rateLimit: 'none',
    body: null,
  },
  {
    id: 'models', method: 'GET', path: '/api/models',
    group: 'meta', title: 'AI models',
    desc: 'List available AI models from the gateway.',
    rateLimit: 'none',
    body: null,
  },
  {
    id: 'admin-latency', method: 'GET', path: '/api/admin/latency',
    group: 'meta', title: 'AI latency stats',
    desc: 'Per-model p50/p95 latency for chat calls.',
    rateLimit: 'none',
    body: null,
  },
  {
    id: 'admin-chat', method: 'GET', path: '/api/admin/chat',
    group: 'meta', title: 'Chat session stats',
    desc: 'Counts of active chat sessions in memory.',
    rateLimit: 'none',
    body: null,
  },

  // ----- problems -----
  {
    id: 'problems-list', method: 'GET', path: '/api/problems',
    group: 'problems', title: 'List problems',
    desc: 'Paginated list of problems (filter by status, severity, pageSize).',
    rateLimit: 'none',
    body: null,
    query: [
      { key: 'status',   value: 'OPEN' },
      { key: 'severity', value: '' },
      { key: 'pageSize', value: '5' },
    ],
  },
  {
    id: 'problems-get', method: 'GET', path: '/api/problems/:problemId',
    group: 'problems', title: 'Get problem by id',
    desc: 'Fetch a single problem with details + recent comments.',
    rateLimit: 'none',
    body: null,
    pathParams: [{ name: 'problemId', sample: 'P-12345' }],
  },

  // ----- analyze -----
  {
    id: 'analyze-post', method: 'POST', path: '/api/analyze',
    group: 'analyze', title: 'Analyze problem payload',
    desc: 'Analyze a problem object supplied inline (no Dynatrace fetch).',
    rateLimit: '20/min/IP',
    body: {
      problem: {
        problemId: 'P-12345',
        title: 'CPU saturation on host web-01',
        severity: 'PERFORMANCE',
        status: 'OPEN',
        affectedEntities: [{ entityId: { id: 'HOST-1234', type: 'HOST' }, name: 'web-01' }],
      },
      model: '',
      promptVariant: 'default',
    },
  },
  {
    id: 'analyze-id', method: 'GET', path: '/api/analyze/:problemId',
    group: 'analyze', title: 'Analyze by id',
    desc: 'Fetch the problem from Dynatrace, then analyze it.',
    rateLimit: '20/min/IP',
    body: null,
    pathParams: [{ name: 'problemId', sample: 'P-12345' }],
    query: [{ key: 'model', value: '' }],
  },
  {
    id: 'analyze-all', method: 'POST', path: '/api/analyze-all',
    group: 'analyze', title: 'Batch analyze',
    desc: 'Analyze the top N OPEN problems in parallel.',
    rateLimit: '20/min/IP',
    body: { limit: 2, model: '' },
  },

  // ----- chat -----
  {
    id: 'chat-attach', method: 'POST', path: '/api/chat/attach-problem',
    group: 'chat', title: 'Chat: attach problem',
    desc: 'Pin a problem as the chat context for the given session.',
    rateLimit: '30/min/IP',
    body: { sessionId: '__SESSION__', problemId: 'P-12345' },
  },
  {
    id: 'chat-clear', method: 'POST', path: '/api/chat/clear',
    group: 'chat', title: 'Chat: clear session',
    desc: 'Drop the session history (server + local).',
    rateLimit: '30/min/IP',
    body: { sessionId: '__SESSION__' },
  },
  {
    id: 'chat-send', method: 'POST', path: '/api/chat',
    group: 'chat', title: 'Chat: send message',
    desc: 'Send a message to the AI and get a single JSON reply.',
    rateLimit: '30/min/IP',
    body: {
      sessionId: '__SESSION__',
      message: 'Why is this problem happening?',
      model: '',
      temperature: 0.2,
      maxTokens: 256,
    },
  },
  {
    id: 'chat-stream', method: 'POST', path: '/api/chat/stream',
    group: 'chat', title: 'Chat: stream (SSE)',
    desc: 'Same as /api/chat but replies via Server-Sent Events.',
    rateLimit: '30/min/IP',
    stream: true,
    body: {
      sessionId: '__SESSION__',
      message: 'Explain in 3 bullet points.',
      model: '',
      temperature: 0.2,
      maxTokens: 256,
    },
  },
];

const tester = {
  open: false,
  selectedId: 'health',
  presetsKey: 'dynatrace-ai-tester-presets-v1',
  history: [],   // newest first; cap to 25 entries
};
const testerEls = {
  panel:       document.querySelector('#tester-panel'),
  openBtn:     document.querySelector('#btn-open-tester'),
  closeBtn:    document.querySelector('#tester-close'),
  endpoint:    document.querySelector('#tester-endpoint'),
  method:      document.querySelector('#tester-method'),
  pathPreview: document.querySelector('#tester-path-preview'),
  description: document.querySelector('#tester-description'),
  rateLimit:   document.querySelector('#tester-rate-limit'),
  bodyRow:     document.querySelector('#tester-body-row'),
  body:        document.querySelector('#tester-body'),
  bodyStatus:  document.querySelector('#tester-body-status'),
  queryRow:    document.querySelector('#tester-query-row'),
  queryList:   document.querySelector('#tester-query-list'),
  addQuery:    document.querySelector('#tester-add-query'),
  pathRow:     document.querySelector('#tester-path-row'),
  pathList:    document.querySelector('#tester-path-list'),
  fillFromRow: document.querySelector('#tester-fill-from-row'),
  formatBody:  document.querySelector('#tester-format-body'),
  resetBody:   document.querySelector('#tester-reset-body'),
  send:        document.querySelector('#tester-send'),
  stream:      document.querySelector('#tester-stream'),
  response:    document.querySelector('#tester-response'),
  history:     document.querySelector('#tester-history'),
  runAll:      document.querySelector('#tester-run-all'),
  clearHist:   document.querySelector('#tester-clear-history'),
};

let testerBusy = false;

/* ---------- helpers ---------- */

function $escape(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function testerGetSelected() {
  return TESTER_ENDPOINTS.find((e) => e.id === tester.selectedId) || TESTER_ENDPOINTS[0];
}

function testerLoadPresets() {
  try { return JSON.parse(localStorage.getItem(tester.presetsKey) || '{}'); }
  catch { return {}; }
}
function testerSavePresets(map) {
  try { localStorage.setItem(tester.presetsKey, JSON.stringify(map)); }
  catch { /* quota */ }
}
function testerGetPreset(id) {
  const all = testerLoadPresets();
  return all[id] || {};
}
function testerSetPreset(id, data) {
  const all = testerLoadPresets();
  all[id] = { ...(all[id] || {}), ...data };
  testerSavePresets(all);
}

/** Replace __SESSION__ placeholder in body with the live chat session id. */
function testerResolveBody(body) {
  if (!body || typeof body !== 'object') return body;
  const liveSid = (window.chatState && window.chatState.sessionId)
    || (window.crypto && crypto.randomUUID && crypto.randomUUID())
    || ('sess-' + Math.random().toString(36).slice(2, 10));
  const json = JSON.stringify(body);
  return JSON.parse(json.replaceAll('"__SESSION__"', '"' + liveSid + '"'));
}

function testerResolvePath(template, params) {
  return template.replace(/:([a-zA-Z_][\w-]*)/g, (_, k) => {
    const v = params[k];
    if (!v) throw new Error('Missing path param: ' + k);
    return encodeURIComponent(v);
  });
}

function testerBuildQuery(arr) {
  const entries = arr.filter((kv) => kv.key && kv.key.trim() !== '');
  if (!entries.length) return '';
  const usp = new URLSearchParams();
  for (const kv of entries) usp.append(kv.key, kv.value);
  return '?' + usp.toString();
}

function testerFormatBody() {
  const txt = testerEls.body.value;
  if (!txt.trim()) { testerEls.bodyStatus.textContent = 'Empty.'; return; }
  try {
    const obj = JSON.parse(txt);
    testerEls.body.value = JSON.stringify(obj, null, 2);
    testerEls.body.classList.remove('is-invalid');
    testerEls.bodyStatus.textContent = 'OK · ' + JSON.stringify(obj).length + ' bytes';
  } catch (e) {
    testerEls.body.classList.add('is-invalid');
    testerEls.bodyStatus.textContent = '✗ ' + e.message;
  }
}

function testerResetBody() {
  const ep = testerGetSelected();
  testerEls.body.value = ep.body ? JSON.stringify(ep.body, null, 2) : '';
  testerEls.bodyStatus.textContent = ep.body ? 'reset to sample' : '(no body)';
  testerEls.body.classList.remove('is-invalid');
}

function testerRenderKvRow(list, key, value, onChange) {
  const row = document.createElement('div');
  row.className = 'tester-kv-row';
  const k = document.createElement('input');
  k.className = 'k'; k.placeholder = 'name'; k.value = key || '';
  const v = document.createElement('input');
  v.placeholder = 'value'; v.value = value || '';
  const x = document.createElement('button');
  x.type = 'button'; x.textContent = '✕'; x.title = 'Remove';
  x.addEventListener('click', () => { row.remove(); onChange && onChange(); });
  k.addEventListener('input', () => onChange && onChange());
  v.addEventListener('input', () => onChange && onChange());
  row.append(k, v, x);
  list.appendChild(row);
}

function testerReadKvList(listEl) {
  return Array.from(listEl.querySelectorAll('.tester-kv-row')).map((row) => {
    const ins = row.querySelectorAll('input');
    return { key: ins[0].value, value: ins[1].value };
  });
}

function testerCollectPathParams() {
  const out = {};
  for (const { key, value } of testerReadKvList(testerEls.pathList)) out[key] = value;
  return out;
}

function testerCollectQuery() {
  return testerReadKvList(testerEls.queryList);
}

/* ---------- populate dropdown ---------- */

function testerPopulateEndpointSelect() {
  const sel = testerEls.endpoint;
  sel.innerHTML = '';
  const groups = {};
  for (const ep of TESTER_ENDPOINTS) {
    (groups[ep.group] = groups[ep.group] || []).push(ep);
  }
  const order = ['meta', 'problems', 'analyze', 'chat'];
  for (const g of order) {
    if (!groups[g]) continue;
    const og = document.createElement('optgroup');
    og.label = g.toUpperCase();
    for (const ep of groups[g]) {
      const opt = document.createElement('option');
      opt.value = ep.id;
      opt.textContent = ep.method.padEnd(4) + '  ' + ep.title;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  sel.value = tester.selectedId;
}

/* ---------- render form for the selected endpoint ---------- */

function testerRenderForm() {
  const ep = testerGetSelected();
  const preset = testerGetPreset(ep.id);

  testerEls.method.textContent = ep.method;
  testerEls.method.className = 'badge method ' + ep.method;
  testerEls.description.textContent = ep.desc || '';
  testerEls.rateLimit.textContent = ep.rateLimit ? ('· rate: ' + ep.rateLimit) : '';

  if (ep.method === 'POST' && ep.body) {
    testerEls.bodyRow.style.display = '';
    const initial = preset.body !== undefined ? preset.body : ep.body;
    testerEls.body.value = JSON.stringify(initial, null, 2);
    testerEls.bodyStatus.textContent = 'preset loaded';
    testerEls.body.classList.remove('is-invalid');
  } else {
    testerEls.bodyRow.style.display = 'none';
    testerEls.body.value = '';
  }

  testerEls.queryList.innerHTML = '';
  if (ep.query && ep.query.length) {
    testerEls.queryRow.style.display = '';
    const q = (preset.query || ep.query).slice();
    while (q.length && q[q.length - 1].key === '' && q[q.length - 1].value === '') q.pop();
    for (const kv of q) testerRenderKvRow(testerEls.queryList, kv.key, kv.value, () => testerPersistCurrent());
  } else {
    testerEls.queryRow.style.display = 'none';
  }

  testerEls.pathList.innerHTML = '';
  if (ep.pathParams && ep.pathParams.length) {
    testerEls.pathRow.style.display = '';
    for (const pp of ep.pathParams) {
      const v = (preset.pathParams && preset.pathParams[pp.name]) || pp.sample || '';
      testerRenderKvRow(testerEls.pathList, pp.name, v, () => testerPersistCurrent());
    }
  } else {
    testerEls.pathRow.style.display = 'none';
  }

  testerEls.stream.checked = !!ep.stream;
  testerUpdatePathPreview();
}

function testerPersistCurrent() {
  const ep = testerGetSelected();
  const data = {};
  if (ep.method === 'POST' && ep.body) {
    try { data.body = JSON.parse(testerEls.body.value); } catch { /* keep previous */ }
  }
  if (testerEls.pathRow.style.display !== 'none') {
    data.pathParams = testerCollectPathParams();
  }
  if (testerEls.queryRow.style.display !== 'none') {
    data.query = testerCollectQuery();
  }
  testerSetPreset(ep.id, data);
  testerUpdatePathPreview();
}

function testerUpdatePathPreview() {
  const ep = testerGetSelected();
  try {
    const pp = testerCollectPathParams();
    const path = testerResolvePath(ep.path, pp);
    const qs = testerBuildQuery(testerCollectQuery());
    testerEls.pathPreview.textContent = path + qs;
  } catch (e) {
    testerEls.pathPreview.textContent = ep.path + '  ⚠ ' + e.message;
  }
}

/* ---------- send ---------- */

async function testerSendOnce() {
  if (testerBusy) return;
  const ep = testerGetSelected();
  testerBusy = true;
  testerEls.send.disabled = true;
  testerEls.send.textContent = 'Sending…';
  testerEls.response.innerHTML = '<div class="muted">running…</div>';

  let url, body;
  try {
    const path = testerResolvePath(ep.path, testerCollectPathParams());
    url = path + testerBuildQuery(testerCollectQuery());
    if (ep.method === 'POST' && ep.body !== null) {
      let parsed = JSON.parse(testerEls.body.value || '{}');
      parsed = testerResolveBody(parsed);
      body = JSON.stringify(parsed);
    }
  } catch (e) {
    testerBusy = false;
    testerEls.send.disabled = false;
    testerEls.send.textContent = 'Send request';
    testerEls.response.innerHTML =
      '<div class="status fail">✗ Build error: ' + $escape(e.message) + '</div>';
    return;
  }

  const start = performance.now();
  window.__testerSendStart = start;
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  const wantStream = testerEls.stream.checked && ep.stream;

  try {
    const res = await fetch(url, {
      method: ep.method,
      headers,
      body: wantStream ? undefined : body,
    });
    const elapsed = Math.round(performance.now() - start);
    testerPersistCurrent();
    if (wantStream) {
      await testerRenderSSE(res, elapsed, ep, url);
    } else {
      await testerRenderJson(res, elapsed, ep, url);
    }
  } catch (e) {
    const elapsed = Math.round(performance.now() - start);
    testerEls.response.innerHTML =
      '<div class="tester-response-meta"><span class="status fail">NETWORK</span>' +
      '<span>0 bytes</span><span>' + elapsed + ' ms</span></div>' +
      '<div>' + $escape(e.message) + '</div>';
    testerRecordHistory(ep, url, 0, 'NETWORK', elapsed);
  } finally {
    testerBusy = false;
    testerEls.send.disabled = false;
    testerEls.send.textContent = 'Send request';
  }
}

async function testerRenderJson(res, elapsed, ep, url) {
  const text = await res.text();
  const cls = res.ok ? 'ok' : 'fail';
  let pretty = text;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not json */ }
  testerEls.response.innerHTML =
    '<div class="tester-response-meta">' +
      '<span class="status ' + cls + '">' + res.status + '</span>' +
      '<span>' + text.length + ' bytes</span>' +
      '<span>' + elapsed + ' ms</span>' +
      '<span class="muted">' + $escape(ep.method + ' ' + url) + '</span>' +
    '</div>' +
    '<pre style="margin:0">' + $escape(pretty) + '</pre>';
  testerRecordHistory(ep, url, res.status, cls, elapsed);
}

async function testerRenderSSE(res, elapsed, ep, url) {
  const cls = res.ok ? 'ok' : 'fail';
  if (!res.body) {
    testerEls.response.innerHTML =
      '<div class="tester-response-meta"><span class="status ' + cls + '">' +
      res.status + '</span></div><div>(no body)</div>';
    testerRecordHistory(ep, url, res.status, cls, elapsed);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  testerEls.response.innerHTML =
    '<div class="tester-response-meta"><span class="status ' + cls + '">' +
    res.status + '</span><span class="muted" id="sse-bytes">streaming…</span>' +
    '<span id="sse-elapsed">' + elapsed + ' ms</span></div>' +
    '<pre id="sse-pre" style="margin:0"></pre>';
  const pre = document.querySelector('#sse-pre');
  const bytesEl = document.querySelector('#sse-bytes');
  const elapsedEl = document.querySelector('#sse-elapsed');
  let buffer = '';
  let bytes = 0;
  const tStart = window.__testerSendStart || performance.now();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    buffer += dec.decode(value, { stream: true });
    pre.textContent = buffer;
    if (bytesEl) bytesEl.textContent = 'streaming… ' + bytes + ' bytes';
    if (elapsedEl) elapsedEl.textContent = Math.round(performance.now() - tStart) + ' ms';
  }
  if (bytesEl) bytesEl.textContent = bytes + ' bytes · done';
  testerRecordHistory(ep, url, res.status, cls, Math.round(performance.now() - tStart), bytes);
}

/* ---------- history ---------- */

function testerRecordHistory(ep, url, status, cls, elapsed, bytes) {
  tester.history.unshift({
    epId: ep.id, method: ep.method, url, status, cls, elapsed,
    bytes: bytes || 0, when: Date.now(),
  });
  if (tester.history.length > 25) tester.history.length = 25;
  testerRenderHistory();
}

function testerRenderHistory() {
  const el = testerEls.history;
  el.innerHTML = '';
  for (const h of tester.history) {
    const ep = TESTER_ENDPOINTS.find((e) => e.id === h.epId) || { title: h.epId };
    const row = document.createElement('div');
    row.className = 'tester-history-row';
    const sCls = h.cls === 'NETWORK' ? 'fail' : h.cls;
    row.innerHTML =
      '<span class="status ' + sCls + '">' + (h.status || 'NET') + '</span>' +
      '<span>' + $escape(h.method) + '</span>' +
      '<span class="muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        $escape(ep.title) +
      '</span>' +
      '<span class="muted">' + h.elapsed + 'ms</span>' +
      '<span class="when">' + new Date(h.when).toLocaleTimeString() + '</span>' +
      '<button class="retry" title="Re-run">↻</button>';
    row.querySelector('.retry').addEventListener('click', (e) => {
      e.stopPropagation();
      tester.selectedId = h.epId;
      testerEls.endpoint.value = h.epId;
      testerRenderForm();
      testerSendOnce();
    });
    row.addEventListener('click', () => {
      tester.selectedId = h.epId;
      testerEls.endpoint.value = h.epId;
      testerRenderForm();
    });
    el.appendChild(row);
  }
}

function testerClearHistory() {
  tester.history = [];
  testerRenderHistory();
}

/* ---------- run-all ---------- */

async function testerRunAll() {
  if (testerBusy) return;
  testerBusy = true;
  testerEls.runAll.disabled = true;
  testerEls.runAll.textContent = 'Running…';
  const results = [];
  // Iterate in catalog order, skipping endpoints that need a real problem id
  // we don't have yet (chat-attach, chat-send, chat-stream, analyze-id,
  // problems-get). Those still run, just may fail at runtime.
  for (const ep of TESTER_ENDPOINTS) {
    const before = tester.selectedId;
    tester.selectedId = ep.id;
    testerEls.endpoint.value = ep.id;
    testerRenderForm();
    // Skip if it's a streaming endpoint and the user wants JSON (default).
    testerEls.stream.checked = false;
    try {
      const r = await testerSendOnceForRunAll();
      results.push({ ep, ...r });
    } catch (e) {
      results.push({ ep, ok: false, error: e.message });
    }
    tester.selectedId = before;
  }
  testerBusy = false;
  testerEls.runAll.disabled = false;
  testerEls.runAll.textContent = '▶ Run all';
  // Summary
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const html = results.map((r) => {
    const cls = r.ok ? 'ok' : 'fail';
    const code = r.status || 'NET';
    const ms = r.elapsed || 0;
    return '<div class="tester-history-row">' +
      '<span class="status ' + cls + '">' + code + '</span>' +
      '<span>' + $escape(r.ep.method) + '</span>' +
      '<span class="muted" style="flex:1">' + $escape(r.ep.title) + '</span>' +
      '<span class="muted">' + ms + 'ms</span>' +
    '</div>';
  }).join('');
  testerEls.response.innerHTML =
    '<div class="tester-response-meta">' +
      '<span class="status ' + (fail === 0 ? 'ok' : 'fail') + '">' +
        pass + ' ✓ / ' + fail + ' ✗</span>' +
      '<span class="muted">' + results.length + ' endpoints</span>' +
    '</div>' +
    '<div style="margin-top:8px">' + html + '</div>';
}

async function testerSendOnceForRunAll() {
  const ep = testerGetSelected();
  let url, body;
  try {
    const path = testerResolvePath(ep.path, testerCollectPathParams());
    url = path + testerBuildQuery(testerCollectQuery());
    if (ep.method === 'POST' && ep.body !== null) {
      let parsed = JSON.parse(testerEls.body.value || '{}');
      parsed = testerResolveBody(parsed);
      body = JSON.stringify(parsed);
    }
  } catch (e) {
    return { ok: false, status: 'BUILD', elapsed: 0, error: e.message };
  }
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: ep.method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body,
    });
    const elapsed = Math.round(performance.now() - start);
    // We only care about status; drain body so the connection closes.
    try { await res.text(); } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, elapsed };
  } catch (e) {
    return { ok: false, status: 'NET', elapsed: Math.round(performance.now() - start), error: e.message };
  }
}

/* ---------- panel open/close + wiring ---------- */

function testerOpen() {
  tester.open = true;
  testerEls.panel.classList.remove('hidden');
}
function testerClose() {
  tester.open = false;
  testerEls.panel.classList.add('hidden');
}

function testerFillFromTableRow() {
  const sel = document.querySelector('tr[data-id].selected')
    || document.querySelector('tr[data-id]:first-of-type');
  if (!sel) {
    alert('No problem row available — load the table first.');
    return;
  }
  const id = sel.getAttribute('data-id');
  const inputs = testerEls.pathList.querySelectorAll('.tester-kv-row input');
  if (!inputs.length) {
    alert('This endpoint has no path parameter to fill.');
    return;
  }
  inputs[1].value = id; // value input
  inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
}

function testerInit() {
  testerPopulateEndpointSelect();
  testerRenderForm();

  testerEls.endpoint.addEventListener('change', () => {
    tester.selectedId = testerEls.endpoint.value;
    testerRenderForm();
  });

  testerEls.openBtn.addEventListener('click', testerOpen);
  testerEls.closeBtn.addEventListener('click', testerClose);

  testerEls.send.addEventListener('click', testerSendOnce);
  testerEls.runAll.addEventListener('click', testerRunAll);
  testerEls.clearHist.addEventListener('click', testerClearHistory);

  testerEls.addQuery.addEventListener('click', () => {
    testerRenderKvRow(testerEls.queryList, '', '', () => testerPersistCurrent());
  });
  testerEls.formatBody.addEventListener('click', testerFormatBody);
  testerEls.resetBody.addEventListener('click', () => {
    testerResetBody();
    testerPersistCurrent();
  });
  testerEls.fillFromRow.addEventListener('click', testerFillFromTableRow);

  testerEls.body.addEventListener('input', () => testerEls.body.classList.remove('is-invalid'));
  testerEls.body.addEventListener('blur', testerFormatBody);

  // Esc closes panel
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tester.open) testerClose();
  });

  // Expose chatState for sessionId resolution
  // (app.js sets window.chatState if available — see below.)
  testerRenderHistory();
}

// Expose to the page so app.js can hand over the live chat session id.
window.testerState = tester;
window.testerInit = testerInit;

// Auto-init when the DOM is ready (this file is loaded as a module).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', testerInit);
} else {
  testerInit();
}