// "Full report" tab: load a results map, drop in the report generator's tables, pick pages and
// detail spots, and download the whole evaluation report as one PDF.
import { loadReportData, buildFullReport, renderInset, renderPickerBase, defaultInset, insetExtent, parseCsv, tableNumber, cleanTable,
  derivedNumbers, defaultTexts, TEXT_EXAMPLES, blankTable, tableHasData, featureAt, popupFields, defaultPopupFields, loadPopup, PAGES, INSETS } from "./report.js?v=20261017121544";
import { DEFAULTS, layerKey, defaultOrder } from "./renderer.js?v=20261017121544";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const local = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
// printed size (pt) of each detail slot — uploads are cropped to this shape
const SLOT_PT = { overview: [157, 99], sidewalk: [100, 96], crosswalk: [500, 270] };
const TABLE_NAMES = { 1: "Sidewalk phasing (DCS)", 2: "Sidewalk defects", 3: "Crosswalks by score", 4: "Yield / stop control", 5: "Traffic signal",
  6: "Uncontrolled", 7: "Midblock / roundabout", 8: "Curb ramp defects", 9: "Curb ramp phasing", 10: "Transit stops" };
const NEEDS = { overviewMap: { t: [1] }, sidewalkMap: { g: "sidewalks", t: [2] }, crosswalkMap: { g: "crosswalks", t: [3] }, crosswalkDetails: { t: [4, 5, 6, 7] },
  curbMap: { g: "curbRamps", t: [8] }, curbPhasing: { t: [9] }, refuge: { g: "refuge" }, signals: { g: "signals" }, transit: { g: "transit", t: [10] } };

let ctx, data = null, mapId = null, S = null;   // S = saved state for this map
const uploads = {};

function blankState() {
  const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { fields: { coverName: "", city: "", shortName: "", year: String(new Date().getFullYear()), date: today, miles: "", ramps: "" },
    tables: {}, reliability: blankTable("reliability"), include: PAGES.map((p) => p[0]), insets: {}, texts: null, textOverride: {}, popupOn: true, popup: null,
    notNeeded: { fields: {}, tables: {} }, icons: null, order: null, savedAt: null };
}
const save = () => { if (!mapId) return; S.savedAt = Date.now(); local.set(`report:${mapId}`, S); updateChecklist(); scheduleLive(); };

