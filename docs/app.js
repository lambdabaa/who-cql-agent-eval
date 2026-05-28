// WHO CQL Agent Eval — leaderboard renderer
// No build step; vanilla ES modules. Loads docs/data/<date>.json.

const AGENT_META = {
  'anthropic_claude-opus-4-7': { name: 'Opus 4.7', vendor: 'Anthropic' },
  'anthropic_claude-haiku-4-5': { name: 'Haiku 4.5', vendor: 'Anthropic' },
  'openai_gpt-5.5': { name: 'GPT-5.5', vendor: 'OpenAI' },
  'openai_gpt-5.4-nano': { name: 'GPT-5.4 Nano', vendor: 'OpenAI' },
};

const KIND_META = {
  authoring: { label: 'Authoring', short: 'Author' },
  detection: { label: 'Detection', short: 'Detect' },
  prediction: { label: 'Prediction', short: 'Predict' },
  audit: { label: 'Audit', short: 'Audit' },
  composite_detection: { label: 'Composite detection', short: 'Comp.' },
};

const KIND_ORDER = ['authoring', 'detection', 'prediction', 'audit', 'composite_detection'];

const REPO_URLS = {
  'smart-immunizations': 'https://github.com/WorldHealthOrganization/smart-immunizations',
  'smart-anc': 'https://github.com/WorldHealthOrganization/smart-anc',
};

// Friendly labels for the WHO library variant in each task ID.
const LIBRARY_LABELS = [
  [/anc[_-]?dt08/i, 'ANC DT08'],
  [/measles[_-]?low[_-]?tx/i, 'Measles · Low tx'],
  [/measles[_-]?mcv0/i, 'Measles · MCV0'],
  [/measles[_-]?ongoing[_-]?tx/i, 'Measles · Ongoing tx'],
  [/measles[_-]?supplementary/i, 'Measles · Supplementary'],
];

function libraryLabel(taskId) {
  for (const [pattern, label] of LIBRARY_LABELS) {
    if (pattern.test(taskId)) return label;
  }
  return taskId;
}

function agentLabel(agentId) {
  return AGENT_META[agentId] ?? { name: agentId, vendor: '' };
}

// Per-row score on 0..100. Rules described in #legend.
function scoreRow(row) {
  const d = row.detail ?? {};
  if (d.agentSubmitted === false) return 0;
  switch (row.kind) {
    case 'authoring': {
      const t1 = d.t1 === 'pass' ? 1 : 0;
      const t3 = d.t3 ?? {};
      const cases = t3.casesTotal ? t3.casesPassed / t3.casesTotal : 0;
      return Math.round((t1 * 0.5 + cases * 0.5) * 100);
    }
    case 'detection':
    case 'composite_detection': {
      const f1 = d.global?.f1 ?? d.detection?.f1 ?? 0;
      return Math.round(f1 * 100);
    }
    case 'prediction': {
      const total = d.totalCells ?? 0;
      const correct = d.correctCells ?? 0;
      return total > 0 ? Math.round((correct / total) * 100) : 0;
    }
    case 'audit': {
      // No findings on clean WHO content → success.
      // Score scales down with each false positive (cap at 5).
      const n = d.findingsCount ?? 0;
      return Math.max(0, 100 - Math.min(n, 5) * 25);
    }
    default:
      return 0;
  }
}

function scoreBand(score) {
  if (score >= 95) return 'b-95';
  if (score >= 80) return 'b-80';
  if (score >= 60) return 'b-60';
  if (score >= 30) return 'b-30';
  return 'b-0';
}

