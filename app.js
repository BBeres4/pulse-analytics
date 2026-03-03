/* PulseAnalytics — frontend-only analytics platform
   Data model: events[] with schema:
   {
     id, timestamp (ms), user_id, event,
     device, region, plan,
     value (number|null), category (string|null),
     properties (object)
   }
*/

const STORAGE_KEY = "pulseanalytics_v1";
const THEME_KEY = "pulseanalytics_theme";
const ALERTS_KEY = "pulseanalytics_alerts_v1";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const fmtMoney = (n) =>
  (n ?? 0).toLocaleString(undefined, { style: "currency", currency: "USD" });

const fmtInt = (n) => (n ?? 0).toLocaleString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function toISODate(d) {
  const x = new Date(d);
  const yyyy = x.getFullYear();
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  const dd = String(x.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(ts) {
  const d = new Date(ts);
  const day = (d.getDay() + 6) % 7; // Monday=0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ts, days) {
  return ts + days * 86400000;
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function downloadText(filename, text, mime="text/plain") {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function parseCSV(csvText) {
  // small CSV parser (supports quoted values)
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;

  function pushField() {
    row.push(field);
    field = "";
  }
  function pushRow() {
    rows.push(row);
    row = [];
  }

  while (i < csvText.length) {
    const c = csvText[i];

    if (inQuotes) {
      if (c === '"') {
        const next = csvText[i + 1];
        if (next === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { pushField(); i++; continue; }
    if (c === "\n") { pushField(); pushRow(); i++; continue; }
    if (c === "\r") { i++; continue; }

    field += c;
    i++;
  }
  // flush last
  pushField();
  pushRow();

  // drop trailing empty row
  if (rows.length && rows[rows.length - 1].every(v => v === "")) rows.pop();
  return rows;
}

function eventsToCSV(events) {
  const header = [
    "timestamp","user_id","event","device","region","plan",
    "value","category","properties_json"
  ];
  const lines = [header.join(",")];

  for (const e of events) {
    const values = [
      new Date(e.timestamp).toISOString(),
      e.user_id,
      e.event,
      e.device,
      e.region,
      e.plan,
      e.value ?? "",
      e.category ?? "",
      JSON.stringify(e.properties ?? {})
    ].map(csvEscape);

    lines.push(values.join(","));
  }
  return lines.join("\n");
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replaceAll('"','""')}"`;
  }
  return s;
}

// ---------------- State ----------------
let state = {
  events: [],
  filters: {
    from: null,
    to: null,
    device: "all",
    region: "all",
    plan: "all",
    search: "",
  },
  paging: { page: 1, pageSize: 18 },
  charts: { trend: null, category: null },
  ui: { view: "overview" }
};

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  const data = safeJsonParse(raw, null);
  if (!data || !Array.isArray(data.events)) return;

  state.events = data.events.map(normalizeEvent).filter(Boolean);
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ events: state.events }));
}

function loadTheme() {
  const t = localStorage.getItem(THEME_KEY) || "dark";
  document.documentElement.setAttribute("data-theme", t);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(THEME_KEY, next);
}

function normalizeEvent(e) {
  try {
    if (!e) return null;
    const ts = typeof e.timestamp === "number"
      ? e.timestamp
      : Date.parse(e.timestamp);

    if (!Number.isFinite(ts)) return null;

    return {
      id: e.id || crypto.randomUUID(),
      timestamp: ts,
      user_id: String(e.user_id ?? "").trim() || "unknown",
      event: String(e.event ?? "").trim() || "unknown",
      device: String(e.device ?? "desktop"),
      region: String(e.region ?? "NA"),
      plan: String(e.plan ?? "free"),
      value: (e.value === null || e.value === undefined || e.value === "") ? null : Number(e.value),
      category: e.category ? String(e.category) : null,
      properties: (typeof e.properties === "object" && e.properties) ? e.properties : safeJsonParse(e.properties, {})
    };
  } catch {
    return null;
  }
}

// ---------------- Filtering ----------------
function withinDateRange(ts, from, to) {
  if (from && ts < from) return false;
  if (to && ts > to) return false;
  return true;
}

function applyFiltersToEvents() {
  const { from, to, device, region, plan, search } = state.filters;

  const s = (search || "").toLowerCase().trim();
  const filtered = state.events.filter(e => {
    if (!withinDateRange(e.timestamp, from, to)) return false;
    if (device !== "all" && e.device !== device) return false;
    if (region !== "all" && e.region !== region) return false;
    if (plan !== "all" && e.plan !== plan) return false;

    if (s) {
      const hay = [
        e.user_id, e.event, e.device, e.region, e.plan,
        String(e.value ?? ""), String(e.category ?? ""),
        JSON.stringify(e.properties ?? {})
      ].join(" ").toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  });

  // sort newest by default
  filtered.sort((a,b) => b.timestamp - a.timestamp);
  return filtered;
}

// ---------------- Metrics ----------------
function uniqueCount(arr) { return new Set(arr).size; }

function computeKPIs(events) {
  // Sessions = unique users w/ session_start
  const sessionsUsers = new Set(events.filter(e=>e.event==="session_start").map(e=>e.user_id));
  const signupUsers = new Set(events.filter(e=>e.event==="signup").map(e=>e.user_id));
  const purchaseEvents = events.filter(e=>e.event==="purchase");
  const purchasers = new Set(purchaseEvents.map(e=>e.user_id));

  const revenue = purchaseEvents.reduce((sum,e)=> sum + (Number.isFinite(e.value) ? e.value : 0), 0);
  const orders = purchaseEvents.length;

  const sessions = sessionsUsers.size || 0;
  const signups = signupUsers.size || 0;

  // Conversion: purchasers / sessions users
  const conversion = sessions ? (purchasers.size / sessions) : 0;

  // Stickiness DAU/MAU based on active users: any event today vs last 30 days
  const now = Date.now();
  const todayStart = startOfDay(now);
  const last30Start = addDays(todayStart, -29);

  const eventsToday = events.filter(e => e.timestamp >= todayStart);
  const events30 = events.filter(e => e.timestamp >= last30Start);

  const dau = uniqueCount(eventsToday.map(e=>e.user_id));
  const mau = uniqueCount(events30.map(e=>e.user_id));
  const stickiness = mau ? (dau / mau) : 0;

  return {
    revenue, orders, sessions, signups,
    conversion,
    dau, mau, stickiness
  };
}

function groupDaily(events, metric) {
  const m = new Map(); // dayTs -> value
  for (const e of events) {
    const day = startOfDay(e.timestamp);
    if (!m.has(day)) m.set(day, { revenue:0, orders:0, sessionsUsers:new Set(), signupsUsers:new Set() });

    const bucket = m.get(day);
    if (e.event === "purchase") {
      bucket.orders += 1;
      bucket.revenue += Number.isFinite(e.value) ? e.value : 0;
    }
    if (e.event === "session_start") bucket.sessionsUsers.add(e.user_id);
    if (e.event === "signup") bucket.signupsUsers.add(e.user_id);
  }

  const days = Array.from(m.keys()).sort((a,b)=>a-b);
  const labels = days.map(d => toISODate(d));
  const values = days.map(d => {
    const b = m.get(d);
    if (metric === "revenue") return b.revenue;
    if (metric === "orders") return b.orders;
    if (metric === "sessions") return b.sessionsUsers.size;
    if (metric === "signups") return b.signupsUsers.size;
    return b.revenue;
  });

  return { labels, values };
}

function topCategories(events, limit=8) {
  const purchases = events.filter(e => e.event === "purchase");
  const m = new Map();
  for (const p of purchases) {
    const cat = p.category || p.properties?.category || "Uncategorized";
    const v = Number.isFinite(p.value) ? p.value : 0;
    m.set(cat, (m.get(cat) || 0) + v);
  }
  const sorted = Array.from(m.entries()).sort((a,b)=>b[1]-a[1]).slice(0, limit);
  return { labels: sorted.map(x=>x[0]), values: sorted.map(x=>x[1]) };
}

// ---------------- Anomalies (simple) ----------------
function detectAnomalies(events) {
  // Uses revenue daily series: compare last day vs previous 7-day mean
  const { labels, values } = groupDaily(events, "revenue");
  if (values.length < 4) return { status: "info", lines: ["Not enough data to detect anomalies. Load demo or import CSV."] };

  const last = values[values.length - 1];
  const prev = values.slice(Math.max(0, values.length - 8), values.length - 1); // up to 7 days
  const mean = prev.reduce((a,b)=>a+b,0) / prev.length;

  if (mean === 0) return { status: "info", lines: ["Baseline is zero — no anomaly detection available yet."] };

  const ratio = last / mean;
  const pct = (ratio - 1) * 100;

  if (ratio >= 1.6) {
    return { status: "good", lines: [`Revenue spike: ${pct.toFixed(0)}% vs trailing baseline.`, `Last day: ${fmtMoney(last)} · Baseline: ${fmtMoney(mean)}`] };
  }
  if (ratio <= 0.6) {
    return { status: "bad", lines: [`Revenue drop: ${Math.abs(pct).toFixed(0)}% vs trailing baseline.`, `Last day: ${fmtMoney(last)} · Baseline: ${fmtMoney(mean)}`] };
  }
  return { status: "warn", lines: [`Revenue stable: ${pct.toFixed(0)}% vs trailing baseline.`, `Last day: ${fmtMoney(last)} · Baseline: ${fmtMoney(mean)}`] };
}

// ---------------- Funnels ----------------
function computeFunnel(events, windowDays=14) {
  const steps = ["session_start","page_view","add_to_cart","purchase"];
  const windowMs = windowDays * 86400000;

  // Build user timeline
  const byUser = new Map();
  for (const e of events) {
    if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
    byUser.get(e.user_id).push(e);
  }
  for (const [u, list] of byUser.entries()) list.sort((a,b)=>a.timestamp-b.timestamp);

  const reached = steps.map(()=>new Set());
  const lastSeen = new Map(); // for dropoff heuristic

  for (const [u, list] of byUser.entries()) {
    // Consider first session_start as starting point
    const startIdx = list.findIndex(x=>x.event==="session_start");
    if (startIdx === -1) continue;

    const startTs = list[startIdx].timestamp;
    const endTs = startTs + windowMs;

    // Track steps in order
    let si = 0;
    for (let i = startIdx; i < list.length; i++) {
      const ev = list[i];
      if (ev.timestamp > endTs) break;
      lastSeen.set(u, ev.event);

      if (ev.event === steps[si]) {
        reached[si].add(u);
        // move forward, but allow multiple same step; find next distinct match
        while (si < steps.length && reached[si].has(u)) si++;
        if (si >= steps.length) break;
      } else {
        // if the event matches a later step without earlier, ignore (strict order)
        continue;
      }
    }
  }

  // dropoff reasons
  const drop = { session_start:0, page_view:0, add_to_cart:0, purchase:0 };
  for (const [u, last] of lastSeen.entries()) {
    if (last === "session_start") drop.session_start++;
    else if (last === "page_view") drop.page_view++;
    else if (last === "add_to_cart") drop.add_to_cart++;
    else if (last === "purchase") drop.purchase++;
  }

  return {
    steps: steps.map((s, idx)=>({ name: s, users: reached[idx].size })),
    drop
  };
}

// ---------------- Cohorts ----------------
function computeCohorts(events, weeksBack=10) {
  // cohort = signup week
  const signups = events.filter(e=>e.event==="signup");
  const activity = events; // any event counts as active

  const now = Date.now();
  const currentWeekStart = startOfWeek(now);
  const minWeekStart = addDays(currentWeekStart, -(weeksBack-1)*7);

  // user -> signup week
  const signupWeek = new Map();
  for (const s of signups) {
    const w = startOfWeek(s.timestamp);
    if (w < minWeekStart || w > currentWeekStart) continue;
    if (!signupWeek.has(s.user_id) || w < signupWeek.get(s.user_id)) signupWeek.set(s.user_id, w);
  }

  // week -> users who signed up in that week
  const cohorts = new Map();
  for (const [u, w] of signupWeek.entries()) {
    if (!cohorts.has(w)) cohorts.set(w, new Set());
    cohorts.get(w).add(u);
  }

  // active users per week
  const activeByWeek = new Map(); // week -> Set(user)
  for (const e of activity) {
    const w = startOfWeek(e.timestamp);
    if (w < minWeekStart || w > currentWeekStart) continue;
    if (!activeByWeek.has(w)) activeByWeek.set(w, new Set());
    activeByWeek.get(w).add(e.user_id);
  }

  const weekStarts = [];
  for (let w = minWeekStart; w <= currentWeekStart; w = addDays(w, 7)) weekStarts.push(w);

  // For each cohort week, compute retention into subsequent weeks
  const rows = [];
  const sortedCohorts = Array.from(cohorts.keys()).sort((a,b)=>b-a); // newest first

  for (const cw of sortedCohorts) {
    const users = cohorts.get(cw);
    const size = users.size;
    const row = { cohortWeek: cw, size, retention: [] };

    for (const w of weekStarts) {
      if (w < cw) continue;
      const activeSet = activeByWeek.get(w) || new Set();
      let retained = 0;
      for (const u of users) if (activeSet.has(u)) retained++;
      row.retention.push({ week: w, retained, pct: size ? retained/size : 0 });
    }
    rows.push(row);
  }

  return { weekStarts, rows };
}

// ---------------- Segments ----------------
function runSegment(filteredEvents, segment) {
  // segment definition filters *users* based on purchase count and attributes
  const byUser = new Map();
  for (const e of filteredEvents) {
    if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
    byUser.get(e.user_id).push(e);
  }

  const matchedUsers = [];
  for (const [u, list] of byUser.entries()) {
    const any = list[0];
    const plan = mostCommon(list.map(x=>x.plan));
    const region = mostCommon(list.map(x=>x.region));
    const device = mostCommon(list.map(x=>x.device));
    const purchases = list.filter(x=>x.event==="purchase");
    const orders = purchases.length;
    const revenue = purchases.reduce((s,x)=>s+(Number.isFinite(x.value)?x.value:0),0);

    if (segment.plan !== "all" && plan !== segment.plan) continue;
    if (segment.region !== "all" && region !== segment.region) continue;
    if (segment.device !== "all" && device !== segment.device) continue;
    if (orders < segment.minPurchases) continue;

    matchedUsers.push({ user_id:u, plan, region, device, orders, revenue });
  }

  matchedUsers.sort((a,b)=>b.revenue-a.revenue);

  // Build KPI view for segment
  const segmentEvents = filteredEvents.filter(e => matchedUsers.some(u=>u.user_id===e.user_id));
  const kpis = computeKPIs(segmentEvents);

  return { matchedUsers, kpis };
}

function mostCommon(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x)||0)+1);
  let best = null, bestN = -1;
  for (const [k,v] of m.entries()) if (v>bestN) { best=k; bestN=v; }
  return best;
}