// ---------------------------------------------------------------- deps for the PDF
let fontCache = null, assetCache = null;
async function reportFonts() {
  if (fontCache) return fontCache;
  const get = async (f) => { const b = new Uint8Array(await (await fetch(`fonts/${f}`)).arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
  fontCache = { montB: await get("montserrat-700.ttf"), montSB: await get("montserrat-600.ttf"), popL: await get("poppins-300.ttf"), pop: await get("poppins-400.ttf"), popM: await get("poppins-500.ttf"), popSB: await get("poppins-600.ttf") };
  return fontCache;
}
async function assets() {
  if (assetCache) return assetCache;
  const one = async (f) => {
    const data = new Uint8Array(await (await fetch(`report-assets/${f}`)).arrayBuffer());
    const im = await ctx.loadImage(URL.createObjectURL(new Blob([data])));
    return { data, type: f.endsWith(".png") ? "PNG" : "JPEG", w: im.width, h: im.height };
  };
  const [cover, cone, logo, mark, a, b, c, d] = await Promise.all(["cover.jpg", "cone.jpg", "logo.png", "mark.png", "icon-sidewalks.png", "icon-crosswalks.png", "icon-curbramps.png", "icon-transit.png"].map(one));
  assetCache = { cover, cone, logo, mark, iconSidewalks: a, iconCrosswalks: b, iconCurbramps: c, iconTransit: d };
  return assetCache;
}
const deps = () => ({ fetchJson: ctx.fetchJson, fetchImage: ctx.fetchImage, createCanvas: ctx.createCanvas, loadImage: ctx.loadImage, jsPDF: window.jspdf.jsPDF,
  toJpeg: (cv, q) => ctx.blobBytes(cv, "image/jpeg", q), toPng: (cv) => ctx.blobBytes(cv, "image/png") });

function log(msg, progress) {
  const el = $("rlog");
  if (progress && el.lastChild && el.lastChild.dataset.progress) el.lastChild.textContent = msg;
  else { const d = document.createElement("div"); d.textContent = msg; if (progress) d.dataset.progress = "1"; el.appendChild(d); }
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------- step 1: load
async function loadData() {
  const id = $("rmap").value; if (!id) return;
  $("rload").disabled = true; $("rlog").innerHTML = ""; $("rsteps").hidden = true;
  showSide(true);
  $("rview").innerHTML = '<p class="pempty">Loading map data…</p>'; pstatus("Preview"); loadPdfJs().catch(() => {});
  try {
    data = await loadReportData(deps(), ctx.SHARING, id, log);
    mapId = id;
    const stored = local.get(`report:${id}`);
    S = Object.assign(blankState(), stored || {});
    S.notNeeded = Object.assign({ fields: {}, tables: {} }, S.notNeeded || {});
    const md = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(S.fields.date || "");   // older saves used MM/DD/YYYY
    if (md) S.fields.date = `${md[3]}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`;
    showRestored(stored && stored.savedAt);
    // earlier versions pre-filled 98% / 100%; accuracy is per report, so start those blank
    if (S.reliability.rows.every((r) => r[1] === "98%" && r[2] === "100%")) S.reliability = blankTable("reliability");
    for (let n = 1; n <= 10; n++) if (!S.tables[n]) S.tables[n] = blankTable(n);
    if (!S.fields.city) {
      const name = $("rmap").selectedOptions[0]?.textContent.replace(/\s*Results Map\s*$/i, "").trim() || "";
      S.fields.shortName = S.fields.shortName || name;
    }
    log(`Ready: ${data.layers.length} layers.`);
    $("rsteps").hidden = false;
    renderFields(); renderTables(); renderPages(); renderIcons(); renderTexts();
    // preview opens by default and stays live unless it was switched off for this map
    S.live = S.live !== false; $("rlive").checked = S.live;
    if (S.live) build(); else $("rview").innerHTML = '<p class="pempty">Live preview is off — tick <b>Live</b> or click <b>Refresh preview</b>.</p>';
    await renderPickers();
  } catch (e) { log(`Error: ${e.message}`); $("rview").innerHTML = `<p class="pempty">Couldn't load the map: ${esc(e.message)}</p>`; }
  $("rload").disabled = false;
}

// ---------------------------------------------------------------- step 2: details
const FIELD_LABELS = [["coverName", "Cover title", "e.g. Bangor, ME  or  Permian Basin MPO: Midland, TX"], ["city", "City, state (page footers)", "e.g. Bangor, ME"],
  ["shortName", "Name in page headings", "e.g. Bangor"], ["year", "Year", "e.g. 2026"], ["date", "Map date", "e.g. 10/08/2026"],
  ["miles", "Sidewalk miles evaluated", "e.g. 117.42"], ["ramps", "Curb ramps evaluated", "e.g. 1,937"]];
// miles / ramps fall back to the totals of Tables 1 / 9
const derivedField = (k) => { const d = derivedNumbers(S.tables); return k === "miles" ? d.miles : k === "ramps" ? d.ramps : ""; };
// miles and curb ramps are always the table totals (shown greyed out, not typed)
const DERIVED = { miles: "Table 1", ramps: "Table 9" };
const fieldDone = (k) => !!DERIVED[k] || !!S.notNeeded.fields[k] || String(S.fields[k] || "").trim() !== "";
function renderFields() {
  $("rfields").innerHTML = FIELD_LABELS.map(([k, label, ph]) => DERIVED[k]
    ? `<div class="fld derived" id="fld-${k}"><label for="f-${k}">${label}</label>
      <input id="f-${k}" readonly tabindex="-1" value="${esc(derivedField(k))}" placeholder="from ${DERIVED[k]}">
      <span class="hint" data-h="${k}"></span></div>`
    : `<div class="fld" id="fld-${k}"><label for="f-${k}">${label}</label>
      <input id="f-${k}" data-f="${k}" ${k === "date" ? 'type="date"' : ""} value="${esc(S.fields[k])}" placeholder="${esc(ph)}" ${S.notNeeded.fields[k] ? "disabled" : ""}>
      <span class="hint" data-h="${k}"></span>
      <label class="chk nn"><input type="checkbox" data-nn="${k}" ${S.notNeeded.fields[k] ? "checked" : ""}> Not needed</label></div>`).join("");
  $("rfields").querySelectorAll("input[data-f]").forEach((i) => i.oninput = () => { S.fields[i.dataset.f] = i.value; save(); refreshTexts(); fieldHints(); });
  $("rfields").querySelectorAll("input[data-nn]").forEach((c) => c.onchange = () => {
    const k = c.dataset.nn; if (c.checked) S.notNeeded.fields[k] = true; else delete S.notNeeded.fields[k];
    $(`f-${k}`).disabled = c.checked; save(); fieldHints();
  });
  fieldHints();
}
function fieldHints() {
  for (const [k] of FIELD_LABELS) {
    const h = $("rfields").querySelector(`[data-h="${k}"]`), el = $(`fld-${k}`); if (!h) continue;
    if (DERIVED[k]) { $(`f-${k}`).value = derivedField(k); h.textContent = `Numbers are derived from the tables (${DERIVED[k]})`; }
    el.classList.toggle("missing", !fieldDone(k));
  }
}

// ---------------------------------------------------------------- step 3: tables
const isReliability = (name) => /reliab|accura/i.test(name);
async function readTableFiles(files) {
  let n = 0;
  const take = async (name, text) => {
    if (isReliability(name)) { const t = parseCsv(text); if (t.header.length) { S.reliability = t; n++; } return; }
    const k = tableNumber(name); if (!k) return;
    S.tables[k] = cleanTable(k, parseCsv(text)); n++;
  };
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      const zip = await JSZip.loadAsync(file);
      for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir && /\.csv$/i.test(name)) await take(name, await entry.async("string"));
      // the generator's folder zip contains report_tables.zip — read that too
      const inner = Object.keys(zip.files).find((f) => /report_tables\.zip$/i.test(f));
      if (inner) n += await readTableFiles([new File([await zip.files[inner].async("blob")], "report_tables.zip")]);
    } else await take(file.name, await file.text());
  }
  return n;
}
const tableOf = (key) => (key === "reliability" ? S.reliability : S.tables[key]);
// empty value cells (labels / bins and "N/A" don't count)
function emptyCells(t) {
  const labelCol = (i) => i === 0 || /phase|as-built|lifecycle|category/i.test(t.header[i] || "");
  let n = 0, total = 0;
  t.rows.forEach((r) => r.forEach((c, i) => { if (labelCol(i)) return; total++; if (String(c ?? "").trim() === "") n++; }));
  return { n, total };
}
function tableStatus(key) {
  if (S.notNeeded.tables[key]) return { s: "nn", label: "Not needed" };
  const { n, total } = emptyCells(tableOf(key));
  if (!total || n === total) return { s: "blank", label: "Blank" };
  if (n) return { s: "partial", label: `${n} empty cell${n === 1 ? "" : "s"}` };
  return { s: "ok", label: "Filled in" };
}
function badgeFor(key) { const st = tableStatus(key); return `<span class="badge st-${st.s}">${st.label}</span>`; }
function gridHtml(key, title) {
  const t = tableOf(key), nn = !!S.notNeeded.tables[key];
  return `<details class="tbl ${nn ? "nn" : ""}" id="tbl-${key}" data-k="${key}" ${openGrids.has(String(key)) ? "open" : ""}><summary>${esc(title)} ${badgeFor(key)}
      <label class="chk nn inline" onclick="event.stopPropagation()"><input type="checkbox" data-tnn="${key}" ${nn ? "checked" : ""}> Not needed</label></summary>
    <div class="scroll"><table class="grid" data-t="${key}">
    <tr>${t.header.map((h, c) => `<th contenteditable data-r="-1" data-c="${c}">${esc(h)}</th>`).join("")}<th></th></tr>
    ${t.rows.map((r, ri) => `<tr>${r.map((v, c) => `<td contenteditable data-r="${ri}" data-c="${c}">${esc(v)}</td>`).join("")}<td class="del"><button class="secondary" data-del="${ri}" title="Delete row" aria-label="Delete row">×</button></td></tr>`).join("")}
    </table></div>
    <p class="gridbtns"><button class="secondary" data-add="1">+ Row</button> <button class="secondary" data-blank="1">Clear to blank template</button></p></details>`;
}
const openGrids = new Set();
function renderTables() {
  const keys = [...Array.from({ length: 10 }, (_, i) => i + 1), "reliability"];
  $("rtables").innerHTML = keys.map((k) => gridHtml(k, k === "reliability" ? "Data reliability (page 3)" : `Table ${k} — ${TABLE_NAMES[k]}`)).join("")
    + `<p class="muted">Every table a chosen page uses must be filled in or marked <b>Not needed</b> (not-needed tables are left out). Tables are numbered in the report in the order they appear.</p>`;
  $("rtables").querySelectorAll("details").forEach((d) => d.ontoggle = () => { d.open ? openGrids.add(d.dataset.k) : openGrids.delete(d.dataset.k); });
  $("rtables").querySelectorAll("table.grid").forEach((tbl) => {
    const key = tbl.dataset.t, t = tableOf(key);
    tbl.querySelectorAll("[contenteditable]").forEach((cell) => cell.oninput = () => {
      const r = +cell.dataset.r, c = +cell.dataset.c;
      if (r < 0) t.header[c] = cell.textContent; else t.rows[r][c] = cell.textContent;
      tbl.closest("details").querySelector(".badge").outerHTML = badgeFor(key);
      save(); renderPages(); refreshTexts(); fieldHints();
    });
    const box = tbl.closest("details");
    box.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => { t.rows.splice(+b.dataset.del, 1); save(); renderTables(); });
    box.querySelector("[data-tnn]").onchange = (e) => { if (e.target.checked) S.notNeeded.tables[key] = true; else delete S.notNeeded.tables[key]; save(); renderTables(); };
    box.querySelector("[data-add]").onclick = () => { t.rows.push(t.header.map(() => "")); save(); renderTables(); };
    box.querySelector("[data-blank]").onclick = () => {
      if (!confirm("Replace this table with the blank template?")) return;
      if (key === "reliability") S.reliability = blankTable("reliability"); else S.tables[key] = blankTable(+key);
      save(); renderTables();
    };
  });
  renderPages(); refreshTexts(); fieldHints();
}

