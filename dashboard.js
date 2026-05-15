// Live version: "today" = actual today.
const TODAY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
let DATA = null;

const fmtKRW = n => '₩' + Math.round(n).toLocaleString('en-US');
const fmtKRWshort = n => {
  if (n >= 1e8) return '₩' + (n / 1e8).toFixed(2) + '억';
  if (n >= 1e4) return '₩' + (n / 1e4).toFixed(0) + '만';
  return '₩' + Math.round(n).toLocaleString();
};
const fmtUSD = n => '$' + Math.round(n).toLocaleString('en-US');
const fmtNum = n => Math.round(n).toLocaleString('en-US');
const fmtPct = n => (n * 100).toFixed(1) + '%';
const parseDate = s => s ? new Date(s.slice(0, 10)) : null;
const daysBetween = (a, b) => Math.round((b - a) / 86400000);

const clinicTag = (clinic, type) => {
  if (type === 'doctor') return 'Doctor';
  if (clinic === 'Buena' || clinic === 'Medbeauty' || clinic === 'Premier') return clinic;
  return '';
};

const PAIR_SECONDARIES = new Set(['David Cho', 'Sonia Lee']);

const STAGES = ['협의', '진행 확정', '예약 완료', '시술 완료', '게시 완료', '비용지급 완료'];
const DOCTOR_STAGES = ['협의', '진행 확정', '게시 완료', '비용지급 완료'];

const STAGE_COLORS = {
  '협의': '#e6e2f8', '진행 확정': '#cdc6f1', '예약 완료': '#aea3e6',
  '시술 완료': '#9286d8', '게시 완료': '#7a6cc7', '비용지급 완료': '#4f4391',
  '취소': '#e4e4e7'
};

let inboundChartObj = null;
let inboundMode = 'all';

async function loadData() {
  // Cache-bust by appending a timestamp so the browser doesn't serve a stale data.json
  const url = 'data.json?t=' + Date.now();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.json();
}

function renderAll() {
  // Each render wrapped so one failure doesn't break the rest
  const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`[${name}]`, e); } };
  safe('KPIs', renderKPIs);
  safe('Inbound chart', renderInboundChart);
  safe('Inbound toggle', initInboundToggle);
  safe('Funnel', renderFunnel);
  safe('Influencer table', renderInfluencerTable);
  safe('Filters', initFilters);
  safe('Calendar', renderCalendar);
  safe('Budget', renderBudget);
  safe('Content performance', renderContentPerformance);
  safe('Payments table', renderPaymentsTable);
  safe('Sidebar nav', initSidebarNav);
  safe('Modal', initModal);
}

function updateLastSync(builtAt) {
  const el = document.getElementById('last-sync');
  if (!el) return;
  if (builtAt) {
    const d = new Date(builtAt);
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    el.textContent = mins < 1 ? 'just now' : `${mins} min ago`;
  } else {
    el.textContent = '—';
  }
}

