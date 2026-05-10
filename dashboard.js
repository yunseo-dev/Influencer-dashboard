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
    { label: 'Total Views', value: '—', sub: 'Pending upload', pending: true },
    { label: 'Engagement Rate', value: '—', sub: 'Pending upload', pending: true },
    { label: 'Avg CPV', value: '—', sub: 'Pending upload', pending: true },
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