// ---------------------------------------------------------------- step 4: pages
function renderPages() {
  if (!data) return;
  $("rpages").innerHTML = PAGES.map(([id, label]) => {
    const need = NEEDS[id] || {}, noLayer = need.g && !data.groups[need.g].length, noTables = need.t && !need.t.some((n) => !S.notNeeded.tables[n] && tableHasData(S.tables[n]));
    const note = noLayer ? "no matching layer in this map" : noTables ? "no table — blank or not needed" : id === "reliability" && !tableHasData(S.reliability) ? "accuracy table is blank" : "";
    return `<label class="chk"><input type="checkbox" data-p="${id}" ${S.include.includes(id) && !noLayer ? "checked" : ""} ${noLayer ? "disabled" : ""}> ${esc(label)}${note ? ` <span class="muted">(${note})</span>` : ""}</label>`;
  }).join("");
  $("rpages").querySelectorAll("input").forEach((c) => c.onchange = () => {
    S.include = [...$("rpages").querySelectorAll("input:checked")].map((x) => x.dataset.p); save(); updatePickerVisibility();
  });
}

// ---------------------------------------------------------------- step 5: detail spots
const SLOT_PAGE = { overview: "overviewMap", sidewalk: "sidewalkMap", crosswalk: "crosswalkDetails" };
const pickers = {};
function updatePickerVisibility() { for (const slot of Object.keys(INSETS)) { const el = $(`pick-${slot}`); if (el) el.hidden = !S.include.includes(SLOT_PAGE[slot]); } }
async function renderPickers() {
  const box = $("rpickers"); box.innerHTML = "";
  for (const slot of Object.keys(INSETS)) {
    if (!S.insets[slot]) S.insets[slot] = defaultInset(data, slot);
    const el = document.createElement("div"); el.className = "picker"; el.id = `pick-${slot}`;
    el.innerHTML = `<b>${esc(INSETS[slot].label)}</b>
      <p class="muted">Click or drag on the city map to jump there. Drag the preview to pan; scroll on either (or use the slider) to zoom.</p>
      <div class="pickrow"><div class="pickmap"><canvas></canvas></div>
      <div class="pickside"><canvas class="preview"></canvas>
        <label>Zoom <input type="range" min="0" max="1000" class="zoom"></label>
        ${slot === "crosswalk" ? `<div class="popupctl"></div>` : ""}
        <label class="small">Or use an image instead <input type="file" accept="image/*" class="upl"></label>
        <button class="secondary clear" hidden>Remove image</button></div></div>
      <figure class="example"><img src="report-assets/example-${slot}.jpg" alt="Example ${esc(INSETS[slot].label.toLowerCase())} from the Bangor 2026 report" loading="lazy">
        <figcaption>Example from the Bangor 2026 report</figcaption></figure>`;
    box.appendChild(el);
    pickers[slot] = { el, base: null };
    setupPicker(slot);
  }
  renderPopupControls();
  updatePickerVisibility();
  for (const slot of Object.keys(INSETS)) {
    const p = pickers[slot]; p.base = await renderPickerBase(deps(), data, slot, 1000);
    drawPicker(slot); preview(slot);
  }
}
// crosswalk popup: on/off + which fields it lists
function renderPopupControls() {
  const box = pickers.crosswalk && pickers.crosswalk.el.querySelector(".popupctl"); if (!box) return;
  const L = (data.groups.crosswalks || [])[0];
  if (!L) { box.innerHTML = ""; return; }
  const fields = popupFields(L), chosen = (S.popup && S.popup.fields) || defaultPopupFields(L);
  box.innerHTML = `<label class="chk"><input type="checkbox" class="popon" ${S.popupOn ? "checked" : ""}> Show a popup</label>
    <p class="muted small">${S.popup && S.popup.oid != null ? "Click another crosswalk in the preview to change it." : "Click a crosswalk in the preview to pick it."}</p>
    <details class="small" ${S.popupOn ? "" : "hidden"}><summary>Popup fields (${chosen.length})</summary>
    ${fields.map((f) => `<label class="chk"><input type="checkbox" data-pf="${esc(f.name)}" ${chosen.includes(f.name) ? "checked" : ""}> ${esc(f.label)}</label>`).join("")}</details>`;
  box.querySelector(".popon").onchange = (e) => { S.popupOn = e.target.checked; save(); renderPopupControls(); preview("crosswalk"); };
  box.querySelectorAll("[data-pf]").forEach((c) => c.onchange = () => {
    // keep the web map's field order
    const on = new Set([...box.querySelectorAll("[data-pf]:checked")].map((x) => x.dataset.pf));
    S.popup = { ...(S.popup || { oid: null }), fields: fields.map((f) => f.name).filter((n) => on.has(n)) };
    save(); box.querySelector("summary").textContent = `Popup fields (${on.size})`; preview("crosswalk");
  });
}
const ZMIN = Math.log(20), ZMAX = Math.log(6000);
const toSlider = (m) => Math.round(((Math.log(m) - ZMIN) / (ZMAX - ZMIN)) * 1000);
const fromSlider = (v) => Math.exp(ZMIN + (v / 1000) * (ZMAX - ZMIN));
function setupPicker(slot) {
  const p = pickers[slot], cv = p.el.querySelector(".pickmap canvas"), pv = p.el.querySelector(".preview"), zoom = p.el.querySelector(".zoom");
  zoom.value = toSlider(S.insets[slot].widthM);
  const settle = () => { clearTimeout(p.t); p.t = setTimeout(() => { save(); preview(slot); }, 250); };
  // city map: click / drag jumps the box there
  const move = (ev) => {
    const r = cv.getBoundingClientRect(), ext = data.ext;
    S.insets[slot].cx = ext.x0 + ((ev.clientX - r.left) / r.width) * (ext.x1 - ext.x0);
    S.insets[slot].cy = ext.y1 - ((ev.clientY - r.top) / r.height) * (ext.y1 - ext.y0);
    drawPicker(slot);
  };
  let down = false;
  cv.onpointerdown = (ev) => { down = true; cv.setPointerCapture(ev.pointerId); move(ev); };
  cv.onpointermove = (ev) => { if (down) move(ev); };
  cv.onpointerup = () => { down = false; save(); preview(slot); };
  const wheelZoom = (ev) => { ev.preventDefault(); zoom.value = Math.min(1000, Math.max(0, +zoom.value + (ev.deltaY > 0 ? 25 : -25))); zoom.oninput(); };
  cv.onwheel = wheelZoom; pv.onwheel = wheelZoom;
  zoom.oninput = () => { S.insets[slot].widthM = fromSlider(+zoom.value); drawPicker(slot); settle(); };
  // preview: drag pans (the picture slides along live), a click on the crosswalk preview picks the popup feature
  let drag = null;
  pv.onpointerdown = (ev) => {
    if (uploads[slot]) return;
    drag = { x: ev.clientX, y: ev.clientY, cx: S.insets[slot].cx, cy: S.insets[slot].cy, moved: false };
    pv.setPointerCapture(ev.pointerId);
  };
  pv.onpointermove = (ev) => {
    if (!drag) return;
    const r = pv.getBoundingClientRect(), e = insetExtent(data, slot, { ...S.insets[slot], cx: drag.cx, cy: drag.cy });
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    S.insets[slot].cx = drag.cx - (dx / r.width) * (e.x1 - e.x0);
    S.insets[slot].cy = drag.cy + (dy / r.height) * (e.y1 - e.y0);
    if (p.img) { const g = pv.getContext("2d"), k = pv.width / r.width; g.fillStyle = "#fff"; g.fillRect(0, 0, pv.width, pv.height); g.drawImage(p.img, dx * k, dy * k, pv.width, pv.height); }
    drawPicker(slot);
  };
  pv.onpointerup = (ev) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.moved) { save(); preview(slot); return; }
    if (slot !== "crosswalk" || !S.popupOn) return;
    const r = pv.getBoundingClientRect(), e = insetExtent(data, slot, S.insets[slot]);
    const x = e.x0 + ((ev.clientX - r.left) / r.width) * (e.x1 - e.x0), y = e.y1 - ((ev.clientY - r.top) / r.height) * (e.y1 - e.y0);
    const hit = featureAt(data, slot, x, y, (12 / r.width) * (e.x1 - e.x0));
    if (!hit) return;
    S.popup = { oid: hit.feature.attributes[hit.layer.oidField], fields: (S.popup && S.popup.fields) || defaultPopupFields(hit.layer) };
    save(); renderPopupControls(); preview(slot);
  };
  const upl = p.el.querySelector(".upl"), clear = p.el.querySelector(".clear");
  upl.onchange = async () => {
    const f = upl.files[0]; if (!f) return;
    const im = await ctx.loadImage(URL.createObjectURL(f)), [wPt, hPt] = SLOT_PT[slot];
    const W = Math.round((wPt / 72) * 300), H = Math.round((hPt / 72) * 300), c = ctx.createCanvas(W, H), g = c.getContext("2d");
    const s = Math.max(W / im.width, H / im.height);   // cover-fit, centred
    g.drawImage(im, (W - im.width * s) / 2, (H - im.height * s) / 2, im.width * s, im.height * s);
    uploads[slot] = { data: await ctx.blobBytes(c, "image/jpeg", 0.9), type: "JPEG", w: W, h: H };
    clear.hidden = false; preview(slot);
  };
  clear.onclick = () => { delete uploads[slot]; upl.value = ""; clear.hidden = true; preview(slot); };
}
function drawPicker(slot) {
  const p = pickers[slot], cv = p.el.querySelector(".pickmap canvas");
  if (!p.base) return;
  cv.width = p.base.width; cv.height = p.base.height;
  const g = cv.getContext("2d"); g.drawImage(p.base, 0, 0);
  const ext = data.ext, e = insetExtent(data, slot, S.insets[slot]);
  const X = (x) => ((x - ext.x0) / (ext.x1 - ext.x0)) * cv.width, Y = (y) => ((ext.y1 - y) / (ext.y1 - ext.y0)) * cv.height;
  const x0 = X(e.x0), y0 = Y(e.y1), w = X(e.x1) - x0, h = Y(e.y0) - y0;
  g.lineWidth = 3; g.strokeStyle = "#d62d20"; g.strokeRect(x0, y0, w, h);
  if (w < 14) { g.beginPath(); g.arc(x0 + w / 2, y0 + h / 2, 14, 0, 2 * Math.PI); g.stroke(); }
}
async function preview(slot) {
  const p = pickers[slot], cv = p.el.querySelector(".preview"), [wPt, hPt] = SLOT_PT[slot];
  const W = 720, H = Math.round((W * hPt) / wPt), token = (p.tok = (p.tok || 0) + 1);
  let src;
  try {
    if (uploads[slot]) src = await ctx.loadImage(URL.createObjectURL(new Blob([uploads[slot].data], { type: "image/jpeg" })));
    else {
      const pp = slot === "crosswalk" && S.popupOn && S.popup && S.popup.oid != null ? await loadPopup(deps(), data, slot, S.popup.oid, S.popup.fields || []) : null;
      src = await renderInset(deps(), data, slot, S.insets[slot], W, H, wPt / 72, pp);
    }
  } catch (e) { log(`Preview: ${e.message}`); return; }
  if (token !== p.tok) return;
  cv.width = W; cv.height = H; cv.getContext("2d").drawImage(src, 0, 0, W, H);
  cv.style.cursor = uploads[slot] ? "default" : "grab";
  p.img = src;
}