// ---------------- Alerts ----------------
function loadAlerts() {
  const raw = localStorage.getItem(ALERTS_KEY);
  return safeJsonParse(raw, []);
}
function saveAlerts(alerts) {
  localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts));
}
function evalAlert(alert, kpis) {
  const metric = alert.metric;
  let value = 0;
  if (metric === "revenue") value = kpis.revenue;
  if (metric === "orders") value = kpis.orders;
  if (metric === "conversion") value = kpis.conversion * 100;
  if (metric === "signups") value = kpis.signups;

  const threshold = Number(alert.threshold);
  const ok = alert.condition === "gt" ? value > threshold : value < threshold;
  return { value, ok };
}

// ---------------- Rendering ----------------
function setRangePill() {
  const from = state.filters.from ? toISODate(state.filters.from) : "…";
  const to = state.filters.to ? toISODate(state.filters.to) : "…";
  $("#activeRangePill").textContent = `${from} → ${to}`;
}

function setView(view) {
  state.ui.view = view;
  $("#viewTitle").textContent = viewTitle(view);

  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(v => v.classList.add("hidden"));
  $(`#view-${view}`).classList.remove("hidden");

  render(); // refresh for new view
}

function viewTitle(v) {
  const map = {
    overview:"Overview",
    events:"Events Explorer",
    funnels:"Funnels",
    cohorts:"Cohorts",
    segments:"Segments",
    alerts:"Alerts",
    data:"Data"
  };
  return map[v] || "Overview";
}

