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
};

let currentProblems = [];
let availableModels = [];
let busy = false;

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
  try {
    const model = els.modelSelect.value || '';
    const url = '/api/analyze/' + encodeURIComponent(problemId) + (model ? '?model=' + encodeURIComponent(model) : '');
    const result = await api('GET', url);
    els.modalBody.innerHTML = renderAnalysis(result.problem, result.analysis);
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

/* ------------------------------ boot ------------------------------ */
(async function init() {
  await loadHealth();
  await loadModels();
  await loadProblems();
})();