// ---------------------------------------------------------------- step 6: text
// Text boxes follow the details / tables automatically until someone types in one; then that box is
// "overridden" (kept as typed, highlighted) until they click "Back to automatic".
const TEXT_ITEMS = [["overview", "Overview page paragraph"], ["reliability", "Data reliability paragraph (follows the accuracy table)"], ["overviewMap", "Overview map paragraph (follows the map's layers)"]];
function renderTexts() {
  if (!S.textOverride) S.textOverride = {};
  if (!S.texts) S.texts = {};
  $("rtexts").innerHTML = TEXT_ITEMS.map(([k, label]) => `<div class="tbox" data-k="${k}">
      <label>${label} <span class="badge over" hidden>Override</span></label>
      <textarea data-k="${k}" rows="5"></textarea>
      <p class="muted small"><a href="#" class="auto" hidden>Back to automatic</a></p>
      <details class="small ex"><summary>Examples from the 2026 reports</summary>${(TEXT_EXAMPLES[k] || []).map(([who, s]) => `<p><b>${esc(who)}:</b> ${esc(s)}</p>`).join("")}</details>
    </div>`).join("");
  $("rtexts").querySelectorAll("textarea").forEach((ta) => ta.oninput = () => {
    const k = ta.dataset.k; S.textOverride[k] = true; S.texts[k] = ta.value; save(); showOverride(k);
  });
  $("rtexts").querySelectorAll("a.auto").forEach((a) => a.onclick = (e) => {
    e.preventDefault(); const k = a.closest(".tbox").dataset.k; delete S.textOverride[k]; save(); refreshTexts();
  });
  refreshTexts();
}
function showOverride(k) {
  const box = $("rtexts").querySelector(`.tbox[data-k="${k}"]`), on = !!S.textOverride[k];
  box.classList.toggle("overridden", on); box.querySelector(".over").hidden = !on; box.querySelector("a.auto").hidden = !on;
}
// recompute every non-overridden box from the current details, tables and layers
function refreshTexts() {
  if (!data || !$("rtexts").querySelector("textarea")) return;
  const d = defaultTexts(effectiveFields(), data, S.reliability);
  for (const [k] of TEXT_ITEMS) {
    if (!S.textOverride[k]) S.texts[k] = d[k];
    const ta = $("rtexts").querySelector(`textarea[data-k="${k}"]`);
    if (ta.value !== S.texts[k] && document.activeElement !== ta) ta.value = S.texts[k];
    showOverride(k);
  }
  save();
}
function effectiveFields() {
  const d = derivedNumbers(S.tables), f = { ...S.fields };
  for (const k of Object.keys(S.notNeeded.fields)) f[k] = "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f.date || "");
  if (iso) f.date = `${iso[2]}/${iso[3]}/${iso[1]}`;
  f.miles = d.miles; f.ramps = d.ramps;
  f.coverName = f.coverName || f.city;
  return f;
}