function render() {
  setRangePill();

  const filtered = applyFiltersToEvents();
  const kpis = computeKPIs(filtered);
  renderOverview(filtered, kpis);
  renderEvents(filtered);
  renderFunnels(filtered);
  renderCohorts(filtered);
  renderSegments(filtered);
  renderAlerts(filtered, kpis);
  renderDataSummary(filtered);
}

function renderOverview(filtered, kpis) {
  // KPIs
  $("#kpiRevenue").textContent = fmtMoney(kpis.revenue);
  $("#kpiOrders").textContent = fmtInt(kpis.orders);
  $("#kpiConversion").textContent = `${(kpis.conversion * 100).toFixed(1)}%`;
  $("#kpiStickiness").textContent = `${(kpis.stickiness * 100).toFixed(1)}%`;

  $("#kpiRevenueSub").textContent = `${fmtInt(uniqueCount(filtered.map(e=>e.user_id)))} users in filter`;
  $("#kpiOrdersSub").textContent = `${fmtMoney(kpis.orders ? (kpis.revenue / kpis.orders) : 0)} avg order`;
  $("#kpiConversionSub").textContent = `${fmtInt(kpis.sessions)} sessions · ${fmtInt(kpis.signups)} signups`;
  $("#kpiStickinessSub").textContent = `DAU ${fmtInt(kpis.dau)} · MAU ${fmtInt(kpis.mau)}`;

  // Charts
  const metric = $("#trendMetric").value;
  const trend = groupDaily(filtered, metric);
  drawTrendChart(trend.labels, trend.values, metric);

  const cats = topCategories(filtered, 8);
  drawCategoryChart(cats.labels, cats.values);

  // Recent activity table
  const tbody = $("#recentTable tbody");
  tbody.innerHTML = "";
  const recent = filtered.slice(0, 12);
  for (const e of recent) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(e.timestamp).toLocaleString()}</td>
      <td>${escapeHtml(e.user_id)}</td>
      <td><span class="badge">${escapeHtml(e.event)}</span></td>
      <td>${e.value != null ? escapeHtml(fmtMoney(e.value)) : "—"}</td>
      <td class="muted">${escapeHtml(shorten(JSON.stringify(e.properties || {}), 70))}</td>
    `;
    tbody.appendChild(tr);
  }

  // Anomaly box
  const an = detectAnomalies(filtered);
  $("#anomalyBox").innerHTML = `
    <div class="row space">
      <div class="badge ${an.status}">${an.status.toUpperCase()}</div>
      <div class="tiny muted">Auto-detected</div>
    </div>
    <div style="margin-top:10px; display:flex; flex-direction:column; gap:6px;">
      ${an.lines.map(l=>`<div>${escapeHtml(l)}</div>`).join("")}
    </div>
  `;
}

function renderEvents(filtered) {
  const type = $("#eventTypeFilter").value;
  const sort = $("#eventSort").value;

  let list = filtered.slice();
  if (type !== "all") list = list.filter(e => e.event === type);

  // sort
  if (sort === "time_asc") list.sort((a,b)=>a.timestamp-b.timestamp);
  if (sort === "time_desc") list.sort((a,b)=>b.timestamp-a.timestamp);
  if (sort === "value_desc") list.sort((a,b)=>(b.value??-Infinity)-(a.value??-Infinity));
  if (sort === "value_asc") list.sort((a,b)=>(a.value??Infinity)-(b.value??Infinity));

  const { page, pageSize } = state.paging;
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  state.paging.page = clamp(page, 1, totalPages);

  const slice = list.slice((state.paging.page-1)*pageSize, state.paging.page*pageSize);

  const tbody = $("#eventsTable tbody");
  tbody.innerHTML = "";
  for (const e of slice) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(e.timestamp).toLocaleString()}</td>
      <td>${escapeHtml(e.user_id)}</td>
      <td><span class="badge">${escapeHtml(e.event)}</span></td>
      <td>${escapeHtml(e.device)}</td>
      <td>${escapeHtml(e.region)}</td>
      <td>${escapeHtml(e.plan)}</td>
      <td>${e.value != null ? escapeHtml(fmtMoney(e.value)) : "—"}</td>
      <td class="muted">${escapeHtml(shorten(JSON.stringify(e.properties||{}), 90))}</td>
    `;
    tbody.appendChild(tr);
  }

  $("#eventsCount").textContent = `Showing ${fmtInt(slice.length)} of ${fmtInt(list.length)} · page ${state.paging.page}/${totalPages}`;
  $("#prevPage").disabled = state.paging.page <= 1;
  $("#nextPage").disabled = state.paging.page >= totalPages;
}