async function init() {
  try {
    DATA = await loadData();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:60px;font-family:system-ui;max-width:520px;margin:auto;">
      <h2 style="font-weight:600;margin-bottom:12px;">Couldn't load data.json</h2>
      <p style="color:#666;line-height:1.5;">The dashboard reads data from <code>data.json</code>, which GitHub Actions refreshes every 10 minutes from Google Sheets. The file may not have been built yet, or the path is wrong.</p>
      <p style="color:#666;margin-top:12px;font-size:0.85rem;">Error: ${e.message}</p>
    </div>`;
    return;
  }
  renderAll();
  updateLastSync(DATA.meta?.last_built);

  // Refresh every 10 minutes silently in the background
  setInterval(async () => {
    try {
      const fresh = await loadData();
      DATA = fresh;
      renderAll();
      updateLastSync(DATA.meta?.last_built);
    } catch (e) {
      console.warn('Background refresh failed:', e);
    }
  }, 10 * 60 * 1000);

  // Update the "X min ago" text every 30s without re-fetching
  setInterval(() => updateLastSync(DATA.meta?.last_built), 30 * 1000);
}

function renderKPIs() {
  const inf = DATA.influencers.filter(p => !PAIR_SECONDARIES.has(p.name));
  const totalContracted = inf.filter(p => p.stage !== '취소').length;
  const activePipeline = inf.filter(p => p.stage !== '취소' && p.stage !== '비용지급 완료').length;
  const totalBudgetKRW = DATA.budget.influencer.total_krw + DATA.budget.doctor.total_krw;
  const totalSpentKRW = DATA.budget.influencer.spent_krw + DATA.budget.doctor.spent_krw;
  const burnPct = totalSpentKRW / totalBudgetKRW;

  // Paid rate = total paid / total committed spend (across both campaigns)
  const totalPaidKRW = DATA.payments.filter(p => p.is_paid).reduce((s, p) => s + p.amount_krw, 0);
  const paidRate = totalSpentKRW > 0 ? totalPaidKRW / totalSpentKRW : 0;

  const kpis = [
    { label: 'Total Views', value: cp?.combined?.views != null ? fmtNum(cp.combined.views) : '—', sub: cp?.combined?.views != null ? 'Both campaigns' : 'Pending upload', pending: cp?.combined?.views == null },
    { label: 'Engagement Rate', value: cp?.combined?.er != null ? cp.combined.er.toFixed(2) + '%' : '—', sub: cp?.combined?.er != null ? 'Avg across all posts' : 'Pending upload', pending: cp?.combined?.er == null },
    { label: 'Avg CPV', value: cp?.combined?.cpv != null ? '$' + cp.combined.cpv.toFixed(2) : '—', sub: cp?.combined?.cpv != null ? 'Cost per view' : 'Pending upload', pending: cp?.combined?.cpv == null },
   { label: 'Inbound Requests', value: fmtNum(DATA.inbound_total), sub: DATA.inbound_qualified + ' qualified' },
    { label: 'Budget Burn', value: fmtPct(burnPct), sub: fmtKRWshort(totalSpentKRW) + ' of ' + fmtKRWshort(totalBudgetKRW) },
    { label: 'Paid Rate', value: fmtPct(paidRate), sub: fmtKRWshort(totalPaidKRW) + ' paid of committed' },
    { label: 'Active Pipeline', value: fmtNum(activePipeline), sub: fmtNum(totalContracted) + ' total contracted' },
  ];
  document.getElementById('kpi-grid').innerHTML = kpis.map(k => `
    <div class="kpi">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.value}</div>
      ${k.pending ? `<div class="kpi-pending">${k.sub}</div>` : `<div class="kpi-sub">${k.sub}</div>`}
    </div>
  `).join('');
}

function renderInboundChart() {
  const tl = DATA.inbound_timeline || [];
  if (tl.length === 0) return;
  const start = parseDate(tl[0].date);
  const end = parseDate(tl[tl.length - 1].date);
  const lookup = Object.fromEntries(tl.map(d => [d.date, d]));
  const filled = [];
  for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
    const key = dt.toISOString().slice(0, 10);
    const f = lookup[key];
    filled.push({ date: key, total: f ? f.total : 0, qualified: f ? f.qualified : 0 });
  }
  const labels = filled.map(d => new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const totalSum = filled.reduce((s, d) => s + d.total, 0);
  const qualSum = filled.reduce((s, d) => s + d.qualified, 0);
  document.getElementById('inbound-stats').innerHTML =
    `<strong>${totalSum}</strong> total · <strong>${qualSum}</strong> qualified · <strong>${filled.length}</strong> day window`;

  let datasets;
  if (inboundMode === 'qualified') {
    datasets = [{
      label: 'Qualified', data: filled.map(d => d.qualified),
      backgroundColor: 'rgba(79, 67, 145, 0.85)', borderRadius: 2,
    }];
  } else {
    datasets = [
      { label: 'Total', data: filled.map(d => d.total),
        backgroundColor: 'rgba(205, 198, 241, 0.55)',
        borderColor: 'rgba(146, 134, 216, 1)', borderWidth: 1, borderRadius: 2 },
      { label: 'Qualified', data: filled.map(d => d.qualified),
        backgroundColor: 'rgba(79, 67, 145, 0.85)', borderRadius: 2 },
    ];
  }

  if (inboundChartObj) inboundChartObj.destroy();
  inboundChartObj = new Chart(document.getElementById('inboundChart').getContext('2d'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: inboundMode === 'all', position: 'bottom', labels: { font: { family: 'Manrope', size: 11 }, boxWidth: 10, padding: 12 } },
        tooltip: { backgroundColor: '#18181b', titleFont: { family: 'Manrope', size: 12 }, bodyFont: { family: 'Manrope', size: 11 } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#a1a1aa', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
        y: { beginAtZero: true, grid: { color: '#f4f4f5' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#a1a1aa', stepSize: 2 } },
      },
    },
  });
}

function initInboundToggle() {
  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      inboundMode = btn.dataset.mode;
      renderInboundChart();
    });
  });
}

function renderFunnel() {
  const inf = DATA.influencers.filter(p => !PAIR_SECONDARIES.has(p.name));
  const stageIdx = Object.fromEntries(STAGES.map((s, i) => [s, i]));

  // Build counts per campaign
  const ca_inf = inf.filter(p => p.type === 'influencer' && p.stage !== '취소');
  const ca_cancelled = inf.filter(p => p.type === 'influencer' && p.stage === '취소').length;
  const doc_inf = inf.filter(p => p.type === 'doctor' && p.stage !== '취소');
  const doc_cancelled = inf.filter(p => p.type === 'doctor' && p.stage === '취소').length;

  // CA Influencer: full 6 stages
  const caCounts = {};
  STAGES.forEach(s => caCounts[s] = 0);
  ca_inf.forEach(p => {
    const myIdx = stageIdx[p.stage];
    if (myIdx === undefined) return;
    STAGES.forEach((s, i) => { if (i <= myIdx) caCounts[s]++; });
  });

  // Doctor: only 협의 → 진행 확정 → 게시 완료 → 비용지급 완료
  const docCounts = {};
  DOCTOR_STAGES.forEach(s => docCounts[s] = 0);
  doc_inf.forEach(p => {
    const myIdx = stageIdx[p.stage];
    if (myIdx === undefined) return;
    DOCTOR_STAGES.forEach(s => {
      const sIdx = stageIdx[s];
      if (sIdx <= myIdx) docCounts[s]++;
    });
  });

  document.getElementById('funnel-ca').innerHTML = buildFunnelRows(STAGES, caCounts, ca_cancelled);
  document.getElementById('funnel-doc').innerHTML = buildFunnelRows(DOCTOR_STAGES, docCounts, doc_cancelled);

  setTimeout(() => {
    document.querySelectorAll('.funnel-fill').forEach(el => { el.style.width = el.dataset.pct + '%'; });
  }, 100);

  document.getElementById('funnel-ca-summary').textContent =
    `${ca_inf.length} active · ${ca_cancelled} cancelled`;
  document.getElementById('funnel-doc-summary').textContent =
    `${doc_inf.length} active · ${doc_cancelled} cancelled`;

  const allActive = ca_inf.length + doc_inf.length;
  const allCancelled = ca_cancelled + doc_cancelled;
  document.getElementById('pipeline-count').textContent = `${allActive} active · ${allCancelled} cancelled`;
}

function buildFunnelRows(stages, counts, cancelCount) {
  const max = Math.max(...stages.map(s => counts[s] || 0), cancelCount, 1);
  const rows = stages.map(stage => {
    const n = counts[stage] || 0;
    const pct = (n / max) * 100;
    return `<div class="funnel-row">
      <div class="funnel-label">${stage}</div>
      <div class="funnel-bar"><div class="funnel-fill" style="--bar-color: ${STAGE_COLORS[stage]}; width: 0;" data-pct="${pct}"></div></div>
      <div class="funnel-count">${n}</div>
    </div>`;
  }).join('');
  const cancelRow = `<div class="funnel-row cancel">
    <div class="funnel-label">취소</div>
    <div class="funnel-bar"><div class="funnel-fill" style="width: 0;" data-pct="${(cancelCount / max) * 100}"></div></div>
    <div class="funnel-count">${cancelCount}</div>
  </div>`;
  return rows + cancelRow;
}

function renderInfluencerTable(filter = {}) {
  const tbody = document.querySelector('#influencer-table tbody');
  let rows = DATA.influencers;
  if (filter.search) {
    const q = filter.search.toLowerCase();
    rows = rows.filter(r => r.name.toLowerCase().includes(q));
  }
  if (filter.clinic) rows = rows.filter(r => clinicTag(r.clinic, r.type) === filter.clinic);
  if (filter.stage) rows = rows.filter(r => r.stage === filter.stage);

  const stageOrder = { ...Object.fromEntries(STAGES.map((s, i) => [s, i])), '취소': -1 };
  rows = [...rows].sort((a, b) => {
    const sa = stageOrder[a.stage] ?? 100, sb = stageOrder[b.stage] ?? 100;
    if (sa !== sb) return sb - sa;  // highest stage first (비용지급 완료 → 협의 → 취소)
    return b.total_views - a.total_views;
  });

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:32px;">No influencers match these filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const tag = clinicTag(r.clinic, r.type);
    const handles = [
      r.instagram ? `<span style="color:var(--text-muted)">${r.instagram}</span>` : null,
      r.tiktok ? `<span style="color:var(--text-muted)">${r.tiktok}</span>` : null,
    ].filter(Boolean).join(' · ');
    return `<tr>
      <td class="name">${r.name}</td>
      <td><span class="clinic-tag" data-clinic="${tag}">${tag || '—'}</span></td>
      <td><span class="chip" data-stage="${r.stage}">${r.stage}</span></td>
      <td class="num">${fmtNum(r.total_views)}</td>
      <td style="font-size:0.78rem;">${handles || '—'}</td>
      <td style="font-size:0.78rem;color:var(--text-soft);">${r.agency || '—'}</td>
    </tr>`;
  }).join('');
}

function initFilters() {
  const search = document.getElementById('filter-search');
  const clinic = document.getElementById('filter-clinic');
  const stage = document.getElementById('filter-stage');
  const update = () => renderInfluencerTable({ search: search.value, clinic: clinic.value, stage: stage.value });
  search.addEventListener('input', update);
  clinic.addEventListener('change', update);
  stage.addEventListener('change', update);
  document.getElementById('payment-filter').addEventListener('change', renderPaymentsTable);
}

let calCursor = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);

function renderCalendar() {
  const grid = document.getElementById('cal-grid');
  const monthLabel = document.getElementById('cal-month');
  const year = calCursor.getFullYear();
  const month = calCursor.getMonth();
  monthLabel.textContent = calCursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const firstDay = new Date(year, month, 1).getDay();
  const lastDate = new Date(year, month + 1, 0).getDate();

  const eventsByDate = {};
  (DATA.events || []).forEach(e => {
    if (!eventsByDate[e.date]) eventsByDate[e.date] = [];
    eventsByDate[e.date].push(e);
  });

  let html = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-dayhead">${d}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= lastDate; d++) {
    const dt = new Date(year, month, d);
    const key = dt.toISOString().slice(0, 10);
    const isToday = dt.toDateString() === TODAY.toDateString();
    const days = daysBetween(TODAY, dt);
    const upcoming5 = days >= 0 && days <= 5;
    const events = (eventsByDate[key] || []).slice().sort((a, b) => {
      if (a.type !== b.type) return a.type === 'treatment' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const visible = events.slice(0, 4);
    const hidden = events.length - visible.length;
    const eventHtml = visible.map(e => `
      <div class="cal-event ${e.type}" data-clinic="${e.clinic}" title="${e.name} · ${e.type === 'treatment' ? '시술일' : '업로드일'} · ${e.clinic}">${e.name}</div>
    `).join('');
    const more = hidden > 0 ? `<div class="cal-event-more" data-date="${key}">+${hidden} more</div>` : '';

    html += `<div class="cal-cell ${isToday ? 'today' : ''} ${upcoming5 ? 'upcoming-5' : ''}">
      <div class="cal-date">${d}</div>
      <div class="cal-events-list">${eventHtml}${more}</div>
    </div>`;
  }
  grid.innerHTML = html;

  document.querySelectorAll('.cal-event-more').forEach(el => {
    el.addEventListener('click', () => openModal(el.dataset.date, eventsByDate[el.dataset.date] || []));
  });
}

document.addEventListener('click', (e) => {
  if (e.target.id === 'cal-prev') { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); }
  else if (e.target.id === 'cal-next') { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); }
  else if (e.target.id === 'cal-today') { calCursor = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1); renderCalendar(); }
});

function openModal(dateKey, events) {
  document.getElementById('modal-title').textContent = new Date(dateKey).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const sorted = events.slice().sort((a, b) => {
    if (a.type !== b.type) return a.type === 'treatment' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  document.getElementById('modal-content').innerHTML = sorted.map(e => `
    <div class="cal-event ${e.type}" data-clinic="${e.clinic}" style="display:block;font-size:0.88rem;padding:8px 12px;margin-bottom:4px;white-space:normal;">
      ${e.name} <span style="opacity:.7;font-weight:400;">— ${e.type === 'treatment' ? '시술일' : '업로드일'} · ${e.clinic}</span>
    </div>
  `).join('');
  document.getElementById('modal-bg').classList.add('show');
}

function initModal() {
  document.getElementById('modal-close').addEventListener('click', () => document.getElementById('modal-bg').classList.remove('show'));
  document.getElementById('modal-bg').addEventListener('click', (e) => {
    if (e.target.id === 'modal-bg') document.getElementById('modal-bg').classList.remove('show');
  });
}

function renderBudget() {
  const inf = DATA.budget.influencer;
  const doc = DATA.budget.doctor;

  const committedHtml = [
    buildCampaignBlock({
      title: 'California Influencer Campaign',
      color: '#9286d8',
      summary: 'Buena · Medbeauty · Premier',
      total_krw: inf.total_krw, spent_krw: inf.spent_krw,
      total_usd: inf.total_usd, spent_usd: inf.spent_usd,
    }),
    buildCampaignBlock({
      title: 'Doctor Campaign',
      color: '#c9bdcd',
      summary: 'medical professionals',
      total_krw: doc.total_krw, spent_krw: doc.spent_krw,
      total_usd: doc.total_usd, spent_usd: doc.spent_usd,
    }),
  ].join('');
  document.getElementById('committed-blocks').innerHTML = committedHtml;

  const ca_pay = DATA.payments.filter(p => p.campaign === 'CA Influencer');
  const doc_pay = DATA.payments.filter(p => p.campaign === 'Doctor');

  const actualHtml = [
    buildActualBlock({ title: 'California Influencer Campaign', color: '#9286d8',
      payments: ca_pay, committed_spend_krw: inf.spent_krw }),
    buildActualBlock({ title: 'Doctor Campaign', color: '#c9bdcd',
      payments: doc_pay, committed_spend_krw: doc.spent_krw }),
  ].join('');
  document.getElementById('actual-blocks').innerHTML = actualHtml;

  setTimeout(() => {
    document.querySelectorAll('.progress-fill').forEach(el => { el.style.width = el.dataset.pct + '%'; });
  }, 100);

  renderPieChart();
  renderPaymentsChart();
}

function buildCampaignBlock({ title, color, summary, total_krw, spent_krw, total_usd, spent_usd }) {
  const remaining_krw = total_krw - spent_krw;
  const remaining_usd = total_usd - spent_usd;
  const burn = total_krw > 0 ? (spent_krw / total_krw * 100).toFixed(1) : '0.0';
  return `
    <div class="campaign-block" style="--campaign-color:${color}">
      <div class="campaign-block-header">
        <div class="campaign-block-title">${title}</div>
        <div class="campaign-block-summary">${summary}</div>
      </div>
      <div class="budget-grid">
        <div class="budget-card"><div class="budget-card-label">Total Budget</div><div class="budget-krw">${fmtKRW(total_krw)}</div><div class="budget-usd">${fmtUSD(total_usd)}</div></div>
        <div class="budget-card"><div class="budget-card-label">Committed Spend</div><div class="budget-krw">${fmtKRW(spent_krw)}</div><div class="budget-usd">${fmtUSD(spent_usd)}</div></div>
        <div class="budget-card"><div class="budget-card-label">Remaining</div><div class="budget-krw">${fmtKRW(remaining_krw)}</div><div class="budget-usd">${fmtUSD(remaining_usd)}</div></div>
        <div class="budget-card"><div class="budget-card-label">Burn Rate</div><div class="budget-krw">${burn}%</div><div class="budget-usd">of total budget</div><div class="progress-bar"><div class="progress-fill" data-pct="${burn}"></div></div></div>
      </div>
    </div>
  `;
}

function buildActualBlock({ title, color, payments, committed_spend_krw }) {
  const paid_krw = payments.filter(p => p.is_paid).reduce((s, p) => s + p.amount_krw, 0);
  const paid_usd = payments.filter(p => p.is_paid).reduce((s, p) => s + p.amount_usd, 0);
  const pending_krw = payments.filter(p => !p.is_paid).reduce((s, p) => s + p.amount_krw, 0);
  const pending_usd = payments.filter(p => !p.is_paid).reduce((s, p) => s + p.amount_usd, 0);
  const recorded_krw = paid_krw + pending_krw;
  const recorded_usd = paid_usd + pending_usd;
  const pct_paid = committed_spend_krw > 0 ? (paid_krw / committed_spend_krw * 100).toFixed(1) : '0.0';
  const paidCount = payments.filter(p => p.is_paid).length;
  const pendingCount = payments.filter(p => !p.is_paid).length;

  return `
    <div class="campaign-block" style="--campaign-color:${color}">
      <div class="campaign-block-header">
        <div class="campaign-block-title">${title}</div>
        <div class="campaign-block-summary">${payments.length} entries in 지출 sheet</div>
      </div>
      <div class="budget-grid">
        <div class="budget-card"><div class="budget-card-label">Recorded</div><div class="budget-krw">${fmtKRW(recorded_krw)}</div><div class="budget-usd">${fmtUSD(recorded_usd)}</div></div>
        <div class="budget-card"><div class="budget-card-label">Paid</div><div class="budget-krw">${fmtKRW(paid_krw)}</div><div class="budget-usd">${fmtUSD(paid_usd)} · ${paidCount} payments</div></div>
        <div class="budget-card"><div class="budget-card-label">Pending</div><div class="budget-krw">${fmtKRW(pending_krw)}</div><div class="budget-usd">${fmtUSD(pending_usd)} · ${pendingCount} payments</div></div>
        <div class="budget-card"><div class="budget-card-label">% Paid</div><div class="budget-krw">${pct_paid}%</div><div class="budget-usd">paid ÷ committed spend</div><div class="progress-bar"><div class="progress-fill" data-pct="${Math.min(pct_paid, 100)}"></div></div></div>
      </div>
    </div>
  `;
}

function renderPieChart() {
  const breakdown = { Buena: 0, Medbeauty: 0, Premier: 0, Doctor: 0 };
  DATA.influencers.forEach(p => {
    if (p.stage === '취소') return;
    const tag = clinicTag(p.clinic, p.type);
    if (breakdown[tag] !== undefined) breakdown[tag] += p.cost_krw;
  });
  new Chart(document.getElementById('pieChart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: ['Buena (CA Influencer)', 'Medbeauty (CA Influencer)', 'Premier (CA Influencer)', 'Doctor Campaign'],
      datasets: [{
        data: [breakdown.Buena, breakdown.Medbeauty, breakdown.Premier, breakdown.Doctor],
        backgroundColor: ['#c8d4c1', '#b9c7d4', '#d4c4b9', '#c9bdcd'],
        borderColor: '#ffffff', borderWidth: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '55%',
      plugins: {
        legend: { position: 'bottom', labels: { font: { family: 'Manrope', size: 11 }, boxWidth: 10, padding: 8 } },
        tooltip: { backgroundColor: '#18181b', callbacks: { label: (ctx) => `${ctx.label}: ${fmtKRWshort(ctx.parsed)}` } }
      }
    }
  });
}

function renderPaymentsChart() {
  const byMonth = {};
  DATA.payments.forEach(p => {
    const dateStr = p.paid_date || p.upload_date;
    if (!dateStr) return;
    const d = parseDate(dateStr);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth[key]) byMonth[key] = { paid: 0, projected: 0 };
    if (p.is_paid) byMonth[key].paid += p.amount_krw;
    else byMonth[key].projected += p.amount_krw;
  });
  const months = Object.keys(byMonth).sort();
  const labels = months.map(m => {
    const [y, mo] = m.split('-');
    return new Date(y, mo - 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  });
  new Chart(document.getElementById('paymentsChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Paid', data: months.map(m => byMonth[m].paid), backgroundColor: 'rgba(79, 67, 145, 0.85)', borderRadius: 4 },
        { label: 'Upcoming', data: months.map(m => byMonth[m].projected), backgroundColor: 'rgba(205, 198, 241, 0.7)', borderColor: 'rgba(146, 134, 216, 1)', borderWidth: 1, borderRadius: 4 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { family: 'Manrope', size: 11 }, boxWidth: 10, padding: 12 } },
        tooltip: { backgroundColor: '#18181b', callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtKRWshort(ctx.parsed.y)}` } }
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { family: 'Manrope', size: 10 } } },
        y: { stacked: true, beginAtZero: true, grid: { color: '#f4f4f5' }, ticks: { font: { family: 'Manrope', size: 10 }, callback: (v) => fmtKRWshort(v) } }
      }
    }
  });
}