// ---------------------------------------------------------------- map icon sizes
// Same meaning as the Map PDFs tab (points on the full-size landscape map); the report shows those maps
// shrunk to about 60%. Starts from whatever was set for this map on the Map PDFs tab.
const iconKey = (title) => title.trim().toLowerCase();
function renderIcons() {
  const pts = data.layers.filter((l) => /Point/.test(l.geometryType || ""));
  if (!S.icons) {
    const fromMaps = local.get(`icons:${mapId}`) || {};
    S.icons = {};
    for (const l of pts) {
      const k = iconKey(l.title), d = DEFAULTS.iconOverrides[k] || {}, m = fromMaps[k] || {};
      S.icons[k] = { overview: m.overview !== undefined ? m.overview : d.overview_pt ?? null, solo: m.solo !== undefined ? m.solo : d.solo_pt ?? null };
    }
  }
  // layer order (top = drawn on top, first in the legend): saved, else the Map PDFs tab's, else the default stacking
  const keys = data.layers.map(layerKey), saved = S.order || local.get(`order:${mapId}`) || [];
  const rank = (k) => { const i = saved.indexOf(k); return i < 0 ? 1e9 : i; };
  const dflt = defaultOrder(data.layers).map(layerKey);
  S.order = dflt.map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i).map((o) => o.k).filter((k) => keys.includes(k));
  const byKey = Object.fromEntries(data.layers.map((l) => [layerKey(l), l])), n = S.order.length;
  $("ricons").innerHTML = `<table class="icons"><tr><th>Order</th><th>Layer</th><th>Overview map (pt)</th><th>Own map page (pt)</th></tr>
    ${S.order.map((key, i) => { const l = byKey[key], k = iconKey(l.title), v = S.icons[k] || {}, d = DEFAULTS.iconOverrides[k] || {};
      const inp = (kind) => `<input type="number" min="0.5" max="40" step="0.1" data-ik="${esc(k)}" data-kind="${kind}" value="${v[kind] ?? ""}" placeholder="auto${d[kind] && d[kind] !== 1 ? ` ×${d[kind]}` : ""}" aria-label="${esc(l.title)} ${kind} icon size">`;
      const pt = /Point/.test(l.geometryType || "");
      return `<tr><td class="mv"><button class="secondary" data-mv="${i}" data-d="-1" ${i ? "" : "disabled"} aria-label="Move ${esc(l.title)} up">▲</button><button class="secondary" data-mv="${i}" data-d="1" ${i < n - 1 ? "" : "disabled"} aria-label="Move ${esc(l.title)} down">▼</button></td>
        <td>${esc(l.title)}</td>${pt ? `<td>${inp("overview")}</td><td>${inp("solo")}</td>` : '<td class="muted">—</td><td class="muted">—</td>'}</tr>`; }).join("")}</table>
    <p class="muted small">Top of the list is drawn on top and comes first in the legend. <a href="#" id="riconreset">Reset order and sizes</a></p>`;
  $("ricons").querySelectorAll("input").forEach((i) => i.oninput = () => {
    const v = parseFloat(i.value); (S.icons[i.dataset.ik] ||= {})[i.dataset.kind] = v > 0 ? v : null;
    applyMapLook();
  });
  $("ricons").querySelectorAll("[data-mv]").forEach((b) => b.onclick = () => {
    const i = +b.dataset.mv, j = i + +b.dataset.d; [S.order[i], S.order[j]] = [S.order[j], S.order[i]];
    renderIcons(); applyMapLook();
    $("ricons").querySelector(`[data-mv="${j}"][data-d="${b.dataset.d}"]`)?.focus();
  });
  $("riconreset").onclick = (e) => { e.preventDefault(); S.icons = null; S.order = dflt; renderIcons(); applyMapLook(); };
  data.iconOverrides = iconOverrides(); data.layerOrder = S.order;
}
function applyMapLook() {
  data.iconOverrides = iconOverrides(); data.layerOrder = S.order; save();
  clearTimeout(renderIcons.t); renderIcons.t = setTimeout(refreshPickerImages, 600);
}
function iconOverrides() {
  const out = {};
  for (const [k, v] of Object.entries(S.icons || {})) {
    const o = { ...(DEFAULTS.iconOverrides[k] || {}) };
    for (const kind of ["overview", "solo"]) { if (v[kind]) o[`${kind}_pt`] = v[kind]; else delete o[`${kind}_pt`]; }
    out[k] = o;
  }
  return out;
}
async function refreshPickerImages() {
  for (const slot of Object.keys(INSETS)) {
    const p = pickers[slot]; if (!p) continue;
    p.base = await renderPickerBase(deps(), data, slot, 1000); drawPicker(slot); preview(slot);
  }
}