function renderFunnels(filtered) {
  const windowDays = Number($("#funnelWindow").value);
  const f = computeFunnel(filtered, windowDays);
  const max = Math.max(1, ...f.steps.map(s=>s.users));

  const box = $("#funnelSteps");
  box.innerHTML = "";

  for (let i=0;i<f.steps.length;i++){
    const s = f.steps[i];
    const pct = (s.users / max) * 100;
    const trPct = i===0 ? 100 : (f.steps[i-1].users ? (s.users / f.steps[i-1].users) * 100 : 0);

    const div = document.createElement("div");
    div.className = "fstep";
    div.innerHTML = `
      <div style="flex:1;">
        <div style="display:flex; justify-content:space-between; gap:10px;">
          <div><strong>${escapeHtml(s.name)}</strong></div>
          <div class="muted">${fmtInt(s.users)} users · <strong>${trPct.toFixed(1)}%</strong> pass</div>
        </div>
        <div class="fbar"><div style="width:${pct.toFixed(1)}%"></div></div>
      </div>
    `;
    box.appendChild(div);
  }

  // dropoff heuristic
  const totalSeen = Object.values(f.drop).reduce((a,b)=>a+b,0) || 1;
  const dropBox = $("#dropoffBox");
  dropBox.innerHTML = `
    <div class="alert-item">
      <div class="title">Where users stop</div>
      <div class="meta">Based on last observed event within window</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
        ${Object.entries(f.drop).map(([k,v])=>{
          const pct = (v/totalSeen)*100;
          const badge = k==="purchase" ? "good" : (k==="add_to_cart" ? "warn" : "bad");
          return `<div class="row space">
            <div><span class="badge ${badge}">${escapeHtml(k)}</span></div>
            <div class="muted">${fmtInt(v)} users · ${pct.toFixed(1)}%</div>
          </div>`;
        }).join("")}
      </div>
    </div>
  `;
}