function mean(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmt(n, digits = 0) {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

// ---------- data shaping ----------

function buildAgentSummaries(data) {
  // For each agent, compute per-kind average and overall.
  const rowsByAgent = new Map();
  for (const r of data.rows) {
    if (!rowsByAgent.has(r.agentId)) rowsByAgent.set(r.agentId, []);
    rowsByAgent.get(r.agentId).push({ ...r, score: scoreRow(r) });
  }

  const summaries = [];
  for (const [agentId, rows] of rowsByAgent) {
    const perKind = {};
    for (const kind of KIND_ORDER) {
      const ofKind = rows.filter((r) => r.kind === kind);
      if (ofKind.length === 0) continue;
      perKind[kind] = {
        avg: mean(ofKind.map((r) => r.score)),
        rows: ofKind,
      };
    }
    const kindAvgs = Object.values(perKind).map((p) => p.avg);
    summaries.push({
      agentId,
      ...agentLabel(agentId),
      rows,
      perKind,
      overall: mean(kindAvgs),
    });
  }
  summaries.sort((a, b) => b.overall - a.overall);
  return summaries;
}

// ---------- rendering ----------

function renderMeta(data) {
  const date = data.frozenAt?.slice(0, 10) ?? '—';
  document.getElementById('meta-date').textContent = date;

  const sourceEl = document.getElementById('meta-source');
  const source = data.sourceRevision;
  if (source) {
    const match = source.match(/^([^@]+)@(.+)$/);
    if (match && REPO_URLS[match[1]]) {
      const a = document.createElement('a');
      a.href = `${REPO_URLS[match[1]]}/tree/${match[2]}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = source;
      sourceEl.replaceChildren(a);
    } else {
      sourceEl.textContent = source;
    }
  } else {
    sourceEl.textContent = '—';
  }

  document.title = `WHO CQL Agent Eval · ${date}`;
  const gen = document.getElementById('footer-generated');
  if (gen) gen.textContent = `Frozen ${date} · ${data.agents?.length ?? 0} agents × ${data.tasks?.length ?? 0} tasks`;
}

function renderRanking(summaries) {
  const grid = document.getElementById('rank-grid');
  grid.innerHTML = '';
  summaries.forEach((s, i) => {
    const rank = i + 1;
    const li = document.createElement('li');
    li.className = `rank-card rank-${rank}`;

    const badge = ['1st', '2nd', '3rd', '4th'][i] ?? `${rank}th`;
    const pct = Math.min(100, Math.max(0, s.overall));

    const kindsHtml = KIND_ORDER.filter((k) => s.perKind[k])
      .map((k) => {
        const v = s.perKind[k].avg;
        return `<div class="kind-pill" title="${KIND_META[k].label}: ${fmt(v, 0)}/100">
          <span class="kp-label">${KIND_META[k].short}</span>${fmt(v, 0)}
        </div>`;
      })
      .join('');

    li.innerHTML = `
      <span class="badge">${badge}</span>
      <div>
        <div class="vendor">${s.vendor}</div>
        <h3 class="model">${s.name}</h3>
      </div>
      <div class="score-line">
        <span class="score">${fmt(s.overall, 1)}</span>
        <span class="score-suffix">/ 100</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width: ${pct}%"></div></div>
      <div class="kinds">${kindsHtml}</div>
    `;
    grid.appendChild(li);
  });
}

function renderKindPanels(summaries) {
  const grid = document.getElementById('kind-grid');
  grid.innerHTML = '';
  for (const kind of KIND_ORDER) {
    // count tasks of this kind
    const taskCount = summaries[0]?.perKind[kind]?.rows.length ?? 0;
    if (!taskCount) continue;

    const panel = document.createElement('div');
    panel.className = 'kind-panel';
    const sorted = [...summaries].sort(
      (a, b) => (b.perKind[kind]?.avg ?? 0) - (a.perKind[kind]?.avg ?? 0),
    );

    const rows = sorted
      .map((s) => {
        const avg = s.perKind[kind]?.avg ?? 0;
        const band = scoreBand(avg);
        const pct = Math.min(100, Math.max(0, avg));
        return `
          <div class="kind-row">
            <div>
              <span class="agent">${s.name}</span>
              <span class="agent-vendor">${s.vendor}</span>
            </div>
            <div class="num">${fmt(avg, 0)}</div>
            <div class="micro-bar"><div class="micro-fill score-band ${band}" style="width: ${pct}%"></div></div>
          </div>
        `;
      })
      .join('');

    panel.innerHTML = `
      <h3>${KIND_META[kind].label}</h3>
      <div class="kind-task-count">${taskCount} task${taskCount === 1 ? '' : 's'}</div>
      ${rows}
    `;
    grid.appendChild(panel);
  }
}

function renderMatrix(data, summaries) {
  // Group tasks by kind for the column headers.
  const tasksByKind = new Map();
  for (const kind of KIND_ORDER) tasksByKind.set(kind, []);
  for (const taskId of data.tasks) {
    const sampleRow = data.rows.find((r) => r.taskId === taskId);
    if (!sampleRow) continue;
    if (!tasksByKind.has(sampleRow.kind)) tasksByKind.set(sampleRow.kind, []);
    tasksByKind.get(sampleRow.kind).push(taskId);
  }
  // `kindStart` flags the first column of each kind group so CSS can draw a divider.
  const orderedTasks = [...tasksByKind.entries()].flatMap(([kind, tasks]) =>
    tasks.map((taskId, i) => ({ taskId, kind, kindStart: i === 0 })),
  );

  const table = document.getElementById('matrix');
  table.innerHTML = '';

  const thead = document.createElement('thead');
  const kindRow = document.createElement('tr');
  kindRow.className = 'kind-row';
  kindRow.innerHTML = `<th class="kind-band agent-cell"></th>` +
    [...tasksByKind.entries()]
      .filter(([, tasks]) => tasks.length > 0)
      .map(
        ([kind, tasks]) =>
          `<th class="kind-band kind-start" colspan="${tasks.length}">${KIND_META[kind]?.label ?? kind}</th>`,
      )
      .join('') +
    `<th class="kind-band kind-start">Overall</th>`;
  thead.appendChild(kindRow);

  const taskRow = document.createElement('tr');
  taskRow.className = 'task-row';
  taskRow.innerHTML = `<th class="agent-cell">Agent</th>` +
    orderedTasks
      .map(
        ({ taskId, kindStart }) =>
          `<th class="${kindStart ? 'kind-start' : ''}" title="${taskId}">${libraryLabel(taskId)}</th>`,
      )
      .join('') +
    `<th class="kind-start">—</th>`;
  thead.appendChild(taskRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const s of summaries) {
    const tr = document.createElement('tr');
    const cells = [`<th class="agent-cell">${s.name}<span class="vendor">${s.vendor}</span></th>`];
    for (const { taskId, kindStart } of orderedTasks) {
      const row = s.rows.find((r) => r.taskId === taskId);
      const startCls = kindStart ? ' kind-start' : '';
      if (!row) {
        cells.push(`<td class="cell empty${startCls}"><span class="cell-score">—</span></td>`);
        continue;
      }
      const band = scoreBand(row.score);
      const headline = (row.headline ?? '').replace(/"/g, '&quot;');
      cells.push(
        `<td class="cell${startCls}" data-agent-id="${escapeHtml(s.agentId)}" data-task-id="${escapeHtml(taskId)}" tabindex="0" role="button" aria-label="Drill into ${escapeHtml(s.name)} on ${escapeHtml(taskId)}" title="${headline}"><span class="cell-score score-band ${band}">${row.score}</span></td>`,
      );
    }
    const overallBand = scoreBand(s.overall);
    cells.push(
      `<td class="cell cell-overall kind-start"><span class="cell-score score-band ${overallBand}">${fmt(s.overall, 0)}</span></td>`,
    );
    tr.innerHTML = cells.join('');
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

// ---------- inspect: raw model output ----------

// The per-task `runs/` directory is gitignored — only the vendored copies
// under `docs/data/raw/` are tracked in the repo. Link to those.
const GITHUB_RAW_BASE = 'https://github.com/lambdabaa/who-cql-agent-eval/blob/main/docs/data/raw';
const OCTOCAT_SVG =
  '<svg class="octocat" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

function githubFileUrl(row, filename) {
  return `${GITHUB_RAW_BASE}/${row.agentId}/${row.taskId}/${encodeURIComponent(filename)}`;
}

function sourceHeading(row, filename, label) {
  const href = githubFileUrl(row, filename);
  return `<h4><a class="source-link" href="${href}" target="_blank" rel="noopener" title="View ${escapeHtml(filename)} on GitHub">${escapeHtml(label)} ${OCTOCAT_SVG}</a></h4>`;
}


const inspectState = {
  selectedAgent: null,
  summaries: null,
  rawIndex: {},
  // Cache of fetched raw files: `${agentId}/${taskId}/${filename}` → text.
  rawCache: new Map(),
};

function renderInspect(summaries, rawIndex) {
  inspectState.summaries = summaries;
  inspectState.rawIndex = rawIndex ?? {};
  inspectState.selectedAgent = summaries[0]?.agentId ?? null;

  const toolbar = document.getElementById('inspect-toolbar');
  toolbar.innerHTML = '';
  for (const s of summaries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.role = 'tab';
    btn.dataset.agent = s.agentId;
    btn.innerHTML = `<span class="vendor">${s.vendor}</span><span>${s.name}</span>`;
    btn.addEventListener('click', () => selectInspectAgent(s.agentId));
    toolbar.appendChild(btn);
  }
  selectInspectAgent(inspectState.selectedAgent);
}

function selectInspectAgent(agentId) {
  inspectState.selectedAgent = agentId;
  for (const btn of document.querySelectorAll('#inspect-toolbar button')) {
    btn.setAttribute('aria-selected', btn.dataset.agent === agentId ? 'true' : 'false');
  }
  renderInspectCards();
}

function renderInspectCards() {
  const container = document.getElementById('inspect-cards');
  container.innerHTML = '';
  const summary = inspectState.summaries.find((s) => s.agentId === inspectState.selectedAgent);
  if (!summary) return;
  // Group rows by kind for visual ordering.
  const byKind = new Map(KIND_ORDER.map((k) => [k, []]));
  for (const row of summary.rows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, []);
    byKind.get(row.kind).push(row);
  }
  for (const [kind, rows] of byKind) {
    for (const row of rows) container.appendChild(buildTaskCard(summary, row));
  }
}

function buildTaskCard(summary, row) {
  const card = document.createElement('details');
  card.className = 'task-card';

  const headline = (row.headline ?? '').trim();
  const band = scoreBand(row.score);

  card.innerHTML = `
    <summary class="task-card-head">
      <span class="kind-tag">${KIND_META[row.kind]?.label ?? row.kind}</span>
      <span class="task-label">
        <span class="task-name">${libraryLabel(row.taskId)}</span>
        <span class="task-headline">${escapeHtml(headline || row.taskId)}</span>
      </span>
      <span class="score-chip score-band ${band}">${row.score}</span>
      <svg class="caret" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </summary>
    <div class="task-card-body"></div>
  `;
  // Lazy-load raw output when first expanded.
  card.addEventListener('toggle', () => {
    if (card.open && !card.dataset.loaded) {
      card.dataset.loaded = '1';
      fillTaskBody(card.querySelector('.task-card-body'), summary, row);
    }
  });
  return card;
}

async function fillTaskBody(body, summary, row) {
  body.innerHTML = `<div class="body-section"><p class="empty-state">Loading…</p></div>`;
  const files = inspectState.rawIndex[summary.agentId]?.[row.taskId] ?? [];
  try {
    const contents = await Promise.all(
      files.map(async (f) => ({ name: f, text: await fetchRaw(summary.agentId, row.taskId, f) })),
    );
    body.innerHTML = '';
    body.appendChild(renderQualitativeOutput(row, contents));
  } catch (err) {
    body.innerHTML = `<div class="body-section"><p class="empty-state">Couldn't load raw output: ${escapeHtml(err.message ?? String(err))}</p></div>`;
  }
}

async function fetchRaw(agentId, taskId, filename) {
  const key = `${agentId}/${taskId}/${filename}`;
  if (inspectState.rawCache.has(key)) return inspectState.rawCache.get(key);
  const res = await fetch(`./data/raw/${key}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const text = await res.text();
  inspectState.rawCache.set(key, text);
  return text;
}

function renderQualitativeOutput(row, contents) {
  const wrap = document.createElement('div');
  if (contents.length === 0) {
    wrap.innerHTML = `<div class="body-section"><p class="empty-state">No output recorded for this task.</p></div>`;
    return wrap;
  }
  // Dispatch by file name; fall back to raw JSON pretty-print.
  for (const { name, text } of contents) {
    const section = document.createElement('div');
    section.className = 'body-section';
    if (name.endsWith('.cql')) {
      section.appendChild(renderCql(row, name, text));
    } else if (name === 'detections.json') {
      section.appendChild(renderDetections(row, name, text));
    } else if (name === 'predictions.json') {
      section.appendChild(renderPredictions(row, name, text));
    } else if (name === 'findings.json') {
      section.appendChild(renderFindings(row, name, text));
    } else {
      section.appendChild(renderJson(row, name, text));
    }
    wrap.appendChild(section);
  }
  return wrap;
}

function renderCql(row, name, text) {
  const frag = document.createDocumentFragment();
  const lines = text.split('\n').length;
  const wrap = document.createElement('div');
  wrap.innerHTML = sourceHeading(row, name, `${name} · ${lines} lines`);
  frag.appendChild(wrap.firstElementChild);
  const pre = document.createElement('pre');
  pre.className = 'code';
  pre.textContent = text;
  frag.appendChild(pre);
  return frag;
}

function renderDetections(row, name, text) {
  const frag = document.createDocumentFragment();
  const headWrap = document.createElement('div');
  headWrap.innerHTML = sourceHeading(row, name, 'Variants the model labelled');
  frag.appendChild(headWrap.firstElementChild);

  let data;
  try { data = JSON.parse(text); } catch {
    return renderJson(row, name, text);
  }
  const entries = Object.entries(data);
  if (entries.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'Model returned an empty detections object.';
    frag.appendChild(p);
    return frag;
  }
  const list = document.createElement('ul');
  list.className = 'detection-list';
  for (const [variant, detail] of entries) {
    const li = document.createElement('li');
    const verdict = detail?.hasBug ? '<span class="bug-yes">flagged buggy</span>' : '<span class="bug-no">marked clean</span>';
    const define = detail?.define ? ` · <code>${escapeHtml(detail.define)}</code>` : '';
    const line = detail?.approximateLine ? ` · line ${detail.approximateLine}` : '';
    const desc = detail?.description ? `<div style="margin-top:6px;color:var(--text-dim);">${escapeHtml(detail.description)}</div>` : '';
    li.innerHTML = `<span class="variant">${escapeHtml(variant)}</span>${verdict}${define}${line}${desc}`;
    list.appendChild(li);
  }
  frag.appendChild(list);
  frag.appendChild(rawJsonDetails(row, name, 'Full detections.json', text));
  return frag;
}

function renderPredictions(row, name, text) {
  const frag = document.createDocumentFragment();
  const headWrap = document.createElement('div');
  headWrap.innerHTML = sourceHeading(row, name, 'Predicted output cells (per patient)');
  frag.appendChild(headWrap.firstElementChild);

  let data;
  try { data = JSON.parse(text); } catch {
    return renderJson(row, name, text);
  }
  const patients = Object.entries(data);
  if (patients.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'Model returned an empty predictions object.';
    frag.appendChild(p);
    return frag;
  }

  const scroll = document.createElement('div');
  scroll.className = 'pred-scroll';
  const table = document.createElement('table');
  table.className = 'pred-table';
  table.innerHTML = `<thead><tr><th>Patient</th><th>Define</th><th>Predicted</th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector('tbody');
  for (const [patient, defines] of patients) {
    for (const [define, value] of Object.entries(defines ?? {})) {
      const tr = document.createElement('tr');
      const valStr = typeof value === 'boolean' ? String(value) : (value === null ? 'null' : typeof value === 'string' ? value : JSON.stringify(value));
      const cls = value === true ? 'true-val' : value === false ? 'false-val' : '';
      tr.innerHTML = `<td>${escapeHtml(patient)}</td><td>${escapeHtml(define)}</td><td class="${cls}" style="white-space:pre-wrap;">${escapeHtml(valStr)}</td>`;
      tbody.appendChild(tr);
    }
  }
  scroll.appendChild(table);
  frag.appendChild(scroll);
  frag.appendChild(rawJsonDetails(row, name, 'Full predictions.json', text));
  return frag;
}

function renderFindings(row, name, text) {
  const frag = document.createDocumentFragment();
  const headWrap = document.createElement('div');
  headWrap.innerHTML = sourceHeading(row, name, 'Findings reported');
  frag.appendChild(headWrap.firstElementChild);

  let data;
  try { data = JSON.parse(text); } catch {
    return renderJson(row, name, text);
  }
  const findings = Array.isArray(data) ? data : Array.isArray(data?.findings) ? data.findings : [];
  if (findings.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'Model reported no findings on this library.';
    frag.appendChild(p);
    frag.appendChild(rawJsonDetails(row, name, 'Full findings.json', text));
    return frag;
  }
  const list = document.createElement('ul');
  list.className = 'finding-list';
  for (const f of findings) {
    const li = document.createElement('li');
    li.innerHTML = `<pre class="code" style="margin:0;border:0;padding:0;background:transparent;max-height:none;">${escapeHtml(JSON.stringify(f, null, 2))}</pre>`;
    list.appendChild(li);
  }
  frag.appendChild(list);
  return frag;
}

function renderJson(row, name, text) {
  const frag = document.createDocumentFragment();
  const headWrap = document.createElement('div');
  headWrap.innerHTML = sourceHeading(row, name, name);
  frag.appendChild(headWrap.firstElementChild);
  let pretty = text;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
  const pre = document.createElement('pre');
  pre.className = 'code';
  pre.textContent = pretty;
  frag.appendChild(pre);
  return frag;
}

function rawJsonDetails(row, filename, label, text) {
  const det = document.createElement('details');
  det.style.marginTop = '12px';
  const sum = document.createElement('summary');
  sum.className = 'raw-toggle';
  sum.innerHTML = `${escapeHtml(label)} <a class="source-link" href="${githubFileUrl(row, filename)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="View ${escapeHtml(filename)} on GitHub">${OCTOCAT_SVG}</a>`;
  let pretty = text;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
  const pre = document.createElement('pre');
  pre.className = 'code';
  pre.style.marginTop = '8px';
  pre.textContent = pretty;
  det.appendChild(sum);
  det.appendChild(pre);
  return det;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- drilldown drawer ----------
//
// Matrix cells carry data-agent-id + data-task-id; clicking one opens a
// right-side drawer with the per-kind breakdown that doesn't fit in a
// single coloured chip. The grade.json detail is already in the row
// payload, so this is a pure rendering layer — no extra fetches.

let drilldownData = null;
let drilldownSummaries = null;

function attachDrilldown(data, summaries) {
  drilldownData = data;
  drilldownSummaries = summaries;
  const matrix = document.getElementById('matrix');
  matrix.addEventListener('click', (e) => {
    const cell = e.target.closest('td.cell');
    if (!cell || cell.classList.contains('empty')) return;
    const agentId = cell.getAttribute('data-agent-id');
    const taskId = cell.getAttribute('data-task-id');
    if (agentId && taskId) openDrilldown(agentId, taskId);
  });
  matrix.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const cell = e.target.closest('td.cell');
    if (!cell || cell.classList.contains('empty')) return;
    e.preventDefault();
    const agentId = cell.getAttribute('data-agent-id');
    const taskId = cell.getAttribute('data-task-id');
    if (agentId && taskId) openDrilldown(agentId, taskId);
  });
  document.getElementById('drilldown-close').addEventListener('click', closeDrilldown);
  document.getElementById('drilldown-overlay').addEventListener('click', closeDrilldown);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrilldown();
  });
}

function openDrilldown(agentId, taskId) {
  if (!drilldownData) return;
  const summary = drilldownSummaries.find((s) => s.agentId === agentId);
  const row = drilldownData.rows.find((r) => r.agentId === agentId && r.taskId === taskId);
  if (!summary || !row) return;

  const title = document.getElementById('drilldown-title');
  const subtitle = document.getElementById('drilldown-subtitle');
  const body = document.getElementById('drilldown-body');
  title.textContent = `${summary.name} · ${libraryLabel(taskId)}`;
  subtitle.textContent = `${KIND_META[row.kind]?.label ?? row.kind} · ${row.headline ?? ''}`;
  body.innerHTML = '';
  body.appendChild(renderDrilldown(row));

  const drawer = document.getElementById('drilldown');
  const overlay = document.getElementById('drilldown-overlay');
  drawer.classList.add('is-open');
  drawer.setAttribute('aria-hidden', 'false');
  overlay.classList.add('is-open');
  drawer.scrollTop = 0;
  body.scrollTop = 0;
}

function closeDrilldown() {
  const drawer = document.getElementById('drilldown');
  const overlay = document.getElementById('drilldown-overlay');
  if (!drawer.classList.contains('is-open')) return;
  drawer.classList.remove('is-open');
  drawer.setAttribute('aria-hidden', 'true');
  overlay.classList.remove('is-open');
}

function renderDrilldown(row) {
  switch (row.kind) {
    case 'authoring':
      return renderDrilldownAuthoring(row);
    case 'detection':
      return renderDrilldownDetection(row);
    case 'composite_detection':
      return renderDrilldownComposite(row);
    case 'prediction':
      return renderDrilldownPrediction(row);
    case 'audit':
      return renderDrilldownAudit(row);
    default:
      return wrapSection('Detail', `<pre>${escapeHtml(JSON.stringify(row.detail, null, 2))}</pre>`);
  }
}

function wrapSection(heading, innerHtml) {
  const div = document.createElement('div');
  div.className = 'dd-section';
  div.innerHTML = `<h3>${escapeHtml(heading)}</h3>${innerHtml}`;
  return div;
}

function combineSections(...nodes) {
  const frag = document.createDocumentFragment();
  for (const n of nodes) if (n) frag.appendChild(n);
  return frag;
}

function recallBarSpan(flagged, total) {
  if (total === 0) return '';
  const pct = Math.round((flagged / total) * 100);
  const cls = pct >= 90 ? '' : pct >= 60 ? 'partial' : 'poor';
  return `<div class="bar"><span class="${cls}" style="width:${pct}%"></span></div>`;
}

function variantBadgeClass(tp, total, fp) {
  if (total === 0) return fp === 0 ? 'good' : 'partial';
  if (tp === total && fp === 0) return 'good';
  if (tp === 0) return 'bad';
  return 'partial';
}

// ---- per-kind drilldown renderers ----

function renderDrilldownAuthoring(row) {
  const d = row.detail;
  const head = document.createElement('div');
  head.className = 'dd-section';
  const t3 = d.t3;
  head.innerHTML = `<h3>Headline</h3>
    <div class="dd-headline">
      <div class="dd-headline-pair"><span>T1 parse</span><span>${escapeHtml(d.t1)}</span></div>
      ${t3 ? `<div class="dd-headline-pair"><span>T3 execute</span><span>${t3.casesPassed}/${t3.casesTotal} cases</span></div>` : ''}
      <div class="dd-headline-pair"><span>Submitted</span><span>${d.agentSubmitted ? 'yes' : 'no'}</span></div>
    </div>`;

  const errors = (d.t1Errors || []).length === 0
    ? wrapSection('T1 errors', '<div class="dd-empty">No translator errors.</div>')
    : wrapSection(
        'T1 errors',
        `<ul class="dd-list">${d.t1Errors
          .slice(0, 6)
          .map((e) => `<li><span class="miss">${escapeHtml(e)}</span></li>`)
          .join('')}</ul>`,
      );

  if (!t3 || !Array.isArray(t3.perCase) || t3.perCase.length === 0) {
    return combineSections(head, errors);
  }

  const rows = t3.perCase
    .map((c) => {
      const failedCmps = (c.comparisons || []).filter((cmp) => !cmp.pass);
      const cls = c.passed ? 'good' : 'bad';
      const note = c.passed
        ? `${(c.comparisons || []).length}/${(c.comparisons || []).length} defines match`
        : `${failedCmps.length} miss${failedCmps.length === 1 ? '' : 'es'}: ${failedCmps.slice(0, 3).map((cmp) => cmp.define).join(', ')}${failedCmps.length > 3 ? '…' : ''}`;
      return `<div class="vid">${escapeHtml(c.patientId)}</div>
              <div class="vstats">${escapeHtml(note)}</div>
              <div class="vbadge ${cls}">${c.passed ? '✓' : '✗'}</div>`;
    })
    .join('');
  const perCaseSection = wrapSection('Per-patient', `<div class="dd-variants">${rows}</div>`);

  return combineSections(head, errors, perCaseSection);
}

function renderDrilldownDetection(row) {
  const d = row.detail;
  if (!d.agentSubmitted) {
    return combineSections(
      headlineNoSubmit('Detection', d.parseError),
    );
  }
  const det = d.detection;
  const head = document.createElement('div');
  head.className = 'dd-section';
  head.innerHTML = `<h3>Headline</h3>
    <div class="dd-headline">
      <div class="dd-headline-pair"><span>F1</span><span>${det.f1.toFixed(2)}</span></div>
      <div class="dd-headline-pair"><span>Precision</span><span>${det.precision.toFixed(2)}</span></div>
      <div class="dd-headline-pair"><span>Recall</span><span>${det.recall.toFixed(2)}</span></div>
      <div class="dd-headline-pair"><span>TP / FP / FN</span><span>${det.truePositive} / ${det.falsePositive} / ${det.falseNegative}</span></div>
      <div class="dd-headline-pair"><span>Localization</span><span>${d.localization?.defineCorrect ?? 0}/${d.localization?.flagged ?? 0}</span></div>
    </div>`;

  const perKindSection = renderPerKindRecallSection(d.perKindRecall);
  const variantsSection = renderPerVariantSection(d.perVariant || [], false);
  return combineSections(head, perKindSection, variantsSection);
}

function renderDrilldownComposite(row) {
  const d = row.detail;
  if (!d.agentSubmitted) {
    return combineSections(headlineNoSubmit('Composite detection', d.parseError));
  }
  const g = d.global;
  const head = document.createElement('div');
  head.className = 'dd-section';
  head.innerHTML = `<h3>Headline</h3>
    <div class="dd-headline">
      <div class="dd-headline-pair"><span>F1</span><span>${g.f1.toFixed(2)}</span></div>
      <div class="dd-headline-pair"><span>Precision</span><span>${g.precision.toFixed(2)}</span></div>
      <div class="dd-headline-pair"><span>Recall</span><span>${g.recall.toFixed(2)}</span></div>
      <div class="dd-headline-pair"><span>TP / FP / FN</span><span>${g.truePositive} / ${g.falsePositive} / ${g.falseNegative}</span></div>
    </div>`;

  const buckets = renderBugCountBucketsSection(d.perVariant || []);
  const perKindSection = renderPerKindRecallSection(d.perKindRecall);
  const variantsSection = renderPerVariantSection(d.perVariant || [], true);
  return combineSections(head, buckets, perKindSection, variantsSection);
}

function renderDrilldownPrediction(row) {
  const d = row.detail;
  if (!d.agentSubmitted) return combineSections(headlineNoSubmit('Prediction', d.parseError));
  const head = document.createElement('div');
  head.className = 'dd-section';
  head.innerHTML = `<h3>Headline</h3>
    <div class="dd-headline">
      <div class="dd-headline-pair"><span>Cells correct</span><span>${d.correctCells} / ${d.totalCells}</span></div>
      <div class="dd-headline-pair"><span>Accuracy</span><span>${d.totalCells === 0 ? '—' : (d.correctCells / d.totalCells).toFixed(2)}</span></div>
    </div>`;

  const patients = d.perPatient || [];
  if (patients.length === 0) return combineSections(head);
  const rows = patients
    .map((p) => {
      const acc = p.total === 0 ? 0 : p.correct / p.total;
      const cls = acc >= 0.9 ? 'good' : acc >= 0.5 ? 'partial' : 'bad';
      const note = (p.misses || []).length === 0
        ? `${p.correct}/${p.total} defines match`
        : `missed: ${p.misses.slice(0, 3).map((m) => m.define).join(', ')}${p.misses.length > 3 ? '…' : ''}`;
      return `<div class="vid">${escapeHtml(p.patientId)}</div>
              <div class="vstats">${escapeHtml(note)}</div>
              <div class="vbadge ${cls}">${p.correct}/${p.total}</div>`;
    })
    .join('');
  return combineSections(head, wrapSection('Per-patient', `<div class="dd-variants">${rows}</div>`));
}

function renderDrilldownAudit(row) {
  const d = row.detail;
  const head = document.createElement('div');
  head.className = 'dd-section';
  head.innerHTML = `<h3>Headline</h3>
    <div class="dd-headline">
      <div class="dd-headline-pair"><span>Findings</span><span>${d.findingsCount}</span></div>
      <div class="dd-headline-pair"><span>Submitted</span><span>${d.agentSubmitted ? 'yes' : 'no'}</span></div>
      ${d.parseError ? `<div class="dd-headline-pair"><span>Note</span><span>${escapeHtml(d.parseError)}</span></div>` : ''}
    </div>`;
  const findings = d.findings || [];
  if (findings.length === 0) {
    return combineSections(
      head,
      wrapSection(
        'Findings',
        '<div class="dd-empty">Agent flagged no inconsistencies. (Audit briefs are derived from the published CQL, so this is the expected default — see baselines/&lt;date&gt;/audit_report.md.)</div>',
      ),
    );
  }
  const rows = findings
    .map((f) => {
      const sev = f.severity ? ` <span class="lbl">[${escapeHtml(f.severity)}]</span>` : '';
      const ln = f.approximateLine != null ? ` <span class="lbl">L${f.approximateLine}</span>` : '';
      const kind = f.mutationKind ? ` <span class="lbl">${escapeHtml(f.mutationKind)}</span>` : '';
      return `<li><strong>${escapeHtml(f.define)}</strong>${ln}${kind}${sev}<br>${escapeHtml(f.description || '')}</li>`;
    })
    .join('');
  return combineSections(head, wrapSection('Findings', `<ul class="dd-list">${rows}</ul>`));
}

// ---- shared bits ----

function headlineNoSubmit(label, err) {
  const div = document.createElement('div');
  div.className = 'dd-section';
  div.innerHTML = `<h3>${escapeHtml(label)}</h3>
    <div class="dd-headline">
      <div class="dd-headline-pair"><span>Submitted</span><span>no</span></div>
      ${err ? `<div class="dd-headline-pair"><span>Reason</span><span>${escapeHtml(err)}</span></div>` : ''}
    </div>`;
  return div;
}

function renderPerKindRecallSection(perKindRecall) {
  if (!perKindRecall) return null;
  const entries = Object.entries(perKindRecall);
  if (entries.length === 0) return null;
  const rows = entries
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `
      <div class="label">${escapeHtml(k)}</div>
      ${recallBarSpan(v.flagged, v.total)}
      <div class="value">${v.flagged}/${v.total}</div>
    `)
    .join('');
  return wrapSection('Recall by mutation kind', `<div class="dd-stat-grid">${rows}</div>`);
}