// ---------------------------------------------------------------- restored inputs + checklist
function showRestored(at) {
  const b = $("rrestored");
  if (!at) { b.hidden = true; return; }
  b.hidden = false;
  b.querySelector("span").innerHTML = `<b>Some fields are autofilled</b> from your last visit (${esc(new Date(at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }))}). Check them before downloading, or`;
}
async function startFresh() {
  if (!confirm("Clear every input for this map (details, tables, pages, detail views, text) and start over?")) return;
  try { localStorage.removeItem(`report:${mapId}`); } catch {}
  S = blankState(); for (let n = 1; n <= 10; n++) S.tables[n] = blankTable(n);
  S.fields.shortName = $("rmap").selectedOptions[0]?.textContent.replace(/\s*Results Map\s*$/i, "").trim() || "";
  for (const k of Object.keys(uploads)) delete uploads[k];
  showRestored(null);
  renderFields(); renderTables(); renderPages(); renderIcons(); renderTexts(); await renderPickers(); save();
}
// what still needs attention: details fields, and every table a chosen page uses
function problems() {
  if (!S || !data) return [];
  const out = [];
  for (const [k, label] of FIELD_LABELS) if (!fieldDone(k)) out.push([`fld-${k}`, `Details: ${label}`]);
  const need = new Set();
  for (const id of S.include) for (const n of (NEEDS[id] || {}).t || []) need.add(n);
  if (S.include.includes("reliability")) need.add("reliability");
  for (const k of [...need].sort((a, b) => (a === "reliability") - (b === "reliability") || a - b)) {
    const st = tableStatus(k);
    if (st.s === "blank" || st.s === "partial") out.push([`tbl-${k}`, `${k === "reliability" ? "Data reliability table" : `Table ${k} (${TABLE_NAMES[k]})`}: ${st.s === "blank" ? "blank" : st.label}`]);
  }
  if (!S.include.length) out.push(["rpages", "Pages: none selected"]);
  return out;
}
function updateChecklist() {
  const box = $("rcheck"); if (!box) return;
  const p = problems();
  const dl = $("rdl"); if (dl) { dl.classList.toggle("disabled", p.length > 0); dl.title = p.length ? "Finish the checklist (step 8) before downloading" : ""; }
  box.innerHTML = p.length
    ? `<p class="warn"><b>${p.length} item${p.length === 1 ? "" : "s"}</b> still need to be filled in or marked <b>Not needed</b>:</p><ul>${p.map(([id, s]) => `<li><a href="#" data-go="${id}">${esc(s)}</a></li>`).join("")}</ul>`
    : `<p class="ok">Everything is filled in or marked not needed.</p>`;
  box.querySelectorAll("[data-go]").forEach((a) => a.onclick = (e) => {
    e.preventDefault(); const el = $(a.dataset.go); if (!el) return;
    if (el.tagName === "DETAILS") el.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "center" }); el.querySelector("input:not([type=checkbox]),[contenteditable]")?.focus({ preventScroll: true });
  });
}