function renderCohorts(filtered) {
  const weeksBack = Number($("#cohortWeeks").value);
  const { weekStarts, rows } = computeCohorts(filtered, weeksBack);

  const thead = $("#cohortTable thead");
  const tbody = $("#cohortTable tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";

  // header: cohort + size + week offsets
  const htr = document.createElement("tr");
  htr.innerHTML = `<th>Cohort (signup week)</th><th>Size</th>` + weekStarts.map((w,i)=>`<th>W+${i}</th>`).join("");
  thead.appendChild(htr);

  for (const r of rows) {
    const tr = document.createElement("tr");
    const cwLabel = `${toISODate(r.cohortWeek)}`;
    const cells = [];
    for (let i=0;i<weekStarts.length;i++){
      const w = weekStarts[i];
      if (w < r.cohortWeek) { cells.push(`<td class="muted">—</td>`); continue; }
      const idx = r.retention.findIndex(x=>x.week===w);
      const pct = idx >= 0 ? r.retention[idx].pct : 0;
      const cls = pct >= 0.35 ? "hot" : pct >= 0.18 ? "mid" : "low";
      cells.push(`<td><span class="cohort-cell ${cls}">${(pct*100).toFixed(0)}%</span></td>`);
    }
    tr.innerHTML = `<td><strong>${cwLabel}</strong></td><td>${fmtInt(r.size)}</td>${cells.join("")}`;
    tbody.appendChild(tr);
  }

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${2 + weekStarts.length}" class="muted">No signup cohorts found in this range. Load demo or import signup events.</td></tr>`;
  }
}

function renderSegments(filtered) {
  // Only updates when user clicks Run (we keep results in the DOM)
  // This function ensures empty state is sane if nothing run yet.
  if (!$("#segUsers").textContent || $("#segUsers").textContent === "—") {
    // leave default
  }
}

function renderAlerts(filtered, kpis) {
  const alerts = loadAlerts();
  const box = $("#alertList");
  box.innerHTML = "";

  if (!alerts.length) {
    box.innerHTML = `<div class="alert-item"><div class="title">No alerts yet</div><div class="meta">Create an alert rule on the left.</div></div>`;
    return;
  }

  for (const a of alerts) {
    const res = evalAlert(a, kpis);
    const badge = res.ok ? "good" : "bad";
    const metricLabel = a.metric === "conversion" ? "Conversion" : a.metric[0].toUpperCase() + a.metric.slice(1);

    const div = document.createElement("div");
    div.className = "alert-item";
    div.innerHTML = `
      <div class="row space">
        <div class="title">${escapeHtml(a.name)}</div>
        <div class="badge ${badge}">${res.ok ? "TRIGGERED" : "OK"}</div>
      </div>
      <div class="meta">
        ${metricLabel} ${a.condition === "gt" ? ">" : "<"} ${escapeHtml(String(a.threshold))}
        · current = <strong>${escapeHtml(a.metric==="revenue" ? fmtMoney(res.value) : a.metric==="conversion" ? res.value.toFixed(2)+"%" : fmtInt(res.value))}</strong>
      </div>
    `;
    box.appendChild(div);
  }
}