function renderBugCountBucketsSection(perVariant) {
  const buckets = {};
  for (const v of perVariant) {
    const k = v.truthBugCount;
    if (!buckets[k]) buckets[k] = { tp: 0, fn: 0, fp: 0, total: 0 };
    buckets[k].tp += v.truePositive;
    buckets[k].fn += v.falseNegative;
    buckets[k].fp += v.falsePositive;
    buckets[k].total += 1;
  }
  const orderedKeys = Object.keys(buckets)
    .map((n) => parseInt(n, 10))
    .sort((a, b) => a - b);
  const rows = orderedKeys
    .map((k) => {
      const b = buckets[k];
      const truthBugs = b.tp + b.fn;
      if (truthBugs === 0) {
        // Controls: report false positive count.
        const cls = b.fp === 0 ? '' : 'value';
        return `<div class="label">${k} bugs (controls)</div>
                <div class="bar"><span class="${b.fp === 0 ? '' : 'poor'}" style="width:${b.fp === 0 ? 100 : Math.min(100, b.fp * 20)}%"></span></div>
                <div class="${cls}">${b.fp} FP across ${b.total} variants</div>`;
      }
      return `<div class="label">${k} bug${k === 1 ? '' : 's'} (${b.total} variants)</div>
              ${recallBarSpan(b.tp, truthBugs)}
              <div class="value">${b.tp}/${truthBugs} recall · ${b.fp} FP</div>`;
    })
    .join('');
  return wrapSection('Recall by bugs-per-variant', `<div class="dd-stat-grid">${rows}</div>`);
}

