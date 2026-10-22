// "Completeness" tab: for every layer of a results map, how much of the deliverable data is present
// (DCS score, PROWAG compliant, photo attachments), plus a "Certificate of Completeness" PDF and a CSV
// of the features that are missing something. Checks follow the Esri QA script (esri_qa.py), reported
// the other way round: 2% missing DCS scores reads as "98% DCS scores reported".
//
// Core functions are environment-agnostic (deps: fetchJson, jsPDF, reportFonts, assets) for Node testing.

import { resolveLayers } from "./renderer.js?v=20261022132246";

export const CHECKS = [
  { key: "dcs", label: "DCS scores reported", field: /^DCS_SCORE$/i },
  { key: "prowag", label: "PROWAG compliance reported", field: /^PROWAG_COMPLIANT$/i },
  { key: "images", label: "Images attached" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(deps, url, params) {
  for (let i = 0; i < 4; i++) {
    const r = await deps.fetchJson(url, params);
    if (!r.error) return r;
    if (i === 3) throw new Error(r.error.message || "ArcGIS error");
    await sleep(1500 * (i + 1));
  }
}
async function pool(items, n, fn) {
  const queue = items.slice(), out = [];
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) { const it = queue.shift(); out.push(await fn(it)); } }));
  return out;
}

// Runs the checks. Returns { title, checkedAt, layers: [{ title, total, checks: { key: { applies, present, missing: [oid] } }, oidField, keyField }] }
export async function checkMap(deps, sharing, webmapId, onStatus = () => {}) {
  onStatus("Reading the web map…");
  const { title, layers } = await resolveLayers(deps, sharing, webmapId);
  const out = [];
  for (const L of layers) {
    onStatus(`${L.title}: counting…`);
    const oids = (await api(deps, `${L.url}/query`, { where: "1=1", returnIdsOnly: "true" })).objectIds || [];
    const total = oids.length;
    const keyField = (L.fields.find((f) => /^ticket_key$/i.test(f.name)) || {}).name || null;
    const row = { title: L.title, url: L.url, total, oidField: L.oidField, keyField, checks: {} };
    for (const c of CHECKS) {
      if (c.key === "images") {
        if (!L.hasAttachments) { row.checks.images = { applies: false }; continue; }
        const withPhotos = new Set(), batches = [];
        for (let i = 0; i < oids.length; i += 500) batches.push(oids.slice(i, i + 500));
        let done = 0;
        await pool(batches, 4, async (b) => {
          const r = await api(deps, `${L.url}/queryAttachments`, { objectIds: b.join(","), returnMetadata: "false" });
          for (const g of r.attachmentGroups || []) if ((g.attachmentInfos || []).length) withPhotos.add(g.parentObjectId);
          done += b.length; onStatus(`${L.title}: checking images ${done.toLocaleString()} / ${total.toLocaleString()}`, true);
        });
        const missing = oids.filter((o) => !withPhotos.has(o));
        row.checks.images = { applies: true, present: total - missing.length, missing };
        continue;
      }
      // only check what the client is shown: a field hidden from the web map's popup is not part of the deliverable
      const f = L.fields.find((x) => c.field.test(x.name));
      const popup = ((L.popupInfo || {}).fieldInfos || []);
      const shown = !popup.length || popup.some((p) => p.visible !== false && c.field.test(p.fieldName));
      if (!f || !shown) { row.checks[c.key] = { applies: false, hidden: !!f && !shown }; continue; }
      const where = f.type === "esriFieldTypeString" ? `${f.name} IS NULL OR ${f.name} = ''` : `${f.name} IS NULL`;
      const missing = (await api(deps, `${L.url}/query`, { where, returnIdsOnly: "true" })).objectIds || [];
      row.checks[c.key] = { applies: true, present: total - missing.length, missing, field: f.name };
    }
    onStatus(`${L.title}: ${total.toLocaleString()} features checked`);
    out.push(row);
  }
  return { title, checkedAt: new Date(), layers: out };
}