function renderDataSummary(filtered) {
  const ev = state.events;
  $("#sumEvents").textContent = fmtInt(ev.length);
  $("#sumUsers").textContent = fmtInt(uniqueCount(ev.map(e=>e.user_id)));
  if (ev.length) {
    const sorted = ev.slice().sort((a,b)=>a.timestamp-b.timestamp);
    $("#sumFirst").textContent = new Date(sorted[0].timestamp).toLocaleDateString();
    $("#sumLast").textContent = new Date(sorted[sorted.length-1].timestamp).toLocaleDateString();
  } else {
    $("#sumFirst").textContent = "—";
    $("#sumLast").textContent = "—";
  }

  // mix table
  const mix = new Map();
  for (const e of ev) mix.set(e.event, (mix.get(e.event)||0)+1);
  const total = ev.length || 1;
  const rows = Array.from(mix.entries()).sort((a,b)=>b[1]-a[1]);

  const tbody = $("#mixTable tbody");
  tbody.innerHTML = "";
  for (const [k,v] of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(k)}</td><td>${fmtInt(v)}</td><td>${((v/total)*100).toFixed(1)}%</td>`;
    tbody.appendChild(tr);
  }
}

// ---------------- Charts ----------------
function drawTrendChart(labels, values, metric) {
  const ctx = $("#trendChart");
  if (state.charts.trend) state.charts.trend.destroy();

  state.charts.trend = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: metric,
        data: values
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { mode: "index", intersect: false }
      },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false } },
        y: { ticks: {
          callback: (v) => metric === "revenue" ? `$${v}` : v
        } }
      }
    }
  });
}

function drawCategoryChart(labels, values) {
  const ctx = $("#categoryChart");
  if (state.charts.category) state.charts.category.destroy();

  state.charts.category = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data: values }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "bottom" }
      }
    }
  });
}

// ---------------- Demo data ----------------
function seedDemo() {
  const now = Date.now();
  const start = addDays(startOfDay(now), -60);

  const devices = ["desktop","mobile","tablet"];
  const regions = ["NA","EU","APAC","LATAM"];
  const plans = ["free","basic","pro","enterprise"];
  const categories = ["Electronics","Fashion","Home","Sports","Books","Beauty","Food"];

  const users = Array.from({ length: 220 }, (_,i)=>`u_${String(i+1).padStart(3,"0")}`);
  const events = [];

  // each user has a signup chance and activity burst
  for (const u of users) {
    const userRegion = regions[randInt(0, regions.length-1)];
    const userDevice = devices[randInt(0, devices.length-1)];
    const userPlan = weightedPick(plans, [0.50, 0.25, 0.18, 0.07]);

    const signupTs = addDays(start, randInt(0, 42)) + randInt(0, 86399)*1000;
    const didSignup = Math.random() < 0.85;

    // sessions over time
    const sessionCount = randInt(3, 22);
    for (let i=0;i<sessionCount;i++){
      const ts = addDays(signupTs, randInt(0, 35)) + randInt(0, 86399)*1000;
      events.push(mkEvent(ts, u, "session_start", userDevice, userRegion, userPlan, null, null, { utm: weightedPick(["none","tiktok","google","referral"], [0.4,0.25,0.25,0.10]) }));
      if (Math.random() < 0.78) {
        events.push(mkEvent(ts+randInt(15,240)*1000, u, "page_view", userDevice, userRegion, userPlan, null, null, { page: weightedPick(["/","/pricing","/product","/checkout"], [0.4,0.22,0.28,0.10]) }));
      }
      if (Math.random() < 0.34) {
        events.push(mkEvent(ts+randInt(60,420)*1000, u, "add_to_cart", userDevice, userRegion, userPlan, null, weightedPick(categories, [0.16,0.15,0.14,0.14,0.14,0.13,0.14]), { sku: `SKU-${randInt(100,999)}` }));
      }
      if (Math.random() < 0.18) {
        const val = Math.round((randFloat(18, 240) * (userPlan==="enterprise" ? 1.2 : userPlan==="pro" ? 1.08 : 1)) * 100) / 100;
        const cat = weightedPick(categories, [0.18,0.15,0.13,0.14,0.14,0.13,0.13]);
        events.push(mkEvent(ts+randInt(120,1200)*1000, u, "purchase", userDevice, userRegion, userPlan, val, cat, { order_id: `ord_${randInt(10000,99999)}`, category: cat }));
      }
    }

    if (didSignup) {
      events.push(mkEvent(signupTs, u, "signup", userDevice, userRegion, userPlan, null, null, { source: weightedPick(["email","organic","ad"], [0.35,0.35,0.30]) }));
    }
  }

  // add some “spike day” behavior
  const spikeDay = addDays(startOfDay(now), -2);
  for (let i=0;i<36;i++){
    const u = users[randInt(0, users.length-1)];
    const ts = spikeDay + randInt(0, 86399)*1000;
    events.push(mkEvent(ts, u, "purchase", weightedPick(["mobile","desktop"], [0.6,0.4]), "NA", weightedPick(plans,[0.45,0.25,0.22,0.08]), randFloat(40, 260), "Electronics", { promo:"FLASH" }));
  }

  // normalize and save
  state.events = events.map(normalizeEvent).filter(Boolean).sort((a,b)=>a.timestamp-b.timestamp);
  saveState();

  // set default date range = last 30 days
  const from = addDays(startOfDay(now), -30);
  const to = now;
  state.filters.from = from;
  state.filters.to = to;

  syncFilterInputs();
  render();
}

function mkEvent(ts, user, ev, device, region, plan, value=null, category=null, props={}) {
  return {
    id: crypto.randomUUID(),
    timestamp: ts,
    user_id: user,
    event: ev,
    device, region, plan,
    value,
    category,
    properties: props
  };
}

function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function randFloat(a,b){ return Math.round((a + Math.random()*(b-a))*100)/100; }
function weightedPick(items, weights) {
  const total = weights.reduce((s,x)=>s+x,0);
  let r = Math.random()*total;
  for (let i=0;i<items.length;i++){
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length-1];
}

// ---------------- UI wiring ----------------
function syncFilterInputs() {
  $("#fromDate").value = state.filters.from ? toISODate(state.filters.from) : "";
  $("#toDate").value = state.filters.to ? toISODate(state.filters.to) : "";
  $("#deviceFilter").value = state.filters.device;
  $("#regionFilter").value = state.filters.region;
  $("#planFilter").value = state.filters.plan;
  $("#search").value = state.filters.search || "";
  $("#trendMetric").value = $("#trendMetric").value || "revenue";
}

function readFilterInputs() {
  const from = $("#fromDate").value ? Date.parse($("#fromDate").value + "T00:00:00") : null;
  const to = $("#toDate").value ? Date.parse($("#toDate").value + "T23:59:59") : null;

  state.filters.from = Number.isFinite(from) ? from : null;
  state.filters.to = Number.isFinite(to) ? to : null;
  state.filters.device = $("#deviceFilter").value;
  state.filters.region = $("#regionFilter").value;
  state.filters.plan = $("#planFilter").value;
  state.filters.search = ($("#search").value || "").trim();
}

function hookUI() {
  // nav
  $$(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  // filters
  $("#applyFilters").addEventListener("click", () => {
    readFilterInputs();
    state.paging.page = 1;
    render();
  });
  $("#resetFilters").addEventListener("click", () => {
    state.filters.device = "all";
    state.filters.region = "all";
    state.filters.plan = "all";
    state.filters.search = "";
    // keep date range, but if empty set to last 30 days if data exists
    if (!state.filters.from || !state.filters.to) {
      const now = Date.now();
      state.filters.from = addDays(startOfDay(now), -30);
      state.filters.to = now;
    }
    syncFilterInputs();
    state.paging.page = 1;
    render();
  });

  // search updates live (debounced)
  let t = null;
  $("#search").addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.filters.search = ($("#search").value || "").trim();
      state.paging.page = 1;
      render();
    }, 150);
  });

  // paging
  $("#prevPage").addEventListener("click", () => { state.paging.page--; render(); });
  $("#nextPage").addEventListener("click", () => { state.paging.page++; render(); });

  // theme
  $("#toggleTheme").addEventListener("click", toggleTheme);

  // demo
  $("#loadDemo").addEventListener("click", seedDemo);

  // trend metric
  $("#trendMetric").addEventListener("change", render);

  // funnel window, cohort weeks
  $("#funnelWindow").addEventListener("change", render);
  $("#cohortWeeks").addEventListener("change", render);

  // event explorer filters
  $("#eventTypeFilter").addEventListener("change", () => { state.paging.page=1; render(); });
  $("#eventSort").addEventListener("change", () => { state.paging.page=1; render(); });

  // modal open/close
  $("#openEventModal").addEventListener("click", openEventModal);
  $("#closeEventModal").addEventListener("click", closeEventModal);
  $("#cancelEvent").addEventListener("click", closeEventModal);
  $("#eventModal").addEventListener("click", (e) => {
    if (e.target.id === "eventModal") closeEventModal();
  });

  $("#saveEvent").addEventListener("click", saveEventFromModal);

  // segments
  $("#clearSegment").addEventListener("click", () => {
    $("#segmentName").value = "";
    $("#segPlan").value = "all";
    $("#segRegion").value = "all";
    $("#segDevice").value = "all";
    $("#segMinPurchases").value = "1";
    clearSegmentResults();
  });

  $("#runSegment").addEventListener("click", () => {
    const seg = {
      name: ($("#segmentName").value || "Segment").trim(),
      plan: $("#segPlan").value,
      region: $("#segRegion").value,
      device: $("#segDevice").value,
      minPurchases: Number($("#segMinPurchases").value || 0)
    };
    const filtered = applyFiltersToEvents();
    const res = runSegment(filtered, seg);
    renderSegmentResults(res);
  });

  // alerts
  $("#clearAlert").addEventListener("click", () => {
    $("#alertName").value = "";
    $("#alertMetric").value = "revenue";
    $("#alertCondition").value = "gt";
    $("#alertThreshold").value = "";
  });

  $("#saveAlert").addEventListener("click", () => {
    const name = ($("#alertName").value || "").trim();
    const metric = $("#alertMetric").value;
    const condition = $("#alertCondition").value;
    const threshold = Number($("#alertThreshold").value);

    if (!name || !Number.isFinite(threshold)) {
      toast("Please enter an alert name and a valid threshold.");
      return;
    }

    const alerts = loadAlerts();
    alerts.push({ id: crypto.randomUUID(), name, metric, condition, threshold });
    saveAlerts(alerts);
    toast("Alert saved.");
    render();
  });

  // data: import/export
  $("#downloadSchema").addEventListener("click", () => {
    const sample = [
      "timestamp,user_id,event,device,region,plan,value,category,properties_json",
      `${new Date().toISOString()},u_001,session_start,mobile,NA,free,,,"{"utm":"google"}"`,
      `${new Date().toISOString()},u_001,signup,mobile,NA,free,,,"{"source":"organic"}"`,
      `${new Date().toISOString()},u_001,purchase,mobile,NA,free,49.99,Books,"{"order_id":"ord_12345"}"`
    ].join("\n");
    downloadText("pulseanalytics_sample.csv", sample, "text/csv");
  });

  $("#importCsvBtn").addEventListener("click", async () => {
    const file = $("#csvFile").files?.[0];
    if (!file) { toast("Choose a CSV file first."); return; }
    const text = await file.text();
    const rows = parseCSV(text);
    if (rows.length < 2) { toast("CSV has no rows."); return; }

    const header = rows[0].map(h => h.trim());
    const required = ["timestamp","user_id","event","device","region","plan","value","category","properties_json"];
    for (const r of required) {
      if (!header.includes(r)) { toast(`Missing column: ${r}`); return; }
    }

    const idx = Object.fromEntries(required.map(k => [k, header.indexOf(k)]));
    const imported = [];

    for (let i=1;i<rows.length;i++){
      const row = rows[i];
      const obj = {
        timestamp: row[idx.timestamp],
        user_id: row[idx.user_id],
        event: row[idx.event],
        device: row[idx.device],
        region: row[idx.region],
        plan: row[idx.plan],
        value: row[idx.value],
        category: row[idx.category],
        properties: safeJsonParse(row[idx.properties_json], {})
      };
      const n = normalizeEvent(obj);
      if (n) imported.push(n);
    }

    state.events = state.events.concat(imported).sort((a,b)=>a.timestamp-b.timestamp);
    saveState();

    // set date range if empty
    if (!state.filters.from || !state.filters.to) {
      const now = Date.now();
      state.filters.from = addDays(startOfDay(now), -30);
      state.filters.to = now;
      syncFilterInputs();
    }

    toast(`Imported ${imported.length} events.`);
    render();
  });

  $("#exportJson").addEventListener("click", () => {
    downloadText("pulseanalytics_export.json", JSON.stringify({ events: state.events }, null, 2), "application/json");
  });

  $("#exportCsv").addEventListener("click", () => {
    downloadText("pulseanalytics_export.csv", eventsToCSV(state.events), "text/csv");
  });

  $("#wipeData").addEventListener("click", () => {
    if (!confirm("Wipe ALL data? This cannot be undone.")) return;
    state.events = [];
    saveState();
    toast("Data wiped.");
    render();
  });
}

function openEventModal() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset()*60000);
  $("#evTime").value = local.toISOString().slice(0,16);
  $("#evUser").value = `u_${String(Math.floor(Math.random()*999)+1).padStart(3,"0")}`;
  $("#evType").value = "session_start";
  $("#evDevice").value = "mobile";
  $("#evRegion").value = "NA";
  $("#evPlan").value = "free";
  $("#evValue").value = "";
  $("#evCategory").value = "";
  $("#evProps").value = `{"page":"/","utm":"none"}`;

  $("#eventModal").classList.remove("hidden");
}

function closeEventModal() {
  $("#eventModal").classList.add("hidden");
}

function saveEventFromModal() {
  const ts = Date.parse($("#evTime").value);
  const user_id = ($("#evUser").value || "").trim();
  const event = $("#evType").value;

  const device = $("#evDevice").value;
  const region = $("#evRegion").value;
  const plan = $("#evPlan").value;

  const valueRaw = ($("#evValue").value || "").trim();
  const value = valueRaw === "" ? null : Number(valueRaw);

  const category = ($("#evCategory").value || "").trim() || null;
  const propsRaw = ($("#evProps").value || "").trim();
  const properties = propsRaw ? safeJsonParse(propsRaw, {}) : {};

  const ev = normalizeEvent({ timestamp: ts, user_id, event, device, region, plan, value, category, properties });
  if (!ev) { toast("Invalid event (check timestamp/user)."); return; }

  state.events.push(ev);
  state.events.sort((a,b)=>a.timestamp-b.timestamp);
  saveState();

  if (!state.filters.from || !state.filters.to) {
    const now = Date.now();
    state.filters.from = addDays(startOfDay(now), -30);
    state.filters.to = now;
    syncFilterInputs();
  }

  closeEventModal();
  toast("Event added.");
  render();
}

function renderSegmentResults(res) {
  $("#segUsers").textContent = fmtInt(res.matchedUsers.length);
  $("#segRevenue").textContent = fmtMoney(res.kpis.revenue);
  $("#segOrders").textContent = fmtInt(res.kpis.orders);
  $("#segConv").textContent = `${(res.kpis.conversion*100).toFixed(1)}%`;

  const tbody = $("#segTopUsers tbody");
  tbody.innerHTML = "";
  for (const u of res.matchedUsers.slice(0, 12)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(u.user_id)}</td>
      <td>${escapeHtml(u.plan)}</td>
      <td>${escapeHtml(u.region)}</td>
      <td>${escapeHtml(u.device)}</td>
      <td>${escapeHtml(fmtMoney(u.revenue))}</td>
      <td>${escapeHtml(fmtInt(u.orders))}</td>
    `;
    tbody.appendChild(tr);
  }
}

