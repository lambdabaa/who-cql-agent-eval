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
  document.getElementById('meta-source').textContent = data.sourceRevision ?? '—';
  const panel = (data.panelYaml ?? '').split('/').pop() ?? '';
  document.getElementById('meta-panel').textContent = panel.replace(/\.yaml$/, '') || '—';
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
  const orderedTasks = [...tasksByKind.entries()].flatMap(([kind, tasks]) =>
    tasks.map((t) => ({ taskId: t, kind })),
  );

  const table = document.getElementById('matrix');
  table.innerHTML = '';

  // Header rows: kind band + task ID
  const thead = document.createElement('thead');
  const kindRow = document.createElement('tr');
  kindRow.className = 'kind-row';
  kindRow.innerHTML = `<th class="kind-band agent-cell"></th>` +
    [...tasksByKind.entries()]
      .filter(([, tasks]) => tasks.length > 0)
      .map(
        ([kind, tasks]) =>
          `<th class="kind-band" colspan="${tasks.length}">${KIND_META[kind]?.label ?? kind}</th>`,
      )
      .join('') +
    `<th class="kind-band">Overall</th>`;
  thead.appendChild(kindRow);

  const taskRow = document.createElement('tr');
  taskRow.className = 'task-row';
  taskRow.innerHTML = `<th class="agent-cell">Agent</th>` +
    orderedTasks.map(({ taskId }) => `<th title="${taskId}">${shortenTaskId(taskId)}</th>`).join('') +
    `<th>—</th>`;
  thead.appendChild(taskRow);
  table.appendChild(thead);

  // Body: one row per agent
  const tbody = document.createElement('tbody');
  for (const s of summaries) {
    const tr = document.createElement('tr');
    const cells = [`<th class="agent-cell">${s.name}<span class="vendor">${s.vendor}</span></th>`];
    for (const { taskId } of orderedTasks) {
      const row = s.rows.find((r) => r.taskId === taskId);
      if (!row) {
        cells.push(`<td class="cell empty"><span class="cell-score">—</span></td>`);
        continue;
      }
      const band = scoreBand(row.score);
      const headline = (row.headline ?? '').replace(/"/g, '&quot;');
      cells.push(
        `<td class="cell" title="${headline}"><span class="cell-score score-band ${band}">${row.score}</span></td>`,
      );
    }
    const overallBand = scoreBand(s.overall);
    cells.push(
      `<td class="cell"><span class="cell-score score-band ${overallBand}">${fmt(s.overall, 0)}</span></td>`,
    );
    tr.innerHTML = cells.join('');
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

function shortenTaskId(taskId) {
  return taskId
    .replace(/^audit_/, '')
    .replace(/^composite_/, '∑')
    .replace(/_measles_/, '·m·')
    .replace(/^A1$/, 'A1')
    .replace(/_anc_dt08$/, '·anc');
}

// ---------- bootstrap ----------

async function loadData() {
  const manifestRes = await fetch('./data/manifest.json', { cache: 'no-cache' });
  if (!manifestRes.ok) throw new Error('failed to load manifest.json');
  const manifest = await manifestRes.json();
  const file = manifest.baselines.find((b) => b.date === manifest.latest)?.file ?? `${manifest.latest}.json`;
  const dataRes = await fetch(`./data/${file}`, { cache: 'no-cache' });
  if (!dataRes.ok) throw new Error(`failed to load ${file}`);
  return dataRes.json();
}

async function main() {
  try {
    const data = await loadData();
    const summaries = buildAgentSummaries(data);
    renderMeta(data);
    renderRanking(summaries);
    renderKindPanels(summaries);
    renderMatrix(data, summaries);
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
