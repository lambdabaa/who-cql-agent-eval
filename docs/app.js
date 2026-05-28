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
        `<td class="cell${startCls}" title="${headline}"><span class="cell-score score-band ${band}">${row.score}</span></td>`,
      );
    }
    const overallBand = scoreBand(s.overall);
    cells.push(
      `<td class="cell kind-start"><span class="cell-score score-band ${overallBand}">${fmt(s.overall, 0)}</span></td>`,
    );
    tr.innerHTML = cells.join('');
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

// ---------- inspect: raw model output ----------

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
      section.appendChild(renderCql(name, text));
    } else if (name === 'detections.json') {
      section.appendChild(renderDetections(text, row));
    } else if (name === 'predictions.json') {
      section.appendChild(renderPredictions(text, row));
    } else if (name === 'findings.json') {
      section.appendChild(renderFindings(text));
    } else {
      section.appendChild(renderJson(name, text));
    }
    wrap.appendChild(section);
  }
  return wrap;
}

function renderCql(name, text) {
  const frag = document.createDocumentFragment();
  const heading = document.createElement('h4');
  heading.textContent = `${name} · ${text.split('\n').length} lines`;
  const pre = document.createElement('pre');
  pre.className = 'code';
  pre.textContent = text;
  frag.appendChild(heading);
  frag.appendChild(pre);
  return frag;
}

function renderDetections(text, row) {
  const frag = document.createDocumentFragment();
  const heading = document.createElement('h4');
  heading.textContent = 'Variants the model labelled';
  frag.appendChild(heading);

  let data;
  try { data = JSON.parse(text); } catch {
    return renderJson('detections.json', text);
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
  frag.appendChild(rawJsonDetails('Full detections.json', text));
  return frag;
}

function renderPredictions(text, row) {
  const frag = document.createDocumentFragment();
  const heading = document.createElement('h4');
  heading.textContent = 'Predicted output cells (per patient)';
  frag.appendChild(heading);

  let data;
  try { data = JSON.parse(text); } catch {
    return renderJson('predictions.json', text);
  }
  const patients = Object.entries(data);
  if (patients.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'Model returned an empty predictions object.';
    frag.appendChild(p);
    return frag;
  }

  // Build a flat table: rows = (patient, define), cols = patient | define | predicted.
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
  frag.appendChild(rawJsonDetails('Full predictions.json', text));
  return frag;
}

function renderFindings(text) {
  const frag = document.createDocumentFragment();
  const heading = document.createElement('h4');
  heading.textContent = 'Findings reported';
  frag.appendChild(heading);

  let data;
  try { data = JSON.parse(text); } catch {
    return renderJson('findings.json', text);
  }
  const findings = Array.isArray(data) ? data : Array.isArray(data?.findings) ? data.findings : [];
  if (findings.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'Model reported no findings on this library.';
    frag.appendChild(p);
    frag.appendChild(rawJsonDetails('Full findings.json', text));
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

function renderJson(name, text) {
  const frag = document.createDocumentFragment();
  const heading = document.createElement('h4');
  heading.textContent = name;
  let pretty = text;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
  const pre = document.createElement('pre');
  pre.className = 'code';
  pre.textContent = pretty;
  frag.appendChild(heading);
  frag.appendChild(pre);
  return frag;
}

function rawJsonDetails(label, text) {
  const det = document.createElement('details');
  det.style.marginTop = '12px';
  const sum = document.createElement('summary');
  sum.className = 'raw-toggle';
  sum.textContent = label;
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