function clearSegmentResults() {
  $("#segUsers").textContent = "—";
  $("#segRevenue").textContent = "—";
  $("#segOrders").textContent = "—";
  $("#segConv").textContent = "—";
  $("#segTopUsers tbody").innerHTML = "";
}

// ---------------- Small utilities ----------------
function shorten(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n-1) + "…" : s;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function toast(msg) {
  const div = document.createElement("div");
  div.textContent = msg;
  div.style.position = "fixed";
  div.style.bottom = "16px";
  div.style.right = "16px";
  div.style.padding = "12px 14px";
  div.style.borderRadius = "14px";
  div.style.border = "1px solid var(--border)";
  div.style.background = "rgba(0,0,0,0.55)";
  div.style.backdropFilter = "blur(10px)";
  div.style.color = "var(--text)";
  div.style.zIndex = "200";
  div.style.boxShadow = "var(--shadow)";
  document.body.appendChild(div);
  setTimeout(()=>div.remove(), 1700);
}

// ---------------- Init ----------------
function initDefaults() {
  // default range: last 30 days (even if empty)
  const now = Date.now();
  state.filters.from = addDays(startOfDay(now), -30);
  state.filters.to = now;
}

function init() {
  loadTheme();
  loadState();
  initDefaults();
  syncFilterInputs();
  hookUI();

  // if there is data, adjust filter range to data max/min (but still last 30 days)
  if (state.events.length) {
    const maxTs = Math.max(...state.events.map(e=>e.timestamp));
    state.filters.to = maxTs;
    state.filters.from = addDays(startOfDay(maxTs), -30);
    syncFilterInputs();
  }

  render();
  setView("overview");
}

init();