function renderPerVariantSection(perVariant, isComposite) {
  if (!perVariant || perVariant.length === 0) return null;
  // Show only variants with TP+FP+FN > 0 (i.e. mutated variants the agent
  // flagged or missed, or controls the agent flagged). Hide clean controls
  // detected as clean (they add no diagnostic value to the drilldown).
  const interesting = perVariant.filter((v) => {
    if (v.truthBugCount > 0) return true;
    return (v.falsePositive || 0) > 0;
  });
  if (interesting.length === 0) {
    return wrapSection('Per variant', '<div class="dd-empty">Agent matched every mutated variant cleanly with no false positives on controls.</div>');
  }
  const rows = interesting
    .slice(0, 50)
    .map((v) => {
      const truthBugs = v.truthBugCount;
      const cls = variantBadgeClass(v.truePositive, truthBugs, v.falsePositive);
      const badge = truthBugs === 0
        ? `+${v.falsePositive} FP`
        : `${v.truePositive}/${truthBugs}${v.falsePositive ? ` · +${v.falsePositive} FP` : ''}`;
      const parts = [];
      if (isComposite) parts.push(`${truthBugs}-bug`);
      if (v.misses && v.misses.length > 0) {
        const names = v.misses.slice(0, 2).map((m) => m.define).join(', ');
        parts.push(`<span class="miss">missed: ${escapeHtml(names)}${v.misses.length > 2 ? '…' : ''}</span>`);
      }
      if (v.spurious && v.spurious.length > 0) {
        const names = v.spurious.slice(0, 2).map((s) => s.define).join(', ');
        parts.push(`<span class="extra">extra: ${escapeHtml(names)}${v.spurious.length > 2 ? '…' : ''}</span>`);
      }
      // single-bug detection (non-composite) doesn't carry misses/spurious;
      // fall back to define + kind from the per-variant record.
      if (!isComposite && parts.length === 0) {
        const kindHint = v.truthKind || '';
        if (v.truthHasBug && !v.agentHasBug) parts.push(`<span class="miss">missed ${escapeHtml(v.truthDefine || '?')} (${escapeHtml(kindHint)})</span>`);
        else if (!v.truthHasBug && v.agentHasBug) parts.push(`<span class="extra">false flag on clean variant</span>`);
        else if (v.truthHasBug && v.agentHasBug && v.localizationPass === false) {
          parts.push(`<span class="lbl">caught but mis-located</span>`);
        } else if (v.truthHasBug && v.agentHasBug) {
          parts.push(`caught ${escapeHtml(kindHint)}`);
        }
      }
      const stats = parts.join(' · ');
      return `<div class="vid">${escapeHtml(v.variantId)}</div>
              <div class="vstats">${stats}</div>
              <div class="vbadge ${cls}">${badge}</div>`;
    })
    .join('');
  const note = interesting.length > 50 ? `<div class="dd-empty">Showing first 50 of ${interesting.length} interesting variants.</div>` : '';
  return wrapSection('Per variant (interesting only)', `<div class="dd-variants">${rows}</div>${note}`);
}

