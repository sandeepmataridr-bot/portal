"use strict";
// Vigil central station client. Polls /api/state once a second and updates
// keyed DOM in place (so hover, open tables and typed names survive refreshes).
// All server strings go in via textContent.

const $ = (sel, root = document) => root.querySelector(sel);
const SVGNS = "http://www.w3.org/2000/svg";
const POLL_MS = 1000;
const LOST_AFTER_MS = 5000;  // plan §3.1: a stream gap over 5 s means "no live data"
const LEVELS = {
  0: ["Level 0 · Full operation", "All machines reporting; edge safety floor and core rules running."],
  1: ["Level 1 · Degraded", ""],
  2: ["Level 2 · Safety floor only", ""],
  3: ["Level 3 · Central station offline", "This screen has lost the edge node. Use the bedside devices and their alarms."],
};
const GOOD_SQI = 0.8;
const GAP_S = 30;            // break the line across data gaps longer than this
const PRIORITY_MARK = { HIGH: "!!!", MEDIUM: "!!", LOW: "!", ADVISORY: "i" };
const KIND_MARK = { raised: "▲", resolved: "✓", acknowledged: "◉" };
const STATUS_TEXT = {
  ok: "Receiving", waiting: "Waiting for data", no_data: "No data",
  unconfirmed: "Association not confirmed", unassociated: "Not associated",
};

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c);
  return el;
}
function sv(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// ── formatting ──────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
function fmtTime(t) {
  if (!state) return "--";
  if (state.simulated_clock) {
    const s = Math.max(0, Math.round(t));
    return `T+${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }
  return new Date(t * 1000).toLocaleTimeString([], { hour12: false });
}
function fmtDur(sec) {
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}
const fmtAgo = (sec) => (sec < 1 ? "just now" : `${fmtDur(sec)} ago`);
function fmtVal(v) {
  if (v == null || !isFinite(v)) return "--";
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
}
function fmtWindow(s) { return s >= 3600 ? `${s / 3600} h` : `${s / 60} min`; }

// ── state & polling ─────────────────────────────────────────────────────
let state = null;
let windowS = Number(store.get("vigil.window", "1800"));
let lastOk = 0;
let timer = null;
let runId = null;

async function poll() {
  clearTimeout(timer);
  try {
    const r = await fetch(`/api/state?window=${windowS}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state = await r.json();
    lastOk = Date.now();
    setConnection(true);
    render();
  } catch (e) {
    setConnection(false);
  } finally {
    timer = setTimeout(poll, POLL_MS);
  }
}

function setConnection(ok) {
  const conn = $("#conn");
  const lost = !ok && Date.now() - lastOk > LOST_AFTER_MS;
  conn.className = "conn " + (ok ? "ok" : lost ? "bad" : "");
  $("#conn-text").textContent = ok ? "Connected" : lost ? "Disconnected" : "Retrying";
  $("#conn-lost").hidden = !lost;
  document.body.classList.toggle("is-stale", lost);
  if (lost) {
    $("#lost-at").textContent = lastOk ? new Date(lastOk).toLocaleTimeString([], { hour12: false }) : "start-up";
    renderLevel(3, []);
  }
}

// The operating-level banner is part of the shell: no control hides it.
function renderLevel(level, reasons) {
  const [name, text] = LEVELS[level];
  $("#op-level").className = `op-level lvl-${level}`;
  $("#op-level-name").textContent = name;
  $("#op-level-text").textContent = reasons.length ? reasons.join("; ") + "." : text;
}

// ── alarm layer ─────────────────────────────────────────────────────────
// Rendered first and on its own; if anything else in the page throws, the
// full-screen fallback still lists the active alarms.
let fallbackShown = false;

function showFallback(err) {
  fallbackShown = true;
  console.error("central station render failed", err);
  $("#fallback").hidden = false;
  renderFallbackAlarms();
}

function renderFallbackAlarms() {
  if (!fallbackShown || !state || !state.alerts) return;
  const ul = $("#fallback-alarms");
  ul.replaceChildren(...(state.alerts.length ? state.alerts.map((a) => {
    const li = document.createElement("li");
    li.className = `fb-${a.priority}`;
    li.textContent = `${PRIORITY_MARK[a.priority]} ${a.priority}  ${a.encounter}  ${a.explanation}` +
      (a.acknowledged_by ? `  (acknowledged by ${a.acknowledged_by})` : "");
    return li;
  }) : [Object.assign(document.createElement("li"), { textContent: "No active alarms." })]));
}

window.addEventListener("error", (e) => showFallback(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => showFallback(e.reason));

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch { /* empty body */ }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ── render ──────────────────────────────────────────────────────────────
function render() {
  if (!state.ready) {
    $("#machines-empty").hidden = false;
    $("#machines-empty").textContent = "Waiting for the edge node to start.";
    renderTestBar();
    return;
  }
  renderFallbackAlarms();
  try {
    if (state.run_id !== runId) resetRun();
    renderAlerts();
  } catch (e) {
    showFallback(e);
  }
  try {
    renderLevel(state.operating_level, state.operating_reasons);
    renderHeader();
    renderTestBar();
    renderWindowSeg();
    renderMachines();
    renderLog();
  } catch (e) {
    showFallback(e);
  }
}

function resetRun() {
  runId = state.run_id;
  for (const m of machineEls.values()) m.root.remove();
  machineEls.clear();
  for (const el of alertEls.values()) el.remove();
  alertEls.clear();
  const rules = $("#rules");
  rules.replaceChildren(...state.rules.map((r) =>
    h("li", {}, h("span", { text: r.key }), h("span", { class: "muted", text: `${r.priority.toLowerCase()} · ${r.placement}` }))));
}

function renderHeader() {
  $("#unit").textContent = state.unit_id;
  $("#tenant").textContent = state.tenant_id;
  const badge = $("#mode-badge");
  badge.hidden = false;
  badge.className = "mode-badge " + state.mode;
  badge.textContent = state.mode === "test" ? "TEST" : "LIVE";
  $("#clock").textContent = fmtTime(state.now);
  $("#clock-sub").textContent = state.simulated_clock ? "simulated clock" : "local time";
  $("#footer-node").textContent = `Edge node ${state.edge_node_id} · ${state.stats.observations.toLocaleString()} observations`;
  const n = state.alerts.length;
  document.title = `${n ? `(${n}) ` : ""}${state.mode === "test" ? "[TEST] " : ""}Vigil Central Station`;
}

function renderTestBar() {
  const bar = $("#test-bar");
  const c = state && state.controller;
  bar.hidden = !c;
  if (!c) return;
  const sel = $("#scenario-select");
  if (sel.options.length !== c.scenarios.length) {
    sel.replaceChildren(...c.scenarios.map((s) => h("option", { value: s, text: s })));
  }
  if (document.activeElement !== sel && !sel.dataset.dirty) sel.value = c.scenario;
  const sp = $("#speed-select");
  if (sp.options.length !== c.speeds.length) {
    sp.replaceChildren(...c.speeds.map((s) => h("option", { value: s, text: `${s}×` })));
  }
  if (document.activeElement !== sp) sp.value = String(c.speed);
  const err = $("#test-error");
  err.hidden = !c.error;
  err.textContent = c.error ? `Scenario failed: ${c.error}` : "";

  const sc = state.ready && state.scenario;
  if (!sc) return;
  const frac = Math.min(1, state.now / sc.duration);
  $("#progress-fill").style.width = `${(frac * 100).toFixed(2)}%`;
  const marks = $("#progress-marks");
  if (marks.dataset.run !== String(state.run_id)) {
    marks.dataset.run = state.run_id;
    marks.replaceChildren(...sc.annotations.map((a) => {
      const mk = h("div", { class: "progress-mark", title: `Annotated event ${fmtTime(a.at)}: ${a.label}` });
      mk.style.left = `${((a.at / sc.duration) * 100).toFixed(2)}%`;
      return mk;
    }));
  }
  const status = state.finished ? (state.stopped ? "stopped" : "finished") : `${c.speed}×`;
  $("#progress-text").textContent = `${fmtTime(state.now)} of ${fmtDur(sc.duration)} · ${status}`;
}

function renderWindowSeg() {
  const seg = $("#window-seg");
  if (!seg.children.length) {
    for (const w of state.windows) {
      seg.append(h("button", {
        type: "button", role: "radio", "data-w": w, text: fmtWindow(w),
        onclick: () => { windowS = w; store.set("vigil.window", String(w)); renderWindowSeg(); poll(); },
      }));
    }
  }
  for (const b of seg.children) b.setAttribute("aria-checked", String(Number(b.dataset.w) === windowS));
}

// ── alerts ──────────────────────────────────────────────────────────────
const alertEls = new Map();

function renderAlerts() {
  const list = $("#alerts");
  const seen = new Set();
  state.alerts.forEach((a, i) => {
    seen.add(a.id);
    let el = alertEls.get(a.id);
    if (!el) { el = buildAlert(a); alertEls.set(a.id, el); }
    updateAlert(el, a);
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
  });
  for (const [id, el] of alertEls) if (!seen.has(id)) { el.remove(); alertEls.delete(id); }
  $("#alerts-empty").hidden = state.alerts.length > 0;
  $("#alert-count").textContent = state.alerts.length;
}

function buildAlert(a) {
  const r = {
    pri: h("div", { class: "pri" }),
    title: h("div", { class: "alert-title" }),
    expl: h("div", { class: "alert-expl" }),
    meta: h("div", { class: "alert-meta" }),
    btn: h("button", { class: "btn", type: "button", text: "Acknowledge" }),
    acked: h("span", { class: "acked" }),
    err: h("span", { class: "form-error", role: "alert" }),
  };
  r.btn.addEventListener("click", () => acknowledge(a.id, r));
  const el = h("div", { class: "alert", role: "group" }, r.pri, r.title, r.expl, r.meta,
    h("div", { class: "alert-actions" }, r.btn, r.acked, r.err));
  el._r = r;
  return el;
}

function updateAlert(el, a) {
  const r = el._r;
  const acked = a.state === "ACKNOWLEDGED";
  el.className = `alert pri-${a.priority}${acked ? " is-acked" : ""}`;
  el.setAttribute("aria-label", `${a.priority} priority alert: ${a.rule}`);
  r.pri.replaceChildren(h("span", { class: "mk", text: PRIORITY_MARK[a.priority] }), h("span", { text: a.priority }));
  r.title.replaceChildren(a.rule, h("span", { class: "tag", text: `${a.version} · ${a.origin}` }));
  r.expl.textContent = a.explanation;
  r.meta.textContent = `Patient ${a.encounter} · raised ${fmtTime(a.raised)} (${fmtAgo(state.now - a.raised)}) · id ${a.id}`;
  r.btn.hidden = acked;
  r.acked.textContent = acked ? `✓ Acknowledged by ${a.acknowledged_by}` : "";
}

async function acknowledge(id, r) {
  const input = $("#ack-name");
  const by = input.value.trim();
  if (!by) {
    r.err.textContent = "Enter your name above first.";
    input.focus();
    return;
  }
  store.set("vigil.ackName", by);
  r.btn.disabled = true;
  r.err.textContent = "";
  try {
    await post("/api/ack", { id, by });
    poll();
  } catch (e) {
    r.err.textContent = `Not acknowledged: ${e.message}`;
  } finally {
    r.btn.disabled = false;
  }
}

// ── event log ───────────────────────────────────────────────────────────
function renderLog() {
  const log = $("#log");
  log.replaceChildren(...state.log.map((e) => h("li", {},
    h("time", { text: fmtTime(e.at) }),
    h("span", { class: `k k-${e.kind} ${e.priority}`, title: e.kind, text: KIND_MARK[e.kind] || "•" }),
    h("span", { class: "what" },
      `${e.kind === "raised" ? `${e.priority} ` : ""}${e.rule} · ${e.encounter}`,
      h("small", { text: e.kind === "raised" ? e.explanation : e.kind === "acknowledged" ? `acknowledged by ${e.by}` : "resolved" })),
  )));
  $("#log-empty").hidden = state.log.length > 0;
}

// Alert intervals per encounter, from the log plus active alerts.
function alertBands(encounter) {
  const open = new Map();
  const bands = [];
  for (const e of [...state.log].reverse()) {
    if (e.encounter !== encounter) continue;
    if (e.kind === "raised") open.set(e.id, [e.at, e.priority]);
    if (e.kind === "resolved" && open.has(e.id)) {
      const [at, pri] = open.get(e.id);
      bands.push([at, e.at, pri]);
      open.delete(e.id);
    }
  }
  for (const [at, pri] of open.values()) bands.push([at, state.now, pri]);
  for (const a of state.alerts) {
    if (a.encounter === encounter && !bands.some((b) => b[0] === a.raised)) bands.push([a.raised, state.now, a.priority]);
  }
  return bands;
}

// ── machines ────────────────────────────────────────────────────────────
const machineEls = new Map();

function renderMachines() {
  const grid = $("#machines");
  const seen = new Set();
  state.machines.forEach((m, i) => {
    seen.add(m.device_id);
    let c = machineEls.get(m.device_id);
    if (!c) { c = buildMachine(m); machineEls.set(m.device_id, c); }
    updateMachine(c, m);
    if (grid.children[i] !== c.root) grid.insertBefore(c.root, grid.children[i] || null);
  });
  for (const [id, c] of machineEls) if (!seen.has(id)) { c.root.remove(); machineEls.delete(id); }
  $("#machines-empty").hidden = state.machines.length > 0;
  $("#machines-empty").textContent = "No machines have sent data yet.";
  $("#machine-count").textContent = state.machines.length;
}

function buildMachine(m) {
  const r = {
    name: h("h3", { text: m.device_id }),
    kind: h("div", { class: "m-kind" }),
    status: h("span", { class: "status" }),
    patient: h("p", { class: "m-patient" }),
    sigs: h("div", { class: "m-signals" }),
  };
  const root = h("article", { class: "machine", "aria-label": `Machine ${m.device_id}` },
    h("div", { class: "m-head" }, h("div", {}, r.name, r.kind), r.status), r.patient, r.sigs);
  return { root, r, sigs: new Map() };
}

function updateMachine(c, m) {
  const r = c.r;
  c.root.dataset.alert = m.alert_priority || "";
  c.root.classList.toggle("is-nodata", m.status === "no_data");
  r.kind.textContent = `${m.kind} · ${m.driver}${m.unmapped ? ` · ${m.unmapped} unmapped values` : ""}`;
  r.status.className = `status ${m.status}`;
  r.status.textContent = m.status === "no_data" && m.age != null ? `No live data for ${fmtDur(m.age)}` : STATUS_TEXT[m.status];

  const parts = [];
  if (m.encounter_id) {
    parts.push("Patient ", h("b", { text: m.encounter_id }));
    if (m.therapy) parts.push(` · ${m.therapy}${m.therapy_detail ? ` ${m.therapy_detail}` : ""}`);
    parts.push(m.confirmed_by ? ` · confirmed by ${m.confirmed_by}` : " · not confirmed, rules paused");
  } else {
    parts.push("Not associated with a patient. Data is recorded but no rules run.");
  }
  if (m.alert_priority) parts.push(h("span", { class: "m-alert", text: `${PRIORITY_MARK[m.alert_priority]} ${m.alert_priority} alert` }));
  r.patient.replaceChildren(...parts);

  const bands = m.encounter_id ? alertBands(m.encounter_id) : [];
  const seen = new Set();
  m.signals.forEach((s, i) => {
    seen.add(s.code);
    let sc = c.sigs.get(s.code);
    if (!sc) { sc = buildSignal(s); c.sigs.set(s.code, sc); }
    sc.update(s, m, bands);
    if (r.sigs.children[i] !== sc.root) r.sigs.insertBefore(sc.root, r.sigs.children[i] || null);
  });
  for (const [code, sc] of c.sigs) if (!seen.has(code)) { sc.root.remove(); c.sigs.delete(code); }
}

function buildSignal(s) {
  if (s.kind === "numeric") return numericSignal(s);
  if (s.kind === "lab") return labSignal(s);
  return settingSignal(s);
}

function qualityChip(chip, s, stale) {
  if (stale) { chip.hidden = false; chip.className = "chip bad"; chip.textContent = "NO LIVE DATA"; return; }
  const low = s.sqi < GOOD_SQI && s.flags.length;
  chip.hidden = !low;
  chip.className = "chip";
  if (low) chip.textContent = `⚠ ${s.flags.filter((f) => f !== "SETTING").join(", ")} · SQI ${s.sqi.toFixed(1)}`;
}

function numericSignal(s) {
  const r = {
    val: h("span", { class: "val" }), unit: h("span", { class: "unit" }), age: h("span", { class: "sig-age" }),
    chip: h("span", { class: "chip", hidden: true }), chartBox: h("div", { class: "chart" }),
    legend: h("span", { class: "legend" }),
    toggle: h("button", { class: "link", type: "button", "aria-expanded": "false", text: "Show values" }),
    table: h("table", { class: "vals", hidden: true }),
  };
  const root = h("div", { class: "sig" },
    h("div", { class: "sig-head" }, h("span", { class: "sig-label", text: s.label }), r.chip),
    h("div", { class: "sig-body" }, h("div", { class: "sig-value" }, r.val, r.unit, r.age), r.chartBox),
    h("div", { class: "sig-foot" }, r.legend, r.toggle), r.table);
  const chart = new LineChart(r.chartBox);
  r.toggle.addEventListener("click", () => {
    r.table.hidden = !r.table.hidden;
    r.toggle.setAttribute("aria-expanded", String(!r.table.hidden));
    r.toggle.textContent = r.table.hidden ? "Show values" : "Hide values";
    if (last) fillTable(last);
  });
  let last = null;

  function fillTable(sig) {
    const rows = sig.points.slice(-10).reverse();
    r.table.replaceChildren(
      h("thead", {}, h("tr", {}, h("th", { text: "Time" }), h("th", { class: "num", text: sig.unit }), h("th", { class: "num", text: "Quality" }))),
      h("tbody", {}, ...rows.map((p) => h("tr", {},
        h("td", { text: fmtTime(p[0]) }), h("td", { class: "num", text: fmtVal(p[1]) }),
        h("td", { class: "num", text: p[2] < GOOD_SQI ? `${p[2].toFixed(1)} low` : p[2].toFixed(1) })))));
  }

  return {
    root,
    update(sig, m, bands) {
      last = sig;
      const stale = m.status === "no_data";
      root.classList.toggle("is-old", stale);
      r.val.textContent = fmtVal(sig.value);
      r.unit.textContent = sig.unit;
      r.age.textContent = `updated ${fmtAgo(sig.age)}`;
      qualityChip(r.chip, sig, stale);
      const hasLow = sig.points.some((p) => p[2] < GOOD_SQI);
      r.legend.replaceChildren(...(hasLow ? [
        h("span", {}, h("i", { class: "key-line" }), "measured"),
        h("span", {}, h("i", { class: "key-ring" }), "low quality, ignored by rules"),
      ] : []));
      chart.update(sig, state.now, state.window, bands);
      if (!r.table.hidden) fillTable(sig);
    },
  };
}

function settingSignal(s) {
  const r = { val: h("span", { class: "val" }), unit: h("span", { class: "unit" }), note: h("span", { class: "note" }) };
  const root = h("div", { class: "sig" },
    h("div", { class: "sig-head" }, h("span", { class: "sig-label", text: `${s.label}` })),
    h("div", { class: "sig-compact" }, r.val, r.unit, r.note));
  return {
    root,
    update(sig) {
      r.val.textContent = fmtVal(sig.value);
      r.unit.textContent = sig.unit;
      r.note.textContent = `setting, unchanged for ${fmtDur(state.now - sig.changed_at)} · updated ${fmtAgo(sig.age)}`;
    },
  };
}

function labSignal(s) {
  const r = {
    val: h("span", { class: "val" }), unit: h("span", { class: "unit" }), note: h("span", { class: "note" }),
    table: h("table", { class: "vals" }),
  };
  const root = h("div", { class: "sig" },
    h("div", { class: "sig-head" }, h("span", { class: "sig-label", text: s.label })),
    h("div", { class: "sig-compact" }, r.val, r.unit, r.note), r.table);
  return {
    root,
    update(sig) {
      r.val.textContent = fmtVal(sig.value);
      r.unit.textContent = sig.unit;
      r.note.textContent = `resulted ${fmtTime(sig.t)} (${fmtAgo(sig.age)})`;
      const rows = sig.points.slice(0, -1).slice(-5).reverse();
      r.table.hidden = rows.length === 0;
      r.table.replaceChildren(
        h("thead", {}, h("tr", {}, h("th", { text: "Earlier results" }), h("th", { class: "num", text: sig.unit }))),
        h("tbody", {}, ...rows.map((p) => h("tr", {}, h("td", { text: fmtTime(p[0]) }), h("td", { class: "num", text: fmtVal(p[1]) })))));
    },
  };
}

// ── line chart ──────────────────────────────────────────────────────────
function niceTicks(lo, hi, count = 3) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 0.5 && ticks.length < 8; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

class LineChart {
  constructor(box) {
    this.box = box;
    this.svg = sv("svg", { role: "img", tabindex: "0" });
    this.plot = sv("g");
    this.hover = sv("g");
    this.svg.append(this.plot, this.hover);
    box.append(this.svg);
    this.pointer = null;
    this.svg.addEventListener("pointermove", (e) => { this.pointer = { x: e.clientX, y: e.clientY }; this.drawHover(); });
    this.svg.addEventListener("pointerleave", () => { this.pointer = null; this.drawHover(); });
    this.svg.addEventListener("focus", () => { this.focused = true; this.drawHover(); });
    this.svg.addEventListener("blur", () => { this.focused = false; this.drawHover(); });
  }

  update(sig, now, win, bands) {
    Object.assign(this, { sig, now, win, bands });
    this.draw();
  }

  geometry() {
    const W = Math.max(160, this.box.clientWidth), H = 92, L = 38, R = 10, T = 8, B = 18;
    const t0 = this.now - this.win;
    const pts = this.sig.points;
    const good = pts.filter((p) => p[2] >= GOOD_SQI);
    const basis = good.length ? good : pts;
    let lo = Math.min(...basis.map((p) => p[1])), hi = Math.max(...basis.map((p) => p[1]));
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    const padY = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.05, 0.5);
    lo -= padY; hi += padY;
    const ticks = niceTicks(lo, hi);
    lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
    const x = (t) => L + ((t - t0) / this.win) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    return { W, H, L, R, T, B, t0, x, y, ticks, good };
  }

  draw() {
    const g = this.geometry();
    this.g = g;
    const { W, H, L, R, T, B, x, y } = g;
    this.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const kids = [];
    for (const [a, b, pri] of this.bands || []) {
      const xa = Math.max(L, x(a)), xb = Math.min(W - R, x(b));
      if (xb > xa) kids.push(sv("rect", { class: `alert-band ${pri}`, x: xa, y: T, width: Math.max(2, xb - xa), height: H - T - B }));
    }
    for (const v of g.ticks) {
      const yy = y(v);
      if (yy < T - 1 || yy > H - B + 1) continue;
      kids.push(sv("line", { class: "grid", x1: L, x2: W - R, y1: yy, y2: yy }));
      const label = sv("text", { class: "tick", x: L - 6, y: yy + 3, "text-anchor": "end" });
      label.textContent = Math.abs(v) >= 100 ? v.toFixed(0) : +v.toFixed(1);
      kids.push(label);
    }
    kids.push(sv("line", { class: "base", x1: L, x2: W - R, y1: H - B, y2: H - B }));
    for (const [frac, text] of [[0, `-${fmtWindow(this.win)}`], [0.5, `-${fmtWindow(this.win / 2)}`], [1, "now"]]) {
      const lbl = sv("text", { class: "tick", x: L + frac * (W - L - R), y: H - 4,
        "text-anchor": frac === 0 ? "start" : frac === 1 ? "end" : "middle" });
      lbl.textContent = text;
      kids.push(lbl);
    }

    let d = "", prev = null;
    for (const p of g.good) {
      d += `${prev && p[0] - prev[0] <= GAP_S ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`;
      prev = p;
    }
    if (d) kids.push(sv("path", { class: "line", d }));
    for (const p of this.sig.points) {
      if (p[2] < GOOD_SQI) kids.push(sv("circle", { class: "ring", cx: x(p[0]), cy: Math.min(H - B, Math.max(T, y(p[1]))), r: 4 }));
    }
    const lastGood = g.good[g.good.length - 1];
    if (lastGood) kids.push(sv("circle", { class: "last", cx: x(lastGood[0]), cy: y(lastGood[1]), r: 3.5 }));
    if (!this.sig.points.length) {
      const t = sv("text", { class: "nodata", x: (L + W - R) / 2, y: H / 2, "text-anchor": "middle" });
      t.textContent = "No data in this window";
      kids.push(t);
    }
    this.plot.replaceChildren(...kids);
    this.svg.setAttribute("aria-label",
      `${this.sig.label}, last ${fmtWindow(this.win)}: latest ${fmtVal(this.sig.value)} ${this.sig.unit}. Use Show values for a table.`);
    this.drawHover();
  }

  drawHover() {
    const tip = $("#tooltip");
    const pts = this.sig ? this.sig.points : [];
    if ((!this.pointer && !this.focused) || !pts.length || !this.g) {
      this.hover.replaceChildren();
      if (tip._owner === this) { tip.hidden = true; tip._owner = null; }
      return;
    }
    const { x, y, H, T, B } = this.g;
    const rect = this.svg.getBoundingClientRect();
    const scale = rect.width / this.g.W;
    let p = pts[pts.length - 1];
    if (this.pointer) {
      const px = (this.pointer.x - rect.left) / scale;
      p = pts.reduce((best, q) => (Math.abs(x(q[0]) - px) < Math.abs(x(best[0]) - px) ? q : best), pts[0]);
    }
    const cx = x(p[0]), cy = Math.min(H - B, Math.max(T, y(p[1])));
    this.hover.replaceChildren(
      sv("line", { class: "cross", x1: cx, x2: cx, y1: T, y2: H - B }),
      sv("circle", { class: p[2] < GOOD_SQI ? "ring" : "hover-dot", cx, cy, r: 4.5 }));

    tip.replaceChildren(
      h("div", { class: "tv" }, h("i"), `${fmtVal(p[1])} ${this.sig.unit}`),
      h("div", { class: "tl", text: `${this.sig.label} · ${fmtTime(p[0])}` }),
      p[2] < GOOD_SQI ? h("div", { class: "tq", text: `Low signal quality (${p[2].toFixed(1)}), ignored by rules` }) : null);
    tip.hidden = false;
    tip._owner = this;
    const ax = this.pointer ? this.pointer.x : rect.left + cx * scale;
    const ay = this.pointer ? this.pointer.y : rect.top + cy * scale;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = ax + 14, top = ay - th - 10;
    if (left + tw > window.innerWidth - 8) left = ax - tw - 14;
    if (top < 8) top = ay + 16;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${top}px`;
  }
}

// ── controls ────────────────────────────────────────────────────────────
function initTheme() {
  const saved = store.get("vigil.theme", "");
  if (saved) document.documentElement.dataset.theme = saved;
  $("#theme-toggle").addEventListener("click", () => {
    const current = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("vigil.theme", next);
    if (state) render();
  });
}

function initControls() {
  const name = $("#ack-name");
  name.value = store.get("vigil.ackName", "");
  name.addEventListener("change", () => store.set("vigil.ackName", name.value.trim()));

  const sel = $("#scenario-select");
  sel.addEventListener("change", () => { sel.dataset.dirty = "1"; });
  $("#restart-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await post("/api/run", { scenario: sel.value, speed: Number($("#speed-select").value) });
      delete sel.dataset.dirty;
      poll();
    } catch (err) {
      $("#test-error").hidden = false;
      $("#test-error").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  $("#speed-select").addEventListener("change", async (e) => {
    try { await post("/api/speed", { speed: Number(e.target.value) }); } catch (err) {
      $("#test-error").hidden = false;
      $("#test-error").textContent = err.message;
    }
  });
  window.addEventListener("resize", () => { if (state && state.ready) renderMachines(); });
}

initTheme();
initControls();
poll();