// never round up to 100% while anything is missing
export function pct(present, total) {
  if (!total) return null;
  const p = Math.floor((present / total) * 1000) / 10;
  return present < total ? Math.min(p, 99.9) : 100;
}
const fmtPct = (p) => (p === null ? "—" : `${p.toFixed(1)}%`);

// features with nothing missing on any check that applies to them (a feature missing two things counts once)
export function completeCount(L) {
  const bad = new Set();
  for (const c of CHECKS) { const k = L.checks[c.key]; if (k && k.applies) for (const o of k.missing) bad.add(o); }
  return L.total - bad.size;
}
export const COMPLETE_LABEL = "Features fully complete";

export function summary(res) {
  const s = {};
  let cp = 0, ct = 0;
  for (const L of res.layers) { cp += completeCount(L); ct += L.total; }
  s.complete = { present: cp, total: ct, pct: pct(cp, ct) };
  for (const c of CHECKS) {
    let present = 0, total = 0;
    for (const L of res.layers) { const k = L.checks[c.key]; if (k && k.applies) { present += k.present; total += L.total; } }
    s[c.key] = { present, total, pct: pct(present, total) };
  }
  return s;
}

// keys for the missing-items CSV
export async function missingRows(deps, res, onStatus = () => {}) {
  const rows = [];
  for (const L of res.layers) {
    const want = new Map();
    for (const c of CHECKS) { const k = L.checks[c.key]; if (k && k.applies) for (const o of k.missing) (want.get(o) || want.set(o, []).get(o)).push(c.label.replace(/ reported| attached/, "")); }
    if (!want.size) continue;
    const keys = new Map(), ids = [...want.keys()];
    if (L.keyField) {
      for (let i = 0; i < ids.length; i += 500) {
        const r = await api(deps, `${L.url}/query`, { objectIds: ids.slice(i, i + 500).join(","), outFields: `${L.oidField},${L.keyField}`, returnGeometry: "false" });
        for (const f of r.features || []) keys.set(f.attributes[L.oidField], f.attributes[L.keyField]);
        onStatus(`Missing list: ${L.title} ${Math.min(i + 500, ids.length).toLocaleString()} / ${ids.length.toLocaleString()}`, true);
      }
    }
    for (const [oid, what] of want) rows.push([L.title, oid, keys.get(oid) ?? "", what.join("; ")]);
  }
  return rows;
}
export const toCsv = (rows) => [["Layer", "OBJECTID", "Ticket key", "Missing"], ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");

// ---------------------------------------------------------------- certificate PDF
const NAVY = [34, 57, 65], TEAL = [68, 114, 129], HEAD = [38, 41, 46], BODY = [84, 85, 87], STRIPE = [211, 217, 109], TINT = [244, 250, 250];
// values below `threshold` are "flagged"; a layer with a note gets a reference number on its flagged
// values (or its name, if nothing is flagged) and the note is printed as a numbered footnote
export const layerValues = (L) => [...["dcs", "prowag", "images"].map((k) => (L.checks[k] && L.checks[k].applies ? pct(L.checks[k].present, L.total) : null)), pct(completeCount(L), L.total)];
export const isFlagged = (L, threshold) => L.total > 0 && layerValues(L).some((v) => v !== null && v < threshold);

export function buildCertificate(deps, res, { client, issuedBy = "Daxbot", date, notes = {}, threshold = 95 } = {}) {
  const doc = new deps.jsPDF({ orientation: "portrait", unit: "pt", format: "letter", compress: true });
  const F = deps.reportFonts;
  for (const [n, b] of [["MontB", F.montB], ["MontSB", F.montSB], ["PopL", F.popL], ["Pop", F.pop], ["PopM", F.popM], ["PopSB", F.popSB]]) { doc.addFileToVFS(`${n}.ttf`, b); doc.addFont(`${n}.ttf`, n, "normal"); }
  const T = (s, x, y, font, size, color, o = {}) => { doc.setFont(font, "normal"); doc.setFontSize(size); doc.setTextColor(...color); doc.text(String(s), x, y, { baseline: "alphabetic", ...o }); };
  const W = 612, H = 792, M = 54, s = summary(res);
  const issued = date || new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  doc.setFillColor(255, 255, 255); doc.rect(0, 0, W, H, "F");
  // header band
  doc.setFillColor(...NAVY); doc.rect(0, 0, W, 150, "F");
  doc.setFillColor(...STRIPE); doc.rect(0, 150, W, 8, "F");
  const logo = deps.assets.logo; doc.addImage(logo.data, logo.type, M, 38, 110, (110 * logo.h) / logo.w, undefined, "FAST");
  T("CERTIFICATE OF", W - M, 72, "MontSB", 13, [255, 255, 255], { align: "right" });
  T("Data Completeness", W - M, 104, "MontB", 30, [255, 255, 255], { align: "right" });
  // statement
  let y = 205;
  T("Public Rights-of-Way Evaluation", M, y, "MontSB", 13, TEAL); y += 30;
  T(client || res.title, M, y, "MontB", 24, HEAD); y += 30;
  const sentence = `This certifies the completeness of the evaluation data delivered in "${res.title}" as of ${res.checkedAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}. Every feature in every layer was checked for a Dax Compliance Score (DCS), a PROWAG compliance determination, and an attached image.`;
  doc.setFont("Pop", "normal"); doc.setFontSize(11); doc.setTextColor(...BODY);
  const lines = doc.splitTextToSize(sentence, W - 2 * M); doc.text(lines, M, y, { baseline: "alphabetic", lineHeightFactor: 1.45 }); y += lines.length * 16 + 22;
  // headline figures
  const SHORT = { dcs: "DCS scores reported", prowag: "PROWAG reported", images: "Images attached" };
  const boxes = [["Fully complete", s.complete], ...CHECKS.map((c) => [SHORT[c.key], s[c.key]])], bw = (W - 2 * M - 36) / 4;
  boxes.forEach(([label, v], i) => {
    const x = M + i * (bw + 12);
    if (i === 0) { doc.setFillColor(...NAVY); doc.setDrawColor(...NAVY); } else { doc.setFillColor(...TINT); doc.setDrawColor(...TEAL); }
    doc.setLineWidth(0.8); doc.roundedRect(x, y, bw, 78, 6, 6, "FD");
    const fg = i === 0 ? [255, 255, 255] : NAVY, sub = i === 0 ? [220, 232, 236] : BODY;
    T(fmtPct(v.pct), x + bw / 2, y + 38, "MontB", 22, fg, { align: "center" });
    T(label, x + bw / 2, y + 56, "PopM", 8.5, sub, { align: "center" });
    T(v.total ? `${v.present.toLocaleString()} of ${v.total.toLocaleString()}` : "not applicable", x + bw / 2, y + 71, "PopL", 7, sub, { align: "center" });
  });
  y += 104;
  // per-layer table
  const cw = [168, 68, 67, 67, 67, W - 2 * M - 168 - 68 - 67 * 3], cols = cw.reduce((a, w) => (a.push(a[a.length - 1] + w), a), [M]).slice(0, 6);
  const head = ["Layer", "Features", "DCS", "PROWAG", "Images", "Complete"];
  doc.setFillColor(...NAVY); doc.rect(M, y, W - 2 * M, 24, "F");
  head.forEach((h, i) => T(h, i ? cols[i] + cw[i] / 2 : cols[0] + 8, y + 16, "MontSB", 9.5, [255, 255, 255], i ? { align: "center" } : {}));
  y += 24;
  // every layer gets a row; rows (and footnotes) shrink to fit the space above the method note, so it's always one page
  const rowsL = res.layers.filter((L) => L.total > 0);   // empty layers have nothing to certify
  const noted = rowsL.filter((L) => String(notes[L.title] || "").trim()), ref = new Map(noted.map((L, i) => [L, i + 1]));
  const fy = H - 132;
  let fnSize = 8, fnLines;
  const measure = () => { doc.setFont("PopL", "normal"); doc.setFontSize(fnSize); fnLines = noted.map((L) => doc.splitTextToSize(`${ref.get(L)}   ${L.title}: ${String(notes[L.title]).trim()}`, W - 2 * M)); return fnLines.reduce((a, l) => a + l.length, 0) * fnSize * 1.35 + (noted.length ? 16 : 0); };
  let fnH = measure();
  while (fnH > 150 && fnSize > 6) { fnSize -= 0.5; fnH = measure(); }
  const rowH = Math.max(11, Math.min(21, (fy - 18 - fnH - y) / Math.max(rowsL.length, 1)));
  rowsL.forEach((L, r) => {
    if (r % 2) { doc.setFillColor(...TINT); doc.rect(M, y, W - 2 * M, rowH, "F"); }
    const ty = y + rowH / 2 + 3.2, fs = rowH < 15 ? 7.5 : rowH < 17 ? 8 : 9, n = ref.get(L), vals = layerValues(L);
    const sup = (txt, cx, font, centered) => { if (!n) return; doc.setFont(font, "normal"); doc.setFontSize(fs); const w = doc.getTextWidth(txt); T(String(n), (centered ? cx + w / 2 : cx + w) + 1.2, ty - fs * 0.38, "PopSB", fs * 0.68, TEAL); };
    const name = L.title.length > 30 ? `${L.title.slice(0, 29)}…` : L.title, anyFlag = vals.some((v) => v !== null && v < threshold);
    T(name, cols[0] + 8, ty, "Pop", fs, BODY); if (!anyFlag) sup(name, cols[0] + 8, "Pop", false);
    T(L.total.toLocaleString(), cols[1] + cw[1] / 2, ty, "PopM", fs, BODY, { align: "center" });
    vals.forEach((v, i) => {
      const txt = v === null ? "—" : fmtPct(v), cx = cols[i + 2] + cw[i + 2] / 2, font = i === 3 ? "PopSB" : "PopM";
      T(txt, cx, ty, font, fs, i === 3 ? NAVY : BODY, { align: "center" });
      if (v !== null && v < threshold) sup(txt, cx, font, true);
    });
    y += rowH;
  });
  doc.setDrawColor(...TEAL); doc.setLineWidth(0.6); doc.line(M, y, W - M, y);
  // footnotes
  if (noted.length) {
    y += 14; doc.setFont("PopL", "normal"); doc.setFontSize(fnSize); doc.setTextColor(...BODY);
    fnLines.forEach((ls) => { doc.text(ls, M, y, { baseline: "alphabetic", lineHeightFactor: 1.35 }); y += ls.length * fnSize * 1.35; });
  }
  // footer: method + signature
  T("Method", M, fy, "MontSB", 9.5, HEAD);
  doc.setFont("PopL", "normal"); doc.setFontSize(8); doc.setTextColor(...BODY);
  doc.text(doc.splitTextToSize("Percentages are features with a value present divided by all features in the layer, checked directly against the ArcGIS feature services. \"Fully complete\" counts features missing nothing that applies to them; a feature missing two things counts once. A dash means the check does not apply. Figures are rounded down, so 100% means nothing is missing.", 300), M, fy + 14, { lineHeightFactor: 1.4 });
  doc.setDrawColor(...HEAD); doc.setLineWidth(0.6); doc.line(W - M - 190, fy + 30, W - M, fy + 30);
  T(issuedBy, W - M - 190, fy + 44, "PopM", 9, HEAD);
  T(`Issued ${issued}`, W - M - 190, fy + 57, "PopL", 8, BODY);
  doc.setFillColor(...TEAL); doc.rect(0, H - 48, W, 48, "F");
  T("Public Rights-of-Way Evaluation Data", M, H - 20, "PopL", 8, [255, 255, 255]);
  T("Find out more at", 397.9, H - 20, "PopL", 8, [255, 255, 255]); T("DAXBOT.COM", 475.6, H - 20, "PopSB", 8, [255, 255, 255]);
  const mark = deps.assets.mark; doc.addImage(mark.data, mark.type, 543, H - 33, 29, (29 * mark.h) / mark.w, undefined, "FAST");
  return doc.output("arraybuffer");
}

// ---------------------------------------------------------------- browser tab
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let ctx = null, last = null, lastId = null, fontCache = null, assetCache = null;
const store = { get: (k) => { try { return JSON.parse(localStorage.getItem(k)) || null; } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
let notes = {};
const threshold = () => { const v = parseFloat($("cthresh").value); return v > 0 && v <= 100 ? v : 95; };
async function certDeps() {
  if (!fontCache) {
    const get = async (f) => { const b = new Uint8Array(await (await fetch(`fonts/${f}`)).arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
    fontCache = { montB: await get("montserrat-700.ttf"), montSB: await get("montserrat-600.ttf"), popL: await get("poppins-300.ttf"), pop: await get("poppins-400.ttf"), popM: await get("poppins-500.ttf"), popSB: await get("poppins-600.ttf") };
  }
  if (!assetCache) {
    const one = async (f) => { const data = new Uint8Array(await (await fetch(`report-assets/${f}`)).arrayBuffer()); const im = await ctx.loadImage(URL.createObjectURL(new Blob([data]))); return { data, type: "PNG", w: im.width, h: im.height }; };
    assetCache = { logo: await one("logo.png"), mark: await one("mark.png") };
  }
  return { jsPDF: window.jspdf.jsPDF, reportFonts: fontCache, assets: assetCache, fetchJson: ctx.fetchJson };
}
function log(msg, progress) {
  const el = $("clog");
  if (progress && el.lastChild && el.lastChild.dataset.progress) el.lastChild.textContent = msg;
  else { const d = document.createElement("div"); d.textContent = msg; if (progress) d.dataset.progress = "1"; el.appendChild(d); }
  el.scrollTop = el.scrollHeight;
}
// ---- live certificate preview (right-hand pane): rebuilt a moment after any edit, drawn with pdf.js
let pdfjsReady = null, prevTimer = null, drawing = false, again = false;
function loadPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((res, rej) => {
    if (window.pdfjsLib) { res(window.pdfjsLib); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; res(window.pdfjsLib); };
    s.onerror = () => { pdfjsReady = null; rej(new Error("Couldn't load the PDF viewer.")); };
    document.head.appendChild(s);
  });
  return pdfjsReady;
}
const certOpts = () => ({ client: $("cclient").value.trim(), issuedBy: $("cissuer").value.trim() || "Daxbot", notes, threshold: threshold() });
const schedulePreview = () => { if (!last || !$("clive").checked || $("cpreview").hidden) return; clearTimeout(prevTimer); prevTimer = setTimeout(previewCert, 400); };
function showCertPane(on) { $("cpreview").hidden = !on; $("csplit").classList.toggle("has-preview", on); }
async function previewCert() {
  if (!last) return;
  if (drawing) { again = true; return; }
  drawing = true;
  try {
    const bytes = new Uint8Array(buildCertificate(await certDeps(), last, certOpts()));
    const lib = await loadPdfJs(), view = $("cview"), doc = await lib.getDocument({ data: bytes }).promise, page = await doc.getPage(1);
    const width = Math.max(200, view.clientWidth - 24), dpr = Math.min(window.devicePixelRatio || 1, 2), v1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: (width * dpr) / v1.width });
    const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height; c.className = "ppage";
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    view.innerHTML = ""; view.appendChild(c); doc.destroy();
    $("cdl").classList.remove("disabled");
    $("cpstatus").textContent = `Up to date · ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
  } catch (e) { $("cpstatus").textContent = `Preview error: ${e.message}`; }
  drawing = false;
  if (again) { again = false; previewCert(); }
}
const download = (blob, name) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); };
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, "_");

function renderResults() {
  const s = summary(last), cell = (c, total) => (c && c.applies ? `${fmtPct(pct(c.present, total))}<span class="muted small"> · ${(total - c.present).toLocaleString()} missing</span>` : '<span class="muted">—</span>');
  const big = [["complete", COMPLETE_LABEL, true], ...CHECKS.map((c) => [c.key, c.label, false])];
  $("cresults").innerHTML = `<div class="cbig">${big.map(([k, label, main]) => `<div class="${main ? "main" : ""}"><b>${fmtPct(s[k].pct)}</b><span>${label}</span><span class="muted small">${s[k].total ? `${s[k].present.toLocaleString()} of ${s[k].total.toLocaleString()}` : "not applicable"}</span></div>`).join("")}</div>
    <div class="scroll"><table class="grid ctable"><tr><th>Layer</th><th>Features</th>${CHECKS.map((c) => `<th>${c.label}</th>`).join("")}<th>${COMPLETE_LABEL}</th></tr>
    ${last.layers.map((L) => { const cc = completeCount(L); return `<tr><td>${esc(L.title)}</td><td>${L.total.toLocaleString()}</td>${CHECKS.map((c) => `<td>${cell(L.checks[c.key], L.total)}</td>`).join("")}<td><b>${fmtPct(pct(cc, L.total))}</b><span class="muted small"> · ${(L.total - cc).toLocaleString()} incomplete</span></td></tr>`; }).join("")}</table></div>
    <div id="cnotes"></div>
    <p class="muted small">Checked ${last.checkedAt.toLocaleString("en-US")}. Rounded down, so 100% means nothing is missing. A dash means the check doesn't apply: the layer has no such field, the field is hidden in the map's popup (not part of what the client gets), or the layer doesn't store images.</p>`;
  $("cactions").hidden = false;
  renderNotes();
}
// a note box for every layer with a value under the threshold (plus any layer that already has a note)
function renderNotes() {
  const th = threshold(), rows = last.layers.filter((L) => L.total > 0 && (isFlagged(L, th) || String(notes[L.title] || "").trim()));
  let n = 0;
  $("cnotes").innerHTML = `<div class="cnotes"><label>Notes for the certificate <span class="muted small">— layers under <input id="cthresh2" type="number" min="1" max="100" step="0.5" value="${th}" aria-label="Flag threshold"> %</span></label>
    ${rows.length ? rows.map((L) => { const has = String(notes[L.title] || "").trim(); if (has) n++;
      const low = layerValues(L).map((v, i) => (v !== null && v < th ? `${["DCS", "PROWAG", "images", "complete"][i]} ${fmtPct(v)}` : null)).filter(Boolean).join(", ");
      return `<div class="cnote ${has ? "on" : ""}"><span class="cref">${has ? n : "—"}</span><div><b>${esc(L.title)}</b> <span class="muted small">${low || "no values under the threshold"}</span>
        <textarea data-l="${esc(L.title)}" rows="2" placeholder="Explain the gap — e.g. 13 stops had no sidewalk photo within 10 m and are scheduled for recollection">${esc(notes[L.title] || "")}</textarea></div></div>`; }).join("")
      : '<p class="muted small">Every layer is at or above the threshold — no notes needed.</p>'}
    <p class="muted small">A note puts a reference number next to that layer's flagged values on the certificate and prints the explanation as a footnote. Leave a box empty for no footnote.</p></div>`;
  $("cnotes").querySelectorAll("textarea").forEach((ta) => ta.oninput = () => {
    notes[ta.dataset.l] = ta.value; store.set(`cnotes:${lastId}`, notes);
    // renumber without redrawing (keeps the cursor in the box)
    let k = 0; $("cnotes").querySelectorAll(".cnote").forEach((d) => { const on = !!d.querySelector("textarea").value.trim(); d.classList.toggle("on", on); d.querySelector(".cref").textContent = on ? ++k : "—"; });
    schedulePreview();
  });
  $("cthresh2").onchange = () => { $("cthresh").value = $("cthresh2").value; store.set("cthresh", threshold()); renderNotes(); schedulePreview(); };
}
let crunning = null;
async function run() {
  const id = $("cmap").value; if (!id) return;
  crunning = id; const prevId = lastId;
  $("crun").disabled = true; $("crun").classList.add("busy"); $("clog").innerHTML = ""; $("cresults").innerHTML = ""; $("cactions").hidden = true; $("csteps").hidden = true;
  $("cdl").classList.add("disabled"); $("cview").innerHTML = '<p class="pempty busy">Checking the map…</p>'; $("cpstatus").textContent = "Preview"; showCertPane(true); loadPdfJs().catch(() => {});
  try {
    last = await checkMap({ fetchJson: ctx.fetchJson }, ctx.SHARING, id, log);
    lastId = id; notes = store.get(`cnotes:${id}`) || {};
    if (!$("cclient").value.trim() || prevId !== id) $("cclient").value = last.title.replace(/\s*Results Map\s*$/i, "").trim();
    log("Done."); $("csteps").hidden = false; renderResults(); if ($("clive").checked) previewCert(); else $("cview").innerHTML = '<p class="pempty">Live preview is off — tick <b>Live</b> to show the certificate.</p>';
  } catch (e) { log(`Error: ${e.message}`); }
  $("crun").disabled = false; $("crun").classList.remove("busy");
  crunning = null;
  if (lastId === id) window.dispatchEvent(new CustomEvent("prow:map-loaded", { detail: { id, source: "complete" } }));
}
export function initCompletenessTab(c) {
  ctx = c;
  window.addEventListener("prow:map-loaded", (e) => {
    const { id, source } = e.detail;
    if (source === "complete" || lastId === id || crunning === id) return;
    if (![...$("cmap").options].some((o) => o.value === id)) return;
    $("cmap").value = id; run();
  });
  $("cfind").onclick = () => ctx.searchMaps($("csearch").value.trim()).catch((e) => log(`Error: ${e.message}`));
  $("csearch").onkeydown = (e) => { if (e.key === "Enter") $("cfind").click(); };
  $("crun").onclick = run;
  const th = store.get("cthresh"); if (th) $("cthresh").value = th;
  $("ccert").onclick = $("cdl").onclick = async (e) => {
    if (e) e.preventDefault();
    if (!last) return;
    try { const pdf = buildCertificate(await certDeps(), last, certOpts()); download(new Blob([pdf], { type: "application/pdf" }), `${safe($("cclient").value || last.title)}_Certificate_of_Completeness.pdf`); }
    catch (e) { log(`Error: ${e.message}`); }
  };
  $("cclient").oninput = schedulePreview; $("cissuer").oninput = schedulePreview;
  $("clive").onchange = () => { if ($("clive").checked && last) previewCert(); };
  $("cclose").onclick = () => showCertPane(false);
  $("crun").addEventListener("click", () => showCertPane(true));
  $("ccsv").onclick = async () => {
    $("ccsv").disabled = true;
    try { const rows = await missingRows({ fetchJson: ctx.fetchJson }, last, log); log(`Missing list: ${rows.length.toLocaleString()} features.`); download(new Blob([toCsv(rows)], { type: "text/csv" }), `${safe(last.title)}_missing_items.csv`); }
    catch (e) { log(`Error: ${e.message}`); }
    $("ccsv").disabled = false;
  };
}
export function setCompletenessMaps(items) {
  $("csteps").hidden = true;
  $("cmap").innerHTML = items.length ? items.map((i) => `<option value="${i.id}">${esc(i.title)}</option>`).join("") : "<option value=''>No maps found</option>";
  $("crun").disabled = !items.length;
}