function renderPaymentsTable() {
  const filter = document.getElementById('payment-filter')?.value || 'all';
  const tbody = document.querySelector('#payments-table tbody');
  let rows = DATA.payments.map(p => {
    const deadline = parseDate(p.deadline);
    const upload = parseDate(p.upload_date);
    const days = deadline ? daysBetween(TODAY, deadline) : null;
    return { ...p, deadline_dt: deadline, upload_dt: upload, days_to_deadline: days };
  });
  if (filter === 'upcoming') rows = rows.filter(r => !r.is_paid);
  else if (filter === 'due-soon') rows = rows.filter(r => !r.is_paid && r.days_to_deadline !== null && r.days_to_deadline >= 0 && r.days_to_deadline <= 10);
  else if (filter === 'paid') rows = rows.filter(r => r.is_paid);

  rows.sort((a, b) => {
    if (a.is_paid !== b.is_paid) return a.is_paid ? 1 : -1;
    if (!a.is_paid) return (a.deadline_dt?.getTime() || Infinity) - (b.deadline_dt?.getTime() || Infinity);
    return (b.deadline_dt?.getTime() || 0) - (a.deadline_dt?.getTime() || 0);
  });

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:32px;">No payments match this filter.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const dueSoon = !r.is_paid && r.days_to_deadline !== null && r.days_to_deadline >= 0 && r.days_to_deadline <= 10;
    const overdue = !r.is_paid && r.days_to_deadline !== null && r.days_to_deadline < 0;
    let statusHtml;
    if (r.is_paid) statusHtml = `<span class="paid-tag">✓ Paid</span>`;
    else if (overdue) statusHtml = `<span class="due-tag" style="background:#fde7e7;border-color:#f0a8a8;color:#9a2424;">${Math.abs(r.days_to_deadline)}d overdue</span>`;
    else if (dueSoon) statusHtml = `<span class="due-tag">Due in ${r.days_to_deadline}d</span>`;
    else statusHtml = `<span class="upcoming-tag">${r.days_to_deadline}d</span>`;
    const campaignTag = r.campaign === 'Doctor' ? 'Doctor' : '';
    return `<tr class="${dueSoon ? 'payment-due' : ''}">
      <td class="name">${r.name}</td>
      <td><span class="clinic-tag" data-clinic="${campaignTag}" style="font-size:0.74rem;">${r.type || '—'}</span></td>
      <td style="font-size:0.78rem;">${r.upload_date ? r.upload_date.slice(0, 10) : '—'}</td>
      <td style="font-size:0.78rem;">${r.deadline ? r.deadline.slice(0, 10) : '—'}</td>
      <td class="num">${fmtKRW(r.amount_krw)}</td>
      <td class="num" style="color:var(--text-muted)">${fmtUSD(r.amount_usd)}</td>
      <td>${statusHtml}</td>
    </tr>`;
  }).join('');
}