// ---------------------------------------------------------------- generate
// ---------------------------------------------------------------- preview (right-hand pane, live)
// Every change re-assembles the PDF (maps/insets are cached, so this takes a moment) and re-draws it
// with pdf.js, keeping the scroll position. Download needs the checklist to be complete.
let lastUrl = null, building = false, pending = false, liveTimer = null, pdfjsReady = null;
function loadPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; res(window.pdfjsLib); };
    s.onerror = () => { pdfjsReady = null; rej(new Error("Couldn't load the PDF viewer.")); };
    document.head.appendChild(s);
  });
  return pdfjsReady;
}
let lastPdf = null, sideStale = false;   // latest build, redrawn if the pane was closed while it arrived
function showSide(on) {
  $("rpreview").hidden = !on; $("rsplit").classList.toggle("has-preview", on);
  if (on && sideStale && lastPdf) { sideStale = false; showPdf(lastPdf.bytes.slice()); }
}
const pstatus = (s) => { $("rpstatus").textContent = s; };
function scheduleLive() {
  if (!S || !data || !S.live || $("rpreview").hidden) return;
  clearTimeout(liveTimer); liveTimer = setTimeout(() => build(), 900);
}
async function build() {
  if (building) { pending = true; return; }
  building = true; pending = false;
  showSide(true);
  pstatus("Updating…");
  try {
    const d = { ...deps(), reportFonts: await reportFonts(), assets: await assets() };
    const tables = {};
    for (let n = 1; n <= 10; n++) if (!S.notNeeded.tables[n]) tables[n] = S.tables[n];
    if (!S.notNeeded.tables.reliability) tables.reliability = S.reliability;
    const popup = S.popupOn && S.popup && S.popup.oid != null ? S.popup : null;
    const pdf = await buildFullReport(d, data, { fields: effectiveFields(), tables, include: S.include, insets: S.insets, uploads, texts: S.texts, popup, iconOverrides: iconOverrides(), layerOrder: S.order },
      (s) => pstatus(`Updating… ${s}`));
    const bytes = new Uint8Array(pdf);
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const name = `${(S.fields.coverName || S.fields.city || data.title).replace(/[^A-Za-z0-9_-]+/g, "_")}_PROW_Evaluation_Report_${S.fields.year || ""}.pdf`;
    $("rdl").href = lastUrl; $("rdl").download = name; $("rdl").textContent = `Download PDF (${(bytes.length / 1048576).toFixed(1)} MB)`;
    if ($("rpreview").hidden) sideStale = true; else await showPdf(bytes.slice());
    const done = `Up to date · ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
    pstatus(done);
    lastPdf = { bytes };
  } catch (e) { pstatus(`Error: ${e.message}`); log(`Error: ${e.message}`); }
  building = false;
  updateChecklist();
  if (pending) build();
}
async function showPdf(bytes) {
  const lib = await loadPdfJs(), view = $("rview");
  const doc = await lib.getDocument({ data: bytes }).promise;
  const width = Math.max(200, view.clientWidth - 24), dpr = Math.min(window.devicePixelRatio || 1, 2), frag = document.createDocumentFragment();
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i), v1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: (width * dpr) / v1.width });
    const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height; c.className = "ppage";
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    frag.appendChild(c);
  }
  const ratio = view.scrollHeight ? view.scrollTop / view.scrollHeight : 0;
  view.innerHTML = ""; view.appendChild(frag);
  view.scrollTop = ratio * view.scrollHeight;   // stay on the same page
  doc.destroy();
}

// ---------------------------------------------------------------- init
export function initReportTab(c) {
  ctx = c;
  $("rload").onclick = loadData;
  $("rfind").onclick = () => ctx.searchMaps($("rsearch").value.trim()).catch((e) => log(`Error: ${e.message}`));
  $("rsearch").onkeydown = (e) => { if (e.key === "Enter") $("rfind").click(); };
  $("rfiles").onchange = async () => {
    if (!S) return;
    const n = await readTableFiles([...$("rfiles").files]);
    log(`Read ${n} table${n === 1 ? "" : "s"}.`); save(); renderTables();
    $("rfiles").value = "";
  };
  $("rgo").onclick = () => { showSide(true); build(); };
  $("rlive").onchange = (e) => { S.live = e.target.checked; save(); if (S.live) build(); };
  $("rdl").onclick = (e) => { if ($("rdl").classList.contains("disabled") || !lastUrl) { e.preventDefault(); updateChecklist(); $("rcheck").scrollIntoView({ behavior: "smooth", block: "center" }); } };
  $("rclose").onclick = () => showSide(false);

  $("rfresh").onclick = startFresh;
}
// called whenever the map list is refreshed
export function setReportMaps(items) {
  const sel = $("rmap");
  sel.innerHTML = items.length ? items.map((i) => `<option value="${i.id}">${esc(i.title)}</option>`).join("") : "<option value=''>No maps found</option>";
  $("rload").disabled = !items.length;
}