// ---------- bootstrap ----------

async function loadData() {
  const manifestRes = await fetch('./data/manifest.json', { cache: 'no-cache' });
  if (!manifestRes.ok) throw new Error('failed to load manifest.json');
  const manifest = await manifestRes.json();
  const baseline = manifest.baselines.find((b) => b.date === manifest.latest);
  const file = baseline?.file ?? `${manifest.latest}.json`;
  const dataRes = await fetch(`./data/${file}`, { cache: 'no-cache' });
  if (!dataRes.ok) throw new Error(`failed to load ${file}`);
  const data = await dataRes.json();

  let rawIndex = {};
  if (baseline?.rawIndex) {
    const rawRes = await fetch(`./data/${baseline.rawIndex}`, { cache: 'no-cache' });
    if (rawRes.ok) rawIndex = await rawRes.json();
  }
  return { data, rawIndex };
}

async function main() {
  try {
    const { data, rawIndex } = await loadData();
    const summaries = buildAgentSummaries(data);
    renderMeta(data);
    renderRanking(summaries);
    renderKindPanels(summaries);
    renderMatrix(data, summaries);
    attachDrilldown(data, summaries);
    renderInspect(summaries, rawIndex);
  } catch (err) {
    console.error(err);
    const main = document.querySelector('main.wrap');
    const banner = document.createElement('div');
    banner.style.cssText =
      'padding:16px;border:1px solid var(--bad);border-radius:12px;background:var(--bg-elev);color:var(--bad);margin:24px 0;font-family:var(--mono);font-size:13px;';
    banner.textContent = `Could not load leaderboard data: ${err.message}`;
    main.prepend(banner);
  }
}

main();