function initSidebarNav() {
  const links = document.querySelectorAll('.nav-link');
  const sections = ['overview', 'content', 'pipeline', 'calendar', 'budget'];
  links.forEach(l => {
    l.addEventListener('click', () => {
      links.forEach(x => x.classList.remove('active'));
      l.classList.add('active');
    });
  });
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        const id = e.target.id;
        links.forEach(l => l.classList.toggle('active', l.getAttribute('href') === '#' + id));
      }
    });
  }, { rootMargin: '-30% 0px -60% 0px' });
  sections.forEach(s => { const el = document.getElementById(s); if (el) obs.observe(el); });
}

init();

// ─────────────────────────────────────────────────────────────────────
// renderContentPerformance()
//
// ADD THIS FUNCTION to dashboard.js, then:
//   1. Add  safe('Content performance', renderContentPerformance);
//      to the renderAll() function body.
//   2. The existing placeholder HTML in index.html for #content will be
//      replaced automatically when data is present.
// ─────────────────────────────────────────────────────────────────────

function renderContentPerformance() {
  const section = document.getElementById('content');
  if (!section) return;

  const cp = DATA.content_performance;

  // No data yet — leave the existing placeholder in place
  if (!cp || !cp.combined) return;

  const { combined, california: ca, doctor: doc } = cp;

  // ── helpers ──────────────────────────────────────────────────────
  const fmtViews = n => n != null ? Math.round(n).toLocaleString('en-US') : '—';
  const fmtER    = n => n != null ? n.toFixed(2) + '%' : '—';
  const fmtCPV   = n => n != null ? '$' + n.toFixed(2) : '—';

  // Build a post row for the table
  function postRow(p) {
    const platClass = p.platform === 'IG' ? 'plat-ig' : 'plat-tk';
    const newBadge  = p.is_new ? '<span class="cp-new-badge">New</span>' : '';
    const linkCell  = p.link
      ? `<a href="${p.link}" target="_blank" rel="noopener" style="color:#9286d8;text-decoration:none;font-size:14px">↗</a>`
      : '—';
    return `
      <tr class="${p.is_new ? 'cp-new-row' : ''}">
        <td style="font-weight:${p.is_new ? '600' : '400'}">${p.handle}${newBadge}</td>
        <td><span class="cp-plat-badge ${platClass}">${p.platform}</span></td>
        <td style="color:var(--text-muted)">${p.date || '—'}</td>
        <td style="text-align:right;font-weight:600">${fmtViews(p.views)}</td>
        <td style="text-align:right">${fmtViews(p.likes)}</td>
        <td style="text-align:right">${fmtViews(p.comments)}</td>
        <td style="text-align:center">${linkCell}</td>
      </tr>`;
  }

  // Build the full section HTML
  const reportDate = cp.report_date
    ? new Date(cp.report_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

  section.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">Content Performance</h2>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="cp-slack-badge"><i class="ti ti-brand-slack" aria-hidden="true" style="font-size:12px;margin-right:3px"></i>Slack sync</span>
        <div class="section-meta">Updated ${reportDate}</div>
      </div>
    </div>

    <!-- Combined KPIs -->
    <div class="cp-kpi-row">
      <div class="cp-kpi">
        <div class="kpi-label">Total views</div>
        <div class="kpi-value">${fmtViews(combined.views)}</div>
        <div class="kpi-sub">Both campaigns</div>
      </div>
      <div class="cp-kpi">
        <div class="kpi-label">Engagement rate</div>
        <div class="kpi-value">${fmtER(combined.er)}</div>
        <div class="kpi-sub">Avg across all posts</div>
      </div>
      <div class="cp-kpi">
        <div class="kpi-label">Avg CPV</div>
        <div class="kpi-value">${fmtCPV(combined.cpv)}</div>
        <div class="kpi-sub">Cost per view</div>
      </div>
    </div>

    <!-- Per-campaign summary cards -->
    <div class="cp-camp-row">
      ${campCard('california', '캘리포니아 캠페인', '#9286d8', ca)}
      ${campCard('doctor',     '닥터 캠페인',        '#c9bdcd', doc)}
    </div>

    <!-- Tab bar -->
    <div class="cp-tabs" id="cp-tabs">
      <button class="cp-tab active" data-tab="california">
        캘리포니아 <span class="cp-tab-badge" id="cp-badge-ca">${(ca?.posts || []).length}</span>
      </button>
      <button class="cp-tab" data-tab="doctor">
        닥터 <span class="cp-tab-badge" id="cp-badge-doc">${(doc?.posts || []).length}</span>
      </button>
    </div>

    <!-- Filters -->
    <div class="cp-filters" id="cp-filters">
      <input type="text" id="cp-search" class="search-input" placeholder="Search handle…" style="max-width:200px" />
      <select id="cp-plat" class="filter-select">
        <option value="">All platforms</option>
        <option value="IG">Instagram</option>
        <option value="TK">TikTok</option>
      </select>
      <button class="cp-new-only-btn" id="cp-new-only">New posts only</button>
      <span id="cp-count" style="margin-left:auto;font-size:0.78rem;color:var(--text-muted)"></span>
    </div>

    <!-- Table -->
    <div class="table-wrap">
      <table id="cp-table">
        <thead>
          <tr>
            <th class="cp-sortable" data-key="handle">Handle</th>
            <th class="cp-sortable" data-key="platform">Platform</th>
            <th class="cp-sortable" data-key="date">Date</th>
            <th class="cp-sortable num" data-key="views">Views</th>
            <th class="cp-sortable num" data-key="likes">Likes</th>
            <th class="cp-sortable num" data-key="comments">Comments</th>
            <th style="text-align:center;width:48px">Link</th>
          </tr>
        </thead>
        <tbody id="cp-tbody"></tbody>
      </table>
      <div style="font-size:0.74rem;color:var(--text-muted);padding:8px 12px;text-align:right" id="cp-count-row"></div>
    </div>
  `;

  // ── state ──────────────────────────────────────────────────────────
  let cpActiveTab = 'california';
  let cpNewOnly   = false;
  let cpSortKey   = 'date';
  let cpSortDir   = 'desc';

  function campCard(key, label, dotColor, camp) {
    if (!camp) return '';
    const posts = camp.posts || [];
    const newCount = posts.filter(p => p.is_new).length;
    return `
      <div class="cp-camp-card">
        <div class="cp-camp-head">
          <div class="cp-camp-name">
            <span style="width:7px;height:7px;border-radius:50%;background:${dotColor};display:inline-block;flex-shrink:0"></span>
            ${label}
          </div>
          <span style="font-size:0.74rem;color:var(--text-muted)">${posts.length} posts${newCount ? ` · <span style="color:#7a6cc7;font-weight:600">${newCount} new</span>` : ''}</span>
        </div>
        <div class="cp-camp-stats">
          <div><div class="kpi-label">Views</div><div style="font-size:0.95rem;font-weight:600">${fmtViews(camp.views)}</div></div>
          <div><div class="kpi-label">ER</div><div style="font-size:0.95rem;font-weight:600">${fmtER(camp.er)}</div></div>
          <div><div class="kpi-label">Likes</div><div style="font-size:0.95rem;font-weight:600">${fmtViews(camp.likes)}</div></div>
          <div><div class="kpi-label">Avg CPV</div><div style="font-size:0.95rem;font-weight:600">${fmtCPV(camp.cpv)}</div></div>
        </div>
      </div>`;
  }

  function renderTable() {
    const data = cpActiveTab === 'california'
      ? (ca?.posts || [])
      : (doc?.posts || []);

    const search = document.getElementById('cp-search')?.value.toLowerCase() || '';
    const plat   = document.getElementById('cp-plat')?.value || '';

    let filtered = data.filter(p => {
      if (cpNewOnly && !p.is_new) return false;
      if (search && !p.handle.toLowerCase().includes(search)) return false;
      if (plat && p.platform !== plat) return false;
      return true;
    });

    filtered.sort((a, b) => {
      let av = a[cpSortKey], bv = b[cpSortKey];
      if (av === null || av === undefined) av = -1;
      if (bv === null || bv === undefined) bv = -1;
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return cpSortDir === 'asc' ? -1 : 1;
      if (av > bv) return cpSortDir === 'asc' ? 1 : -1;
      return 0;
    });

    // Update sort indicators
    document.querySelectorAll('.cp-sortable').forEach(th => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.key === cpSortKey) {
        th.classList.add(cpSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      }
    });

    const newCount = filtered.filter(p => p.is_new).length;
    const countEl  = document.getElementById('cp-count');
    if (countEl) countEl.textContent = filtered.length + ' posts' + (newCount ? ` · ${newCount} new` : '');

    const rowEl = document.getElementById('cp-count-row');
    if (rowEl) rowEl.textContent = `Showing ${filtered.length} of ${data.length} posts`;

    const tbody = document.getElementById('cp-tbody');
    if (tbody) tbody.innerHTML = filtered.map(postRow).join('');
  }

  // ── wire up interactivity (runs after innerHTML is set) ──────────
  // Tabs
  document.getElementById('cp-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.cp-tab');
    if (!btn) return;
    cpActiveTab = btn.dataset.tab;
    document.querySelectorAll('.cp-tab').forEach(b => b.classList.toggle('active', b === btn));
    renderTable();
  });

  // Search + platform filter
  document.getElementById('cp-search')?.addEventListener('input', renderTable);
  document.getElementById('cp-plat')?.addEventListener('change', renderTable);

  // New-only toggle
  document.getElementById('cp-new-only')?.addEventListener('click', function () {
    cpNewOnly = !cpNewOnly;
    this.classList.toggle('cp-new-only-on', cpNewOnly);
    renderTable();
  });

  // Column sort
  document.querySelectorAll('.cp-sortable').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      if (cpSortKey === th.dataset.key) {
        cpSortDir = cpSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        cpSortKey = th.dataset.key;
        cpSortDir = th.dataset.key === 'date' ? 'desc' : 'desc';
      }
      renderTable();
    });
  });

  renderTable();
}


// ─────────────────────────────────────────────────────────────────────
// CSS to add to styles.css
// Copy the block below into your styles.css file.
// ─────────────────────────────────────────────────────────────────────
/*

.cp-kpi-row { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:16px; }
.cp-kpi { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:14px 16px; }

.cp-camp-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:20px; }
.cp-camp-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:16px; }
.cp-camp-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid var(--border); }
.cp-camp-name { font-size:0.88rem; font-weight:600; display:flex; align-items:center; gap:6px; }
.cp-camp-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }

.cp-slack-badge { font-size:0.7rem; padding:3px 8px; border-radius:100px; background:#eaf3de; color:#27500a; font-weight:600; }

.cp-tabs { display:flex; border-bottom:1px solid var(--border); margin-bottom:14px; }
.cp-tab { font-size:0.88rem; padding:8px 16px; border:none; background:transparent; cursor:pointer; color:var(--text-soft); border-bottom:2px solid transparent; margin-bottom:-1px; font-family:var(--font-main); font-weight:500; transition:color .15s; }
.cp-tab.active { color:var(--accent-700); border-bottom-color:var(--accent-500); }
.cp-tab-badge { display:inline-block; font-size:0.68rem; padding:1px 6px; border-radius:100px; background:var(--silver-100); color:var(--text-muted); margin-left:4px; font-weight:500; }

.cp-filters { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; align-items:center; }
.cp-new-only-btn { font-size:0.78rem; padding:4px 10px; border:1px solid var(--border-strong); border-radius:100px; background:transparent; cursor:pointer; color:var(--text-soft); font-family:var(--font-main); transition:all .15s; }
.cp-new-only-on { background:var(--accent-100); color:var(--accent-700); border-color:var(--accent-300); }

.cp-new-row td { background:rgba(146,134,216,0.07); }
.cp-new-row td:first-child { border-left:3px solid var(--accent-400); }
.cp-new-badge { font-size:0.62rem; padding:1px 5px; border-radius:4px; background:var(--accent-100); color:var(--accent-700); font-weight:600; margin-left:5px; vertical-align:middle; }
.cp-plat-badge { display:inline-flex; align-items:center; font-size:0.7rem; padding:2px 6px; border-radius:4px; font-weight:600; }
.plat-ig { background:#fbeaf0; color:#72243e; }
.plat-tk { background:#e1f5ee; color:#085041; }
.cp-link-icon { color:var(--text-muted); font-size:0.9rem; text-decoration:none; }
.cp-link-icon:hover { color:var(--text); }

@media (max-width:900px) {
  .cp-camp-row { grid-template-columns:1fr; }
  .cp-kpi-row  { grid-template-columns:repeat(2,1fr); }
}

*/
