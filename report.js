// Full PROW evaluation report (the 12-page InDesign layout) built directly as a PDF.
//
// Environment-agnostic like renderer.js. Extra deps on top of the renderer's:
//   deps.reportFonts -> { montB, montSB, popL, pop, popM, popSB }  base64 TTF
//   deps.assets      -> { cover, cone, logo, mark, iconSidewalks, iconCrosswalks, iconCurbramps, iconTransit }
//                       each { data: Uint8Array, type: "JPEG"|"PNG", w, h }
//
//   loadReportData(deps, sharing, webmapId, onStatus) -> data   (downloads every layer once)
//   renderInset(deps, data, slot, inset, W, H)         -> canvas (for the spot pickers and the PDF)
//   buildFullReport(deps, data, input, onStatus)       -> ArrayBuffer (PDF)

import { DEFAULTS, resolveLayers, fetchFeatures, combinedExtent, renderBasemap, renderMapImage, rampColor, css, niceRound, fmtNum, layerKey } from "./renderer.js?v=20261022131747";

// ---------------------------------------------------------------- design tokens (measured from the 2026 Bangor report)
const PW = 612, PH = 792, ML = 54, CW = 504;            // letter portrait, left margin, content width (pt)
const C = {
  heading: [38, 41, 46], body: [84, 85, 87], footer: [68, 114, 129], coverBand: [34, 57, 65], stripe: [211, 217, 109],
  tblHead: [35, 67, 80], tint: [244, 250, 250], dots: [150, 160, 165], white: [255, 255, 255],
};
const SECTION = {
  overview:  { label: "Overview", color: [36, 56, 65] },
  sidewalk:  { label: "Sidewalk Data", color: [68, 114, 127] },
  crosswalk: { label: "Crosswalk Data", color: [143, 198, 195] },
  curb:      { label: "Curb Ramp Data", color: [205, 94, 66] },
  ped:       { label: "Pedestrian Signal Data", color: [222, 225, 112] },
  transit:   { label: "Transit Stop Data", color: [75, 81, 81] },
};
const MAP_ASPECT = (11 * 0.95) / (8.5 * 0.78);         // same frame shape as the landscape map PDFs
const LANDSCAPE_FRAME_IN = 11 * 0.95;                  // symbols sized as on the landscape PDFs, then scaled down (as InDesign did)

// which web-map layers feed which part of the report (by title)
export const GROUPS = {
  sidewalks: /sidewalk/i, crosswalks: /crosswalk/i, curbRamps: /curb\s*ramp/i,
  refuge: /refuge/i, signals: /signal/i, transit: /transit|boarding/i,
};

// Pages (in order). id -> label shown in the "pages to include" selector.
export const PAGES = [
  ["cover", "Cover"], ["overview", "Overview"], ["reliability", "Data reliability"],
  ["overviewMap", "Overview map + Table 1"], ["sidewalkMap", "Sidewalk DCS map + Table 2"],
  ["crosswalkMap", "Crosswalks map + Table 3"], ["crosswalkDetails", "Crosswalk details + Tables 4–7"],
  ["curbMap", "Curb ramps map + Table 8"], ["curbPhasing", "Curb ramp phasing (Table 9)"],
  ["refuge", "Pedestrian refuge islands map"], ["signals", "Pedestrian signals map"],
  ["transit", "Transit stops map + Table 10"],
];

// The three spots the user picks: which layers they show and their shape
export const INSETS = {
  overview:  { label: "Overview map detail", layers: null, focus: "sidewalks", aspect: 157 / 99, basemap: "topo" },
  sidewalk:  { label: "Sidewalk panel detail", layers: ["sidewalks"], focus: "sidewalks", aspect: 100 / 96, basemap: "topo" },
  crosswalk: { label: "Crosswalk details", layers: ["crosswalks", "sidewalks"], focus: "crosswalks", aspect: 500 / 270, basemap: "topo" },
};

// ---------------------------------------------------------------- data
export async function loadReportData(deps, sharing, webmapId, onStatus = () => {}) {
  onStatus("Reading the web map…");
  const { title, layers } = await resolveLayers(deps, sharing, webmapId);
  const cache = deps.featureCache || null;   // shared with the other tabs (url -> features)
  for (const L of layers) {
    if (cache && cache.has(L.url)) { L.features = cache.get(L.url); onStatus(`${L.title}: ${L.features.length.toLocaleString()} features (already downloaded)`); continue; }
    const { features } = await fetchFeatures(deps, L, (d, n) => onStatus(`Downloading ${L.title}: ${d.toLocaleString()} / ${n.toLocaleString()}`, true));
    L.features = features;
    if (cache) cache.set(L.url, features);
    onStatus(`${L.title}: ${features.length.toLocaleString()} features`);
  }
  const drawable = layers.filter((L) => L.features.length);
  if (!drawable.length) throw new Error("No features in any layer.");
  const groups = {};
  for (const [k, re] of Object.entries(GROUPS)) groups[k] = drawable.filter((L) => re.test(L.title));
  // signals regex also matches nothing else we care about; refuge islands are not signals
  groups.signals = groups.signals.filter((L) => !GROUPS.refuge.test(L.title));
  return { title, layers: drawable, groups, ext: combinedExtent(drawable, "letter"), baseCache: new Map() };
}

const cfgFor = (extra = {}) => ({ ...DEFAULTS, ...extra, iconOverrides: { ...DEFAULTS.iconOverrides, ...(extra.iconOverrides || {}) }, usedPt: {} });
// data.layerOrder (layerKeys, top first) = user's stacking/legend order; without it the renderer's default rule applies
const ordered = (data, ls) => {
  if (!data.layerOrder) return ls;
  const rank = (L) => { const k = data.layerOrder.indexOf(layerKey(L)); return k < 0 ? 1e9 : k; };
  return ls.slice().sort((a, b) => rank(a) - rank(b));
};
const orderCfg = (data) => (data.layerOrder ? { layerOrder: data.layerOrder } : {});

async function basemapFor(deps, data, cfg, ext, W, H) {
  const key = `${cfg.basemap}|${ext.x0}|${ext.y0}|${ext.x1}|${ext.y1}|${W}x${H}`;
  if (!data.baseCache.has(key)) data.baseCache.set(key, await renderBasemap(deps, cfg, ext, W, H));
  return data.baseCache.get(key);
}

const layersOf = (data, keys) => (keys ? keys.flatMap((k) => data.groups[k] || []) : data.layers);

// default inset spot: the sidewalk/feature nearest the middle of all features (usually downtown)
export function defaultInset(data, slot) {
  const ls = data.groups[INSETS[slot].focus]?.length ? data.groups[INSETS[slot].focus] : layersOf(data, INSETS[slot].layers);
  const pts = [];
  for (const L of ls) for (const f of L.features) {
    const g = f.geometry, p = g.x !== undefined ? [g.x, g.y] : (g.rings || g.paths)[0][0];
    pts.push(p);
  }
  if (!pts.length) return { cx: (data.ext.x0 + data.ext.x1) / 2, cy: (data.ext.y0 + data.ext.y1) / 2, widthM: 400 };
  const xs = pts.map((p) => p[0]).sort((a, b) => a - b), ys = pts.map((p) => p[1]).sort((a, b) => a - b);
  const mx = xs[xs.length >> 1], my = ys[ys.length >> 1];
  let best = pts[0], bd = Infinity;
  for (const p of pts) { const d = (p[0] - mx) ** 2 + (p[1] - my) ** 2; if (d < bd) { bd = d; best = p; } }
  return { cx: best[0], cy: best[1], widthM: slot === "overview" ? 450 : slot === "sidewalk" ? 70 : 160 };
}

export function insetExtent(data, slot, inset) {
  const k = Math.cos(data.ext.lat * Math.PI / 180), w = inset.widthM / k, h = w / INSETS[slot].aspect;
  return { x0: inset.cx - w / 2, x1: inset.cx + w / 2, y0: inset.cy - h / 2, y1: inset.cy + h / 2, lat: data.ext.lat };
}

// popup = { layer, feature, title, rows: [[label, value]], photo } (from loadPopup) draws an ArcGIS-style popup on top
export async function renderInset(deps, data, slot, inset, W, H, frameIn, popup) {
  const cfg = cfgFor({ basemap: INSETS[slot].basemap, iconOverrides: data.iconOverrides, ...orderCfg(data) });
  const ext = insetExtent(data, slot, inset);
  const base = await basemapFor(deps, data, cfg, ext, W, H);
  const r = await renderMapImage(deps, cfg, ordered(data, layersOf(data, INSETS[slot].layers)), ext, base, W, H, frameIn || W / 300, "detail");
  if (popup) drawPopup(r.canvas, ext, popup);
  return r.canvas;
}

// ---------------------------------------------------------------- crosswalk popup ("Identify" look, like the ArcGIS Map Viewer)
const ptInRing = (x, y, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
// feature of the slot's focus layer under (x, y) in map units, else the nearest within `tol`
export function featureAt(data, slot, x, y, tol) {
  const ls = data.groups[INSETS[slot].focus] || [];
  let best = null, bd = tol * tol;
  for (const L of ls) for (const f of L.features) {
    const g = f.geometry;
    if (g.rings && g.rings.some((r) => ptInRing(x, y, r))) return { layer: L, feature: f };
    for (const r of g.rings || g.paths || [[[g.x, g.y]]]) for (const p of r) { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; best = { layer: L, feature: f }; } }
  }
  return best;
}
// fields offered in the popup: the web map's visible popup fields, else every field
export function popupFields(layer) {
  const fi = ((layer.popupInfo || {}).fieldInfos || []).filter((f) => f.visible !== false);
  if (fi.length) return fi.map((f) => ({ name: f.fieldName, label: f.label || f.fieldName }));
  return layer.fields.filter((f) => !/^(OBJECTID|GlobalID|Shape__)/i.test(f.name)).map((f) => ({ name: f.name, label: f.alias || f.name }));
}
export function defaultPopupFields(layer) {
  const names = popupFields(layer).map((f) => f.name), want = ["ticket_key", "TRAVEL_PATH_WIDTH", "VERT_OFFSET"].filter((n) => names.includes(n));
  return want.length ? want : names.slice(0, 3);
}
const fmtValue = (field, v) => {
  if (v === null || v === undefined || v === "") return "";
  const cv = field && field.domain && field.domain.codedValues && field.domain.codedValues.find((c) => c.code === v);
  if (cv) return cv.name;
  if (field && field.type === "esriFieldTypeDate") return new Date(v).toLocaleString("en-US");
  if (typeof v === "number" && !Number.isInteger(v)) return v.toFixed(2);
  return String(v);
};
// first media image in the popup, with {field} placeholders filled from the feature
function mediaImageUrl(pi, attrs) {
  const els = pi ? [...(pi.popupElements || []).filter((e) => e.type === "media").flatMap((e) => e.mediaInfos || []), ...(pi.mediaInfos || [])] : [];
  for (const m of els) {
    if (m.type !== "image" || !m.value || !m.value.sourceURL) continue;
    const u = m.value.sourceURL.replace(/\{([^}]+)\}/g, (_, f) => { const k = Object.keys(attrs).find((n) => n.toLowerCase() === f.toLowerCase()); return k && attrs[k] != null ? attrs[k] : ""; });
    if (/^https?:\/\/\S+$/.test(u)) return u;
  }
  return null;
}
// a layer with the same name and attachments in another FeatureServer this map uses (e.g. *_Data_External)
async function hostedTwin(deps, data, L) {
  data.twinCache = data.twinCache || new Map();
  if (data.twinCache.has(L.url)) return data.twinCache.get(L.url);
  const base = (u) => (u || "").replace(/\/\d+\/?$/, "");
  const bases = [...new Set((data.layers || []).map((x) => base(x.url)))].filter((b) => /FeatureServer$/.test(b) && b !== base(L.url));
  let twin = null;
  for (const b of bases) {
    const svc = await deps.fetchJson(b, {}).catch(() => null);
    const hit = svc && (svc.layers || []).find((x) => x.name.toLowerCase() === L.title.toLowerCase());
    if (!hit) continue;
    const info = await deps.fetchJson(`${b}/${hit.id}`, {}).catch(() => null);
    if (info && info.hasAttachments) { twin = { url: `${b}/${hit.id}`, oidField: info.objectIdField || "OBJECTID", fields: (info.fields || []).map((f) => f.name) }; break; }
  }
  data.twinCache.set(L.url, twin);
  return twin;
}
// one feature's attributes (all fields) + its first photo (attachment or popup media image)
export async function loadPopup(deps, data, slot, oid, fieldNames) {
  const ls = data.groups[INSETS[slot].focus] || [];
  for (const L of ls) {
    const feature = L.features.find((f) => (f.attributes || {})[L.oidField] === oid);
    if (!feature) continue;
    const key = `${L.url}|${oid}`;
    data.popupCache = data.popupCache || new Map();
    if (!data.popupCache.has(key)) {
      const q = await deps.fetchJson(`${L.url}/query`, { objectIds: oid, outFields: "*", returnGeometry: "false" });
      const attrs = ((q.features || [])[0] || {}).attributes || {};
      let photo = null, photoNote = null;
      if (L.hasAttachments && deps.fetchImage) {
        const a = await deps.fetchJson(`${L.url}/${oid}/attachments`, {});
        const info = (a.attachmentInfos || []).find((x) => /^image\//.test(x.contentType || "image/")) || (a.attachmentInfos || [])[0];
        if (info) { try { photo = await deps.fetchImage(`${L.url}/${oid}/attachments/${info.id}`); } catch (e) { photo = null; } }
      }
      // popups whose photo is a media image built from a URL field, e.g. {image_url_perspective}
      const src = !photo && mediaImageUrl(L.popupInfo, attrs);
      if (src) {
        try { const r = await fetch(src); if (!r.ok) throw new Error(r.status); photo = await deps.loadImage(URL.createObjectURL(await r.blob())); }
        catch (e) { photoNote = `Photo couldn't be loaded from ${new URL(src).host} (the image server doesn't allow it to be read from this page).`; }
      }
      // otherwise the same photo as an attachment on a hosted copy of this layer (another service the map uses)
      if (!photo && deps.fetchImage) {
        try {
          const twin = await hostedTwin(deps, data, L), keyField = twin && ["segment_id", "GlobalID"].find((n) => attrs[n] != null && twin.fields.includes(n));
          if (keyField) {
            const v = attrs[keyField], where = typeof v === "number" ? `${keyField}=${v}` : `${keyField}='${String(v).replace(/'/g, "''")}'`;
            const q2 = await deps.fetchJson(`${twin.url}/query`, { where, outFields: twin.oidField, returnGeometry: "false" });
            const toid = (((q2.features || [])[0] || {}).attributes || {})[twin.oidField];
            if (toid != null) {
              const a = await deps.fetchJson(`${twin.url}/${toid}/attachments`, {});
              const info = (a.attachmentInfos || []).find((x) => /^image\//.test(x.contentType || "image/"));
              if (info) { photo = await deps.fetchImage(`${twin.url}/${toid}/attachments/${info.id}`); photoNote = null; }
            }
          }
        } catch (e) { /* keep the note */ }
      }
      data.popupCache.set(key, { attrs, photo, photoNote });
    }
    const { attrs, photo, photoNote } = data.popupCache.get(key);
    const labels = Object.fromEntries(popupFields(L).map((f) => [f.name, f.label]));
    const rows = fieldNames.map((n) => [labels[n] || n, fmtValue(L.fields.find((f) => f.name === n), attrs[n])]);
    return { layer: L, feature, title: (L.popupInfo && L.popupInfo.title && !/\{/.test(L.popupInfo.title)) ? L.popupInfo.title : L.title, rows, photo, photoNote };
  }
  return null;
}
function drawPopup(cv, ext, p) {
  const g = cv.getContext("2d"), W = cv.width, H = cv.height, u = W / 883;
  const X = (x) => ((x - ext.x0) / (ext.x1 - ext.x0)) * W, Y = (y) => ((ext.y1 - y) / (ext.y1 - ext.y0)) * H;
  // highlight the picked feature
  const geo = p.feature.geometry;
  g.save(); g.beginPath();
  for (const r of geo.rings || geo.paths || []) { g.moveTo(X(r[0][0]), Y(r[0][1])); for (const q of r.slice(1)) g.lineTo(X(q[0]), Y(q[1])); if (geo.rings) g.closePath(); }
  if (geo.rings) { g.fillStyle = "rgba(0,255,255,0.25)"; g.fill(); }
  g.strokeStyle = "rgb(0,255,255)"; g.lineWidth = 2 * u; g.stroke(); g.restore();
  // panel
  const x = 10 * u, y = 8 * u, w = 338 * u, h = Math.min(p.photo ? 372 * u : (78 + 22 * p.rows.length) * u, H - 16 * u), font = (px, wt = 400) => `${wt} ${px * u}px "Avenir Next", "Segoe UI", Helvetica, Arial, sans-serif`;
  g.save();
  g.shadowColor = "rgba(0,0,0,0.3)"; g.shadowBlur = 8 * u; g.shadowOffsetY = 2 * u;
  g.fillStyle = "#fff"; g.fillRect(x, y, w, h); g.restore();
  g.strokeStyle = "#cfcfcf"; g.lineWidth = u; g.strokeRect(x, y, w, h);
  g.fillStyle = "#323232"; g.font = font(11, 600); g.textBaseline = "middle";
  g.fillText(p.title, x + 10 * u, y + 17 * u);
  const cx = x + w - 14 * u, cy = y + 17 * u, k = 3.5 * u;   // close "x"
  g.strokeStyle = "#6e6e6e"; g.lineWidth = 1.1 * u; g.beginPath(); g.moveTo(cx - k, cy - k); g.lineTo(cx + k, cy + k); g.moveTo(cx + k, cy - k); g.lineTo(cx - k, cy + k); g.stroke();
  g.fillStyle = "#6e6e6e"; g.font = font(8);
  let tx = x + 10 * u; for (const s of ["Table", "Edit", "Get directions", "Zoom to"]) { g.fillText(s, tx, y + 40 * u); tx += g.measureText(s).width + 16 * u; }
  g.fillStyle = "#e0e0e0"; g.fillRect(x, y + 51 * u, w, u);
  let ry = y + 60 * u; const rh = 22 * u, inner = w - 28 * u;
  p.rows.forEach(([label, value], i) => {
    g.fillStyle = i % 2 ? "#f3f3f3" : "#e8e8e8"; g.fillRect(x + 10 * u, ry, inner, rh);
    g.fillStyle = "#4a4a4a"; g.font = font(8.2); g.fillText(String(label).slice(0, 32), x + 18 * u, ry + rh / 2);
    g.fillText(String(value).slice(0, 26), x + 10 * u + inner * 0.5, ry + rh / 2);
    ry += rh;
  });
  if (p.photo) {
    const pw = inner, ph = Math.min((pw * p.photo.height) / p.photo.width, y + h - ry - 22 * u);
    const sw = p.photo.width, sh = Math.min(p.photo.height, (ph / pw) * sw);
    if (ph > 20 * u) g.drawImage(p.photo, 0, (p.photo.height - sh) / 2, sw, sh, x + 10 * u, ry + 14 * u, pw, ph);
  }
  // scroll bar, as in the screenshot
  g.fillStyle = "#c8c8c8"; g.fillRect(x + w - 9 * u, y + 60 * u, 4 * u, h - 75 * u);
  g.fillStyle = "#8a8a8a"; g.fillRect(x + w - 9 * u, y + h - 70 * u, 4 * u, 40 * u);
}

// overview canvas the spot pickers draw on
export async function renderPickerBase(deps, data, slot, W) {
  const H = Math.round(W / MAP_ASPECT), cfg = cfgFor({ basemap: "topo", iconOverrides: data.iconOverrides, ...orderCfg(data) });
  const base = await basemapFor(deps, data, cfg, data.ext, W, H);
  const r = await renderMapImage(deps, cfg, ordered(data, layersOf(data, INSETS[slot].layers)), data.ext, base, W, H, LANDSCAPE_FRAME_IN, false);
  return r.canvas;
}

// ---------------------------------------------------------------- tables
// CSV text -> { header: [...], rows: [[...]] }
export function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const out = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((c) => c !== "")) out.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some((c) => c !== "")) out.push(row);
  return { header: out[0] || [], rows: out.slice(1) };
}

// Report-generator file name -> table number (Table1.csv, Table4_yield_or_stop_control_device.csv, table10_output.csv)
export const tableNumber = (name) => { const m = /(?:^|\/)table\s*_?(\d+)[^/]*\.csv$/i.exec(name); return m ? Number(m[1]) : null; };

const METRIC_NAMES = { 1: "Dax Compliance Score (DCS)", 3: "Crosswalk Score", 9: "Dax Compliance Score (DCS)" };
// tidy generator output into what the printed report shows
export function cleanTable(n, t) {
  const header = t.header.map((h, i) => {
    h = String(h).replace(/\.\d+$/, "").trim();
    if (/^lifecycle$/i.test(h)) h = "Lifecycle Replacement";
    if (/# of bus stops/i.test(h)) h = "# of Stops";
    return i === 0 && !h ? "Metric" : h;
  });
  const rows = t.rows.map((r) => r.map((c, i) => {
    c = String(c).trim();
    if (i === 0 && METRIC_NAMES[n] && t.rows.length === 1) return METRIC_NAMES[n];
    if (/^-?\d+(\.\d+)?$/.test(c) && i > 0 && header[i] && !/phase|as-built|lifecycle/i.test(header[i])) return Number(c).toLocaleString("en-US");
    return c.replace(/"(\S)/g, "”$1").replace(/(\d)"/g, "$1\"");
  }));
  return { header, rows };
}

// blank, hand-editable starting point (accuracy differs per report)
export const DEFAULT_RELIABILITY = {
  header: ["Category", "Lowest Accuracy Calculated", "Highest Accuracy Calculated"],
  rows: [["Vertical Obstruction", "", ""], ["Slab Width", "", ""], ["Travel Path Width", "", ""],
    ["Surface Material", "", ""], ["Damage", "", ""], ["Special Slab Type", "", ""]],
};

// Blank templates for every report table: labels/bins as in the 2026 reports, counts empty.
const XW = ["Metric", "As-Built", "# of Crosswalks", "As-Built", "# of Crosswalks", "As-Built", "# of Crosswalks", "As-Built", "# of Crosswalks"];
const XW_ROWS = [["Vertical Changes", "1\" Plus", "", "0.5\" to 1\"", "", "0.25\" - 0.5\"", "", "< 0.25\"", ""],
  ["Running Slope", "N/A", "N/A", "> 8.3%", "", "5% - 8.3%", "", "< 5%", ""], ["Cross Slope", "> 5.0%", "", "3.0% - 5.0%", "", "2.08% - 3%", "", "< 2.08%", ""]];
const phases = (unit, metric) => ({ header: ["Metric", "Phase 1", unit, "Phase 2", unit, "Phase 3", unit, "Lifecycle Replacement", unit],
  rows: [[metric, "0-40", "", "41-70", "", "71-99", "", "100", ""]] });
export const TABLE_TEMPLATES = {
  1: phases("Feet", "Dax Compliance Score (DCS)"),
  2: { header: ["Metric", "As-Built", "Feet", "As-Built", "Feet", "As-Built", "Feet", "As-Built", "Feet"],
    rows: [["Vertical Changes", "1\" Plus", "", "0.5\" - 1\"", "", "0.25\" - 0.5\"", "", "<0.25\"", ""],
      ["Running Slope", "N/A", "N/A", "> 8.3%", "", "5% - 8.3%", "", "< 5%", ""], ["Cross Slope", "> 5.0%", "", "3.0% - 5.0%", "", "2.08% - 3%", "", "< 2.08%", ""]] },
  3: phases("Count", "Crosswalk Score"),
  4: { header: XW, rows: XW_ROWS }, 5: { header: XW, rows: XW_ROWS }, 6: { header: XW, rows: XW_ROWS }, 7: { header: XW, rows: XW_ROWS },
  8: { header: ["Metric", "As-Built", "# of Curb Ramps", "As-Built", "# of Curb Ramps", "As-Built", "# of Curb Ramps", "As-Built", "# of Curb Ramps"],
    rows: [["Cross Slope", "> 5.0%", "", "3% - 5%", "", "2.08% - 3%", "", "< 2.08%", ""], ["Running Slope", "> 9.0%", "", "8.6% - 9%", "", "8.3% - 8.6%", "", "< 8.3%", ""],
      ["Width", "< 32\"", "", "32\"-36\"", "", "36\" - 48\"", "", "> 48\"", ""], ["Turning Space Slope", "> 5.0%", "", "3% - 5%", "", "2.08% - 3%", "", "< 2.08%", ""]] },
  9: phases("# of Curb Ramps", "Dax Compliance Score (DCS)"),
  10: { header: ["Metric", "Phase 1", "# of Stops", "Phase 2", "# of Stops", "Phase 3", "# of Stops", "Lifecycle Replacement", "# of Stops"],
    rows: [["Boarding/Alighting Depth", "< 48\" or missing", "", "48\" - 84\"", "", "84.01\" - 96\"", "", ">96\"", ""],
      ["Boarding/Alighting Slope", ">5.0%", "", "3.0%-5.0%", "", "2.08%-3.0%", "", "<2.08%", ""]] },
};
export const blankTable = (n) => JSON.parse(JSON.stringify(n === "reliability" ? DEFAULT_RELIABILITY : TABLE_TEMPLATES[n]));
// a table counts as filled in when any value cell (not the metric / bin labels) has something in it
export function tableHasData(t) {
  if (!t || !t.rows || !t.rows.length) return false;
  const labelCol = (i) => i === 0 || /phase|as-built|lifecycle|category/i.test(t.header[i] || "");
  return t.rows.some((r) => r.some((c, i) => !labelCol(i) && String(c ?? "").trim() !== "" && !/^n\/a$/i.test(String(c).trim())));
}

const num = (s) => Number(String(s ?? "").replace(/[^0-9.\-]/g, "")) || 0;
// totals the text quotes: sidewalk miles (Table 1 feet / 5280) and curb ramps (Table 9 counts)
export function derivedNumbers(tables) {
  const sumCols = (t, re) => (t ? t.rows.reduce((s, r) => s + r.reduce((a, c, i) => a + (re.test(t.header[i] || "") ? num(c) : 0), 0), 0) : 0);
  const feet = sumCols(tables[1], /^feet$/i), ramps = sumCols(tables[9], /curb ramps/i);
  return { miles: feet ? (feet / 5280).toFixed(2) : "", ramps: ramps ? ramps.toLocaleString("en-US") : "" };
}

const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}` : xs[0] || "");
// reliability wording follows the accuracy table (Bangor-style when every category is equal, Midland-style when they vary)
function reliabilityText(rel) {
  const lead = "We used randomly selected data samples and the Wilson score* to determine a 95% confidence interval for the accuracy of the data that we provided for this report.";
  const rows = ((rel && rel.rows) || []).map((r) => ({ name: String(r[0] || "").trim().toLowerCase(), lo: num(r[1]), hi: num(r[2]), has: String(r[1] ?? "").trim() !== "" }))
    .filter((r) => r.name && r.has);
  if (!rows.length) return `${lead} This calculation showed the data sets for this report to be —% accurate. Data accuracy for this report is as listed below:`;
  const lo = Math.min(...rows.map((r) => r.lo)), hi = Math.max(...rows.map((r) => r.hi || r.lo));
  const range = lo === hi ? `${lo}%` : `${lo}-${hi}%`;
  if (rows.every((r) => r.lo === rows[0].lo))
    return `${lead} This calculation showed the data sets for this report to be ${range} accurate. We have a very high accuracy score for ${andList([...rows.slice(0, 3).map((r) => r.name), "all other categories of data"])}. Data accuracy for this report is as listed below:`;
  const top = Math.max(...rows.map((r) => r.lo)), veryHigh = rows.filter((r) => r.lo === top).map((r) => r.name), high = rows.filter((r) => r.lo !== top).map((r) => r.name);
  return `${lead} This calculation showed the data sets for this report to be ${range} accurate, with variations between the categories of the data sampled. We have a very high accuracy score for ${andList(veryHigh)}, as well as a high accuracy score for ${andList([...high, "other categories of data"])}. Data accuracy for this report is as listed below:`;
}

export function defaultTexts(f, data, reliability) {
  const city = f.city || "the city";
  const others = data ? data.layers.filter((L) => !GROUPS.sidewalks.test(L.title) && !GROUPS.curbRamps.test(L.title) && !GROUPS.crosswalks.test(L.title)).map((L) => L.title.toLowerCase()) : [];
  return {
    overview: `We evaluated the Public Rights-of-Way in ${city} using the Public Rights-of-Way Access Guidelines (PROWAG). We evaluated ${f.miles || "—"} miles of sidewalk and ${f.ramps || "—"} curb ramps. We also scored curb ramps and sidewalk segments with a Dax Compliance Score (DCS) based on running and cross slopes, uplifts, and other impediments to access.`,
    reliability: reliabilityText(reliability),
    overviewMap: `Overview map: Sidewalk panels and curb ramps, color-coded by DCS, are shown as overlays.${others.length ? ` Additional overlays show ${andList(others)}.` : ""}`,
  };
}

// wording from the delivered 2026 reports, shown under each text box as a guide
export const TEXT_EXAMPLES = {
  overview: [["Bangor, ME", "We evaluated the Public Rights-of-Way in Bangor, ME using the Public Rights-of-Way Access Guidelines (PROWAG). We evaluated 117.42 miles of sidewalk and 1,937 curb ramps. We also scored curb ramps and sidewalk segments with a Dax Compliance Score (DCS) based on running and cross slopes, uplifts, and other impediments to access."]],
  reliability: [
    ["Bangor, ME", "We used randomly selected data samples and the Wilson score* to determine a 95% confidence interval for the accuracy of the data that we provided for this report. This calculation showed the data sets for this report to be 98-100% accurate. We have a very high accuracy score for vertical obstructions, surface material, special slab type, and all other categories of data. Data accuracy for this report is as listed below:"],
    ["Midland, TX", "We used randomly selected data samples and the Wilson score* to determine a 95% confidence interval for the accuracy of the data that we provided for this report. This calculation showed the data sets for this report to be 94-100% accurate, with variations between the categories of the data sampled. We have a very high accuracy score for slab width, travel path width, and special slab type, as well as a high accuracy score for vertical obstructions, damage, and other categories of data. Data accuracy for this report is as listed below:"]],
  overviewMap: [
    ["Bangor, ME", "Overview map: Sidewalk panels and curb ramps, color-coded by DCS, are shown as overlays. Additional overlays show access barriers, on-street accessible parking, and pedestrian signals."],
    ["Midland, TX", "Overview map: Sidewalk panels and curb ramps, color-coded by DCS, are shown as overlays. Additional overlays show transit boarding areas, access barriers, on-street parking locations, on-street accessible parking, and passenger loading zones."]],
};

// ---------------------------------------------------------------- Tables 3–10 straight from ArcGIS
// A port of Ryan's ADA report table generator (ada_report_generator_local_2026-10-07). Its CSV inputs are
// ArcGIS exports, so its column names are the layers' field aliases; here the fields are looked up the same way.
// Tables 1–2 need slab lengths. Neither ArcGIS nor ADA Manager stores one: the generator's segment_length
// tool measures each slab from its corners (cap-to-cap midpoint distance along the direction of travel), and
// slabLengthFt below does the same with the ArcGIS polygon (travel = previous → next slab on the path).
// Checked on Irvine (657k slabs): -0.34% total, per-slab median error 0.31%, 99% of slabs within 1%.
const num0 = (v) => { if (v === null || v === undefined || String(v).trim() === "") return NaN; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const fieldBy = (L, ...names) => {
  const want = names.map((n) => n.toLowerCase());
  const f = L.fields.find((x) => want.includes(String(x.alias || "").toLowerCase()) || want.includes(x.name.toLowerCase()));
  return f ? f.name : null;
};
async function layerAttrs(deps, L, fields) {
  const ids = (await deps.fetchJson(`${L.url}/query`, { where: "1=1", returnIdsOnly: "true" })).objectIds || [];
  const out = [], f = [...new Set(fields.filter(Boolean))].join(",") || L.oidField;
  for (let i = 0; i < ids.length; i += 1000) {
    const r = await deps.fetchJson(`${L.url}/query`, { objectIds: ids.slice(i, i + 1000).join(","), outFields: f, returnGeometry: "false" });
    if (r.error) throw new Error(`${L.title}: ${r.error.message}`);
    for (const x of r.features || []) out.push(x.attributes);
  }
  return out;
}
// generator's score bins; 40 itself counts as 0-40 (the generator's `s < 40` / `40 < s` drops exactly 40)
const scoreBin = (s) => (Number.isNaN(s) ? null : s <= 40 ? "0-40" : s <= 70 ? "41-70" : s < 100 ? "71-99" : s === 100 ? "100" : null);
const fmt = (n) => Number(n).toLocaleString("en-US");

// slab length (ft) from a polygon ring in Web Mercator metres; tv = direction of travel (any length) or null
function slabLengthFt(ring, tv) {
  let q = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
  const n = q.length; if (n < 3) return NaN;
  const k = Math.cos(2 * Math.atan(Math.exp(q[0][1] / 6378137)) - Math.PI / 2);   // Mercator metres -> ground metres
  const edges = q.map((a, i) => [a, q[(i + 1) % n]]);
  let c0 = 0, c1 = Math.floor(n / 2);
  const tn = tv ? Math.hypot(tv[0], tv[1]) : 0;
  if (tn > 0) {
    // the two caps are the edges most across the direction of travel (and not next to each other)
    const score = edges.map(([a, b]) => Math.abs(((b[0] - a[0]) * tv[0] + (b[1] - a[1]) * tv[1]) / ((Math.hypot(b[0] - a[0], b[1] - a[1]) || 1) * tn)));
    const order = [...score.keys()].sort((i, j) => score[i] - score[j]);
    c0 = order[0];
    c1 = order.slice(1).find((i) => ![1, n - 1].includes((((i - c0) % n) + n) % n)) ?? (c0 + Math.floor(n / 2)) % n;
  }
  const mid = ([a, b]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], m1 = mid(edges[c0]), m2 = mid(edges[c1]);
  return Math.hypot(m2[0] - m1[0], m2[1] - m1[1]) * k * 3.28084;
}

// want = Set of table numbers to compute (null = all); only the layers those tables need are read
// scoreBy = "dcs" | "rai" picks the score that Tables 1, 3 and 9 are binned by (customer-specific); without it
// those three are left out and everything else is still calculated
export async function computeTables(deps, data, onStatus = () => {}, want = null, scoreBy = null) {
  const out = {}, notes = [];
  const G = data.groups, needs = (...ns) => !want || ns.some((n) => want.has(n));
  // RAI is used per layer only where that layer has RAI scores; otherwise the layer falls back to DCS
  const LABEL = { RAI: "RAI Score", DCS: "Dax Compliance Score (DCS)" };
  const scoreFields = (L) => ({ rai: scoreBy === "rai" ? fieldBy(L, "RAI Score") : null, dcs: fieldBy(L, "DCS Score") });
  const pickScore = (sf, attrs, layerName, table) => {
    if (sf.rai && attrs.some((a) => a[sf.rai] != null && a[sf.rai] !== "")) return { f: sf.rai, SN: "RAI" };
    if (scoreBy === "rai") notes.push(`The ${layerName} layer has no RAI scores, so Table ${table} uses DCS.`);
    return { f: sf.dcs, SN: "DCS" };
  };
  // ---- sidewalks: Table 1 (feet by DCS) and Table 2 (feet by defect), lengths measured from the slab shapes
  const SWL = (G.sidewalks || [])[0];
  if (SWL && needs(1, 2)) {
    onStatus("Tables 1–2: measuring sidewalk slabs…");
    const F = { oid: SWL.oidField, path: fieldBy(SWL, "Path ID", "path_id"), ticket: fieldBy(SWL, "Ticket Key", "Ticket ID"), idx: fieldBy(SWL, "Segment Index", "segment_idx"),
      ...(() => { const sf = scoreFields(SWL); return { rai: sf.rai, dcs: sf.dcs }; })(), vo: fieldBy(SWL, "Vertical Offset (IN.)"), rs: fieldBy(SWL, "Running Slope (%)"), cs: fieldBy(SWL, "Cross Slope (%)") };
    const swAttrs = await layerAttrs(deps, SWL, Object.values(F));
    const S1 = pickScore(F, swAttrs, "sidewalk", 1);
    const attrs = new Map(swAttrs.map((a) => [a[F.oid], a]));
    const byPath = new Map();
    for (const f of SWL.features) {
      const a = attrs.get(f.attributes[SWL.oidField]); const ring = ((f.geometry || {}).rings || [])[0];
      if (!a || !ring) continue;
      const key = (F.path && a[F.path] != null && a[F.path] !== "") ? `p${a[F.path]}` : F.ticket ? `t${a[F.ticket]}` : "all";
      const c = ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);
      (byPath.get(key) || byPath.set(key, []).get(key)).push({ a, ring, c, i: num0(F.idx ? a[F.idx] : 0) });
    }
    const t1 = { "0-40": 0, "41-70": 0, "71-99": 0, "100": 0 }, vo = [0, 0, 0, 0], rs = [0, 0, 0], cs = [0, 0, 0, 0];
    let feet = 0, unmeasured = 0, unscored = 0;
    for (const slabs of byPath.values()) {
      slabs.sort((x, y) => (x.i || 0) - (y.i || 0));
      slabs.forEach((s, i) => {
        const p = slabs[Math.max(i - 1, 0)].c, n = slabs[Math.min(i + 1, slabs.length - 1)].c;
        const len = slabLengthFt(s.ring, slabs.length > 1 ? [n[0] - p[0], n[1] - p[1]] : null);
        if (!Number.isFinite(len)) { unmeasured++; return; }
        feet += len;
        const d = scoreBin(num0(s.a[S1.f])); if (d) t1[d] += len; else unscored++;
        const v = num0(s.a[F.vo]); vo[Number.isNaN(v) || v < 0.25 ? 3 : v < 0.5 ? 2 : v < 1 ? 1 : 0] += len;
        const r = Math.abs(num0(s.a[F.rs])); if (!Number.isNaN(r)) rs[r < 5 ? 2 : r <= 8.3 ? 1 : 0] += len;
        const x = Math.abs(num0(s.a[F.cs])); if (!Number.isNaN(x)) cs[x < 2.08 ? 3 : x < 3 ? 2 : x < 5 ? 1 : 0] += len;
      });
    }
    const ft = (v) => fmt(Math.round(v));
    if (scoreBy) out[1] = { header: [...TABLE_TEMPLATES[1].header], rows: [[LABEL[S1.SN], "0-40", ft(t1["0-40"]), "41-70", ft(t1["41-70"]), "71-99", ft(t1["71-99"]), "100", ft(t1["100"])]] };
    if (scoreBy && !S1.f) notes.push("The sidewalk layer has no RAI or DCS score field, so Table 1 is empty.");
    out[2] = { header: [...TABLE_TEMPLATES[2].header], rows: [
      ["Vertical Changes", '1" Plus', ft(vo[0]), '0.5" - 1"', ft(vo[1]), '0.25" - 0.5"', ft(vo[2]), '<0.25"', ft(vo[3])],
      ["Running Slope", "N/A", "N/A", "> 8.3%", ft(rs[0]), "5% - 8.3%", ft(rs[1]), "< 5%", ft(rs[2])],
      ["Cross Slope", "> 5.0%", ft(cs[0]), "3.0% - 5.0%", ft(cs[1]), "2.08% - 3%", ft(cs[2]), "< 2.08%", ft(cs[3])]] };
    notes.push(`Tables 1–2: ${fmt(Math.round(feet))} ft (${(feet / 5280).toFixed(2)} mi) of sidewalk, measured from the slab shapes the same way the report generator measures them.`);
    if (scoreBy && unscored && S1.f) notes.push(`${fmt(unscored)} sidewalk slabs have no ${S1.SN} score, so they are not in Table 1.`);
    if (unmeasured) notes.push(`${fmt(unmeasured)} sidewalk slabs have no usable shape and were not measured.`);
  }
  // ---- crosswalks: Table 3 (lowest score per crosswalk) and Tables 4–7 (by signal type)
  const XL = (G.crosswalks || [])[0];
  if (XL && needs(3, 4, 5, 6, 7)) {
    onStatus("Tables 3–7: reading crosswalks…");
    const F = { path: fieldBy(XL, "Path ID", "path_id"), ticket: fieldBy(XL, "Ticket Key", "Ticket ID", "jira_id"), ...scoreFields(XL),
      vo: fieldBy(XL, "Vertical Offset (IN.)"), rs: fieldBy(XL, "Running Slope (%)"), cs: fieldBy(XL, "Cross Slope (%)"), sig: fieldBy(XL, "Crosswalk Signal Type") };
    const xAttrs = await layerAttrs(deps, XL, Object.values(F));
    const S3 = pickScore(F, xAttrs, "crosswalk", 3);
    const rows = xAttrs.map((a) => ({
      id: (F.path && a[F.path] != null && a[F.path] !== "" ? a[F.path] : F.ticket ? a[F.ticket] : null), dcs: num0(a[S3.f]),
      vo: num0(a[F.vo]), rs: Math.abs(num0(a[F.rs])), cs: Math.abs(num0(a[F.cs])), sig: F.sig ? a[F.sig] : null }));
    // Table 3
    const minBy = new Map();
    for (const r of rows) if (r.id != null && !Number.isNaN(r.dcs)) minBy.set(r.id, Math.min(minBy.get(r.id) ?? Infinity, r.dcs));
    const c3 = { "0-40": 0, "41-70": 0, "71-99": 0, "100": 0 };
    for (const s of minBy.values()) { const b = scoreBin(s); if (b) c3[b]++; }
    if (scoreBy && !S3.f) notes.push("The crosswalk layer has no RAI or DCS score field, so Table 3 is empty.");
    if (scoreBy) out[3] = { header: [...TABLE_TEMPLATES[3].header], rows: [["Crosswalk Score", "0-40", fmt(c3["0-40"]), "41-70", fmt(c3["41-70"]), "71-99", fmt(c3["71-99"]), "100", fmt(c3["100"])]] };
    // Tables 4–7: each crosswalk counted once per row, in the worst bin it reaches
    const sigTable = (type, running) => {
      const df = rows.filter((r) => r.sig === type && r.id != null);
      const ladder = (tests) => { const seen = new Set(); return tests.map((test) => { const ids = new Set(df.filter((r) => test(r) && !seen.has(r.id)).map((r) => r.id)); ids.forEach((i) => seen.add(i)); return ids.size; }); };
      const vo = ladder([(r) => r.vo > 1, (r) => r.vo >= 0.5 && r.vo <= 1, (r) => r.vo >= 0.25 && r.vo < 0.5, (r) => r.vo < 0.25 || Number.isNaN(r.vo)]);
      const rs = ladder([(r) => r.rs > 8.3, (r) => r.rs >= 5 && r.rs <= 8.3, (r) => r.rs < 5]);
      const cs = running ? ladder([(r) => r.cs > 8.3, (r) => r.cs >= 5 && r.cs <= 8.3, (r) => r.cs < 5])
        : ladder([(r) => r.cs > 5, (r) => r.cs >= 3 && r.cs <= 5, (r) => r.cs >= 2.08 && r.cs < 3, (r) => r.cs < 2.08 || Number.isNaN(r.cs)]);
      return { header: [...TABLE_TEMPLATES[4].header], rows: [
        ["Vertical Changes", '1" Plus', fmt(vo[0]), '0.5" to 1"', fmt(vo[1]), '0.25" - 0.5"', fmt(vo[2]), '< 0.25"', fmt(vo[3])],
        ["Running Slope", "N/A", "N/A", "> 8.3%", fmt(rs[0]), "5% - 8.3%", fmt(rs[1]), "< 5%", fmt(rs[2])],
        running ? ["Cross Slope", "N/A", "N/A", "> 8.3%", fmt(cs[0]), "5% - 8.3%", fmt(cs[1]), "< 5%", fmt(cs[2])]
          : ["Cross Slope", "> 5.0%", fmt(cs[0]), "3.0% - 5.0%", fmt(cs[1]), "2.08% - 3%", fmt(cs[2]), "< 2.08%", fmt(cs[3])]] };
    };
    out[4] = sigTable("yield_or_stop_control_device", false); out[5] = sigTable("traffic_control_signal", true);
    out[6] = sigTable("uncontrolled", true); out[7] = sigTable("midblock_or_roundabout", true);
    const noType = new Set(rows.filter((r) => !r.sig && r.id != null).map((r) => r.id)).size;
    if (noType) notes.push(`${fmt(noType)} crosswalks have no signal type, so they are not in Tables 4–7.`);
  }
  // ---- curb ramps: Table 8 (slopes / widths) and Table 9 (score)
  const CL = (G.curbRamps || [])[0];
  if (CL && needs(8, 9)) {
    onStatus("Tables 8–9: reading curb ramps…");
    const pick = (...a) => a.map((x) => fieldBy(CL, x));
    const cross = pick("Right Ramp Cross Slope (%)", "Left Ramp Cross Slope (%)", "Center Ramp Cross Slope (%)");
    const run = pick("Right Ramp Running Slope (%)", "Left Ramp Running Slope (%)", "Center Ramp Running Slope (%)");
    const width = pick("Right Ramp Width (IN.)", "Left Ramp Width (IN.)", "Center Ramp Width (IN.)");
    const ts = pick("Turning Space Cross Slope (%)", "Turning Space Running Slope (%)");
    const sf9 = scoreFields(CL);
    const attrs = await layerAttrs(deps, CL, [...cross, ...run, ...width, ...ts, sf9.rai, sf9.dcs]);
    const S9 = pickScore(sf9, attrs, "curb ramp", 9), dcsF = S9.f;
    const max = (a, fs) => { const v = fs.filter(Boolean).map((f) => Math.abs(num0(a[f]))).filter((x) => !Number.isNaN(x)); return v.length ? Math.max(...v) : NaN; };
    const crossBin = (v) => (Number.isNaN(v) ? null : v < 2.08 ? 3 : v < 3 ? 2 : v < 5 ? 1 : 0);
    const runBin = (v) => (Number.isNaN(v) ? null : v < 8.3 ? 3 : v < 8.6 ? 2 : v < 9 ? 1 : 0);
    const c = { x: [0, 0, 0, 0], r: [0, 0, 0, 0], w: [0, 0, 0, 0], t: [0, 0, 0, 0] }, sc = { "0-40": 0, "41-70": 0, "71-99": 0, "100": 0 };
    let unscored = 0;
    for (const a of attrs) {
      let b = crossBin(max(a, cross)); if (b !== null) c.x[b]++;
      b = runBin(max(a, run)); if (b !== null) c.r[b]++;
      const ws = width.filter(Boolean).map((f) => num0(a[f])).filter((x) => !Number.isNaN(x)), w = ws.length ? Math.min(...ws) : NaN;
      c.w[Number.isNaN(w) || w <= 32 ? 0 : w < 36 ? 1 : w < 48 ? 2 : 3]++;
      b = crossBin(max(a, ts)); if (b !== null) c.t[b]++;
      const s = scoreBin(num0(a[dcsF])); if (s) sc[s]++; else unscored++;
    }
    out[8] = { header: [...TABLE_TEMPLATES[8].header], rows: [
      ["Cross Slope", "> 5.0%", fmt(c.x[0]), "3% - 5%", fmt(c.x[1]), "2.08% - 3%", fmt(c.x[2]), "< 2.08%", fmt(c.x[3])],
      ["Running Slope", "> 9.0%", fmt(c.r[0]), "8.6% - 9%", fmt(c.r[1]), "8.3% - 8.6%", fmt(c.r[2]), "< 8.3%", fmt(c.r[3])],
      ["Width", '< 32"', fmt(c.w[0]), '32"-36"', fmt(c.w[1]), '36" - 48"', fmt(c.w[2]), '> 48"', fmt(c.w[3])],
      ["Turning Space Slope", "> 5.0%", fmt(c.t[0]), "3% - 5%", fmt(c.t[1]), "2.08% - 3%", fmt(c.t[2]), "< 2.08%", fmt(c.t[3])]] };
    if (scoreBy) out[9] = { header: [...TABLE_TEMPLATES[9].header], rows: [[LABEL[S9.SN], "0-40", fmt(sc["0-40"]), "41-70", fmt(sc["41-70"]), "71-99", fmt(sc["71-99"]), "100", fmt(sc["100"])]] };
    if (scoreBy && !dcsF) notes.push("The curb ramp layer has no RAI or DCS score field, so Table 9 is empty.");
    else if (scoreBy && unscored) notes.push(`${fmt(unscored)} curb ramps have no ${S9.SN} score, so they are not in Table 9.`);
  }
  // ---- transit stops: Table 10, from the nearest sidewalk slab's travel path width and cross slope
  const TL = (G.transit || [])[0], SL = (G.sidewalks || [])[0];
  if (TL && SL && needs(10)) {
    onStatus("Table 10: matching transit stops to the nearest sidewalk…");
    const wF = fieldBy(SL, "Travel Path Width (IN.)"), xF = fieldBy(SL, "Cross Slope (%)");
    const wb = [0, 0, 0, 0], sb = [0, 0, 0, 0];
    let unmatched = 0;
    for (const f of TL.features) {
      const g = f.geometry, pt = g.x !== undefined ? [g.x, g.y] : null; if (!pt) continue;
      const r = await deps.fetchJson(`${SL.url}/query`, { geometry: JSON.stringify({ x: pt[0], y: pt[1], spatialReference: { wkid: 3857 } }), geometryType: "esriGeometryPoint", inSR: "3857",
        distance: 30, units: "esriSRUnit_Meter", spatialRel: "esriSpatialRelIntersects", outFields: [wF, xF].filter(Boolean).join(","), returnGeometry: "true", outSR: "3857" });
      let best = null, bd = Infinity;
      for (const s of r.features || []) for (const ring of (s.geometry || {}).rings || []) for (const p of ring) { const d = (p[0] - pt[0]) ** 2 + (p[1] - pt[1]) ** 2; if (d < bd) { bd = d; best = s; } }
      if (!best) unmatched++;
      const w = best ? num0(best.attributes[wF]) : NaN, x = best ? Math.abs(num0(best.attributes[xF])) : NaN;
      const wi = Number.isNaN(w) || w < 48 ? 0 : w <= 84 ? 1 : w >= 84.01 && w <= 96 ? 2 : w > 96.01 ? 3 : null; if (wi !== null) wb[wi]++;
      const si = Number.isNaN(x) ? null : x < 2.08 ? 3 : x <= 3 ? 2 : x <= 5 ? 1 : 0; if (si !== null) sb[si]++;
    }
    out[10] = { header: [...TABLE_TEMPLATES[10].header], rows: [
      ["Boarding/Alighting Depth", '< 48" or missing', fmt(wb[0]), '48" - 84"', fmt(wb[1]), '84.01" - 96"', fmt(wb[2]), '>96"', fmt(wb[3])],
      ["Boarding/Alighting Slope", ">5.0%", fmt(sb[0]), "3.0%-5.0%", fmt(sb[1]), "2.08%-3.0%", fmt(sb[2]), "<2.08%", fmt(sb[3])]] };
    if (unmatched) notes.push(`${fmt(unmatched)} transit stops have no sidewalk within 30 m; they count as "< 48 in or missing" in Table 10.`);
  }
  return { tables: out, notes };
}

// ---------------------------------------------------------------- PDF helpers
function makeDoc(deps) {
  const doc = new deps.jsPDF({ orientation: "portrait", unit: "pt", format: "letter", compress: true });
  const F = deps.reportFonts;
  for (const [name, b64] of [["MontB", F.montB], ["MontSB", F.montSB], ["PopL", F.popL], ["Pop", F.pop], ["PopM", F.popM], ["PopSB", F.popSB]]) {
    doc.addFileToVFS(`${name}.ttf`, b64); doc.addFont(`${name}.ttf`, name, "normal");
  }
  return doc;
}

// break opportunities: spaces, and after "-" or "/" (so "As-Built" -> "As-" "Built", "Boarding/Alighting" -> "Boarding/" "Alighting")
const pieces = (s) => String(s).replace(/(^|\s)([<>≤≥]) (?=\S)/g, "$1$2\u00A0").split(/([ \t\n]+)/).flatMap((w) => (/^[ \t\n]+$/.test(w) ? [w] : w.split(/(?<=[-/])(?=.)/)));

function writer(doc) {
  const font = (name, size, color = C.body) => { doc.setFont(name, "normal"); doc.setFontSize(size); doc.setTextColor(...color); };
  const text = (s, x, y, name, size, color, opts = {}) => { font(name, size, color); doc.text(String(s), x, y, { baseline: "alphabetic", ...opts }); };
  const tw = (s, name, size) => { font(name, size); return doc.getTextWidth(String(s)); };
  // wrap to width w -> lines (never splits inside a piece unless it alone is too wide)
  const wrap = (s, name, size, w) => {
    const lines = []; let cur = "";
    for (const p of pieces(s)) {
      if (/^[ \t\n]+$/.test(p)) { if (cur) cur += " "; continue; }
      if (cur && tw(cur + p, name, size) > w) { lines.push(cur.trim()); cur = p; } else cur += p;
    }
    if (cur.trim()) lines.push(cur.trim());
    return lines.length ? lines : [""];
  };
  // rich paragraph: segments [{t, b}] wrapped to width w; returns the baseline of the last line
  const para = (segs, x, y, w, size = 11, lead = 16, color = C.body, boldFont = "PopSB", regFont = "Pop") => {
    if (typeof segs === "string") segs = [{ t: segs }];
    const words = [];
    for (const s of segs) for (const wd of String(s.t).split(/(\s+)/)) if (wd) words.push({ t: wd, b: !!s.b, sp: /^\s+$/.test(wd) });
    let line = [], lw = 0, cy = y;
    const width = (wd) => tw(wd.sp ? " " : wd.t, wd.b ? boldFont : regFont, size);
    const flush = () => {
      while (line.length && line[line.length - 1].sp) line.pop();
      let cx = x; for (const wd of line) { text(wd.sp ? " " : wd.t, cx, cy, wd.b ? boldFont : regFont, size, color); cx += width(wd); }
      line = []; lw = 0; cy += lead;
    };
    for (const wd of words) {
      const ww = width(wd);
      if (!wd.sp && lw + ww > w && line.length) flush();
      if (wd.sp && !line.length) continue;
      line.push(wd); lw += ww;
    }
    if (line.length) flush();
    return cy - lead;
  };
  const lines = (s, w, size = 11) => wrap(s, "Pop", size, w).length;
  const dotted = (x0, y0, x1, y1) => {
    doc.setLineDashPattern([0.7, 1.6], 0); doc.setDrawColor(...C.dots); doc.setLineWidth(0.7);
    doc.line(x0, y0, x1, y1); doc.setLineDashPattern([], 0);
  };
  return { font, text, tw, wrap, para, lines, dotted };
}

const img = (doc, a, x, y, w, h) => doc.addImage(a.data, a.type, x, y, w, h ?? (w * a.h) / a.w, undefined, "FAST");

function pageChrome(doc, W, section, pageNo, place, assets) {
  if (section) {
    const s = SECTION[section];
    W.text(s.label, 558, 31.7, "PopL", 8, C.heading, { align: "right" });
    doc.setFillColor(...s.color); doc.roundedRect(567, 24.5, 60, 8, 4, 4, "F");
  }
  doc.setFillColor(...C.footer); doc.rect(0, 720, PW, 72, "F");
  doc.setCharSpace(0.35);
  W.text(String(pageNo), ML, 755.3, "PopL", 8, C.white);
  W.text(`Public Rights-of-Way Evaluation Data  |  ${place}`, ML + 21, 755.3, "PopL", 8, C.white);
  W.text("Find out more at", 397.9, 755.4, "PopL", 8, C.white);
  W.text("DAXBOT.COM", 475.6, 755.4, "PopSB", 8, C.white);
  doc.setCharSpace(0);
  img(doc, assets.mark, 543, 743, 29);
}

// ---------------------------------------------------------------- tables in the PDF
// draws (or with opts.dry only measures) a table; returns the y of its bottom edge
function drawTable(doc, W, t, x, y, w, opts = {}) {
  const ncol = t.header.length, pad = 4, hs = opts.headSize || 10, cs = 9, hLead = 12, cLead = 11;
  const headFont = opts.headFont || "MontSB", firstW = opts.firstW ?? 66.6;
  const head = (h) => (opts.upper ? String(h).toUpperCase() : String(h));
  // column widths: ideally every cell on one line (headers may wrap between words); never narrower than
  // the widest unbreakable piece; whatever is left over is shared evenly
  const minW = [], wantW = [];
  t.header.forEach((h, i) => {
    if (i === 0) { minW.push(firstW); wantW.push(firstW); return; }
    const hp = Math.max(...pieces(head(h)).map((p) => W.tw(p.trim(), headFont, hs)));
    let lo = hp, hi = hp;
    for (const r of t.rows) { const c = String(r[i] ?? ""); lo = Math.max(lo, ...pieces(c).map((p) => W.tw(p.trim(), "PopM", cs))); hi = Math.max(hi, W.tw(c, "PopM", cs)); }
    minW.push(lo + pad * 2); wantW.push(hi + pad * 2);
  });
  const sMin = minW.reduce((a, b) => a + b, 0), sWant = wantW.reduce((a, b) => a + b, 0);
  let cols;
  if (sWant <= w) cols = wantW.map((c, i) => (i === 0 ? c : c + (w - sWant) / (ncol - 1)));
  else if (sMin <= w) { const k = (w - sMin) / (sWant - sMin); cols = minW.map((c, i) => c + k * (wantW[i] - c)); }
  else { const k = (w - firstW) / (sMin - firstW); cols = minW.map((c, i) => (i === 0 ? c : c * k)); }
  const xs = cols.reduce((a, c) => (a.push(a[a.length - 1] + c), a), [x]);
  const headLines = t.header.map((h, i) => W.wrap(head(h), headFont, hs, cols[i] - pad * 2));
  const hh = Math.max(opts.headH || 0, Math.max(...headLines.map((l) => l.length)) * hLead + 14);
  const rowLines = t.rows.map((r) => r.map((c, i) => W.wrap(c ?? "", "PopM", cs, cols[i] - pad * 2)));
  const rowH = rowLines.map((cells) => Math.max(opts.rowH || 0, Math.max(...cells.map((l) => l.length)) * cLead + 14));
  const bottom = y + hh + rowH.reduce((a, b) => a + b, 0);
  if (opts.dry) return bottom;
  doc.setFillColor(...C.tblHead); doc.rect(x, y, w, hh, "F");
  headLines.forEach((ls, i) => {
    const y0 = y + hh / 2 - ((ls.length - 1) * hLead) / 2 + hs * 0.36;
    ls.forEach((ln, k) => W.text(ln, i === 0 && opts.leftFirst ? xs[0] + pad + 1 : xs[i] + cols[i] / 2, y0 + k * hLead, headFont, hs, C.white, { align: i === 0 && opts.leftFirst ? "left" : "center" }));
  });
  let cy = y + hh;
  rowLines.forEach((cells, r) => {
    const rh = rowH[r];
    if (opts.tint !== false) for (let i = 1; i < ncol; i++) if (((i - 1) >> 1) % 2 === 0) { doc.setFillColor(...C.tint); doc.rect(xs[i], cy, cols[i], rh, "F"); }
    cells.forEach((ls, i) => {
      const y0 = cy + rh / 2 - ((ls.length - 1) * cLead) / 2 + cs * 0.36;
      const left = i === 0 || opts.leftAll;
      ls.forEach((ln, k) => W.text(ln, left ? xs[i] + pad : xs[i] + cols[i] / 2, y0 + k * cLead, i === 0 && opts.regularFirst ? "Pop" : "PopM", cs, C.body, { align: left ? "left" : "center" }));
    });
    if (opts.vsep !== false) for (let i = 1; i < ncol; i++) W.dotted(xs[i], cy, xs[i], cy + rh);
    cy += rh; W.dotted(x, cy, x + w, cy);
  });
  return cy;
}

// ---------------------------------------------------------------- maps in the PDF
const FIG_BELOW = 60;   // date / legend / scale bars under a map frame (pt)
// prepared map: { jpeg, entries, groundW, aspect, attribution } drawn as a framed figure
async function drawMapFigure(deps, doc, W, m, x, y, w, opts = {}) {
  const h = w / m.aspect;
  doc.addImage(m.jpeg, "JPEG", x, y, w, h, undefined, "FAST");
  doc.setDrawColor(0); doc.setLineWidth(0.9); doc.rect(x, y, w, h);
  if (opts.north) {
    const nx = x + w - 15, ny = y + 13;
    doc.setFillColor(0); doc.rect(nx - 0.45, ny + 4, 0.9, 11, "F"); doc.triangle(nx - 2.6, ny + 5.5, nx + 2.6, ny + 5.5, nx, ny, "F");
    W.text("N", nx, ny + 24, "PopSB", 5.5, [0, 0, 0], { align: "center" });
  }
  if (opts.bare) return y + h;
  const ratio = Math.round(m.groundW / ((w / 72) * 0.0254));
  W.text(opts.date, x, y + h + 13, "Pop", 6.9, [0, 0, 0]);
  W.text(`1:${ratio.toLocaleString("en-US")}`, x + w * 0.79, y + h + 13, "Pop", 6.9, [0, 0, 0]);
  for (let i = 0; i < m.entries.length; i++) {
    const e = m.entries[i], col = Math.floor(i / 4), row = i % 4, lx = x + col * 79.5, ly = y + h + 21.5 + row * 11.5, sw = 8;
    if (e.kind === "icon") {
      const s = 7.5, ar = e.img.height / e.img.width;
      if (!e.png) { const c = deps.createCanvas(e.img.width, e.img.height); c.getContext("2d").drawImage(e.img, 0, 0); e.png = await deps.toPng(c); }
      doc.addImage(e.png, "PNG", lx + sw / 2 - s / 2, ly - (s * ar) / 2, s, s * ar);
    } else if (e.kind === "marker") {
      doc.setFillColor(...e.color.slice(0, 3)); doc.setDrawColor(0); doc.setLineWidth(0.3); doc.circle(lx + sw / 2, ly, 2.6, "FD");
    } else if (e.kind === "line") {
      doc.setDrawColor(...e.color.slice(0, 3)); doc.setLineWidth(Math.max(e.lw, 1.2) * 0.6); doc.line(lx, ly, lx + sw, ly);
    } else if (e.kind === "swatch") {
      if (e.face) doc.setFillColor(...e.face.slice(0, 3)); doc.setDrawColor(...(e.edge || [0, 0, 0]).slice(0, 3)); doc.setLineWidth(0.4);
      doc.rect(lx, ly - 3.5, sw, 7, e.face ? "FD" : "S");
    } else if (e.kind === "ramp") {
      if (!e.png) {
        const gc = deps.createCanvas(64, 1), g = gc.getContext("2d");
        for (let k = 0; k < 64; k++) { g.fillStyle = css(rampColor(e.ramp, e.vmin + (k / 63) * (e.vmax - e.vmin), false)); g.fillRect(k, 0, 1, 1); }
        e.png = await deps.toPng(gc);
      }
      doc.addImage(e.png, "PNG", lx, ly - 3.5, sw, 7);
    }
    const label = e.kind === "ramp" ? `${e.label} (${fmtNum(e.vmin)}–${fmtNum(e.vmax)})` : e.label;
    W.text(String(label).slice(0, 26 + (e.kind === "ramp" ? 10 : 0)), lx + 13, ly + 1.6, "Pop", 4.4, [0, 0, 0]);
  }
  const bar = (by, totalM, div, unit, above) => {
    const segs = 4, bw = (totalM / m.groundW) * w, seg = bw / segs, bx = x + w * 0.63;
    doc.setLineWidth(0.5); doc.setDrawColor(0);
    for (let i = 0; i < segs; i++) { doc.setFillColor(i % 2 ? 255 : 0); doc.rect(bx + seg * i, by, seg, 3.3, "FD"); }
    for (let i = 0; i <= segs; i++) W.text(fmtNum((totalM * i / segs) / div), bx + seg * i, above ? by - 2.2 : by + 8.2, "Pop", 4.1, [0, 0, 0], { align: "center" });
    W.text(unit, bx + bw + 4, by + 3, "Pop", 5, [0, 0, 0]);
  };
  const target = 0.17 * m.groundW;
  bar(y + h + 22, niceRound(target), 1000, "km", true);
  bar(y + h + 36, niceRound(target / 1609.344) * 1609.344, 1609.344, "mi", false);
  W.text(`Basemap: ${m.attribution}`, x + w, y + h + 54, "Pop", 3.76, [89, 89, 89], { align: "right" });
  return y + h + FIG_BELOW;
}

function shadowBox(doc, x, y, w, h) {
  doc.saveGraphicsState();
  for (const [o, a] of [[3.5, 0.05], [2.5, 0.07], [1.5, 0.09]]) { doc.setGState(new doc.GState({ opacity: a })); doc.setFillColor(0, 0, 0); doc.rect(x + o, y + o, w, h, "F"); }
  doc.restoreGraphicsState();
}

// ---------------------------------------------------------------- report
const BOTTOM = 712;   // lowest y content may reach (footer band starts at 720)

export async function buildFullReport(deps, data, input, onStatus = () => {}) {
  const { fields: f, tables, include, insets = {}, uploads = {}, texts } = input;
  const on = (id) => include.includes(id);
  const doc = makeDoc(deps), W = writer(doc), A = deps.assets;
  const date = f.date || new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  const city = f.city || "", heading = f.shortName || city.split(",")[0] || "";
  let pageNo = 0, tableNo = 0;
  const newPage = (section) => { if (pageNo++ > 0) doc.addPage("letter", "portrait"); doc.setFillColor(255, 255, 255); doc.rect(0, 0, PW, PH, "F"); if (pageNo > 1) pageChrome(doc, W, section, pageNo, city, A); };
  const h1 = (s, y = 75.3, size = 18) => W.text(s, ML, y, "MontB", size, C.heading);
  const h2 = (s, y, fontName = "MontSB") => W.text(s, ML, y, fontName, 13, C.heading);
  const centered = (s, y, size = 13) => W.text(s, PW / 2, y, "MontB", size, C.heading, { align: "center" });
  const tableH = (n) => (tables[n] && tables[n].rows.length ? drawTable(doc, W, tables[n], ML, 0, CW, { dry: true }) : 0);
  const table = (n, y) => { tableNo++; return drawTable(doc, W, tables[n], ML, y, CW); };
  const has = (n) => tableHasData(tables[n]);
  const caption = (n, s, y) => W.para([{ t: `Table ${n}:`, b: true }, { t: ` ${s}` }], ML, y, CW);
  const captionH = (s) => W.lines(`Table 10: ${s}`, CW) * 16;

  // map images share one extent and one basemap (same as the landscape PDFs, shrunk the way InDesign placed them)
  // per-layer icon sizes (same meaning as on the Map PDFs tab; the report shows those maps at ~60% size)
  if (input.iconOverrides) data.iconOverrides = input.iconOverrides;
  if (input.layerOrder) data.layerOrder = input.layerOrder;
  const mapW = 2000, mapH = Math.round(mapW / MAP_ASPECT), baseCfg = cfgFor({ basemap: "topo", iconOverrides: data.iconOverrides, ...orderCfg(data) });
  // map and inset images are cached on `data` (keyed by everything that changes them), so a rebuild after
  // a text / table edit only re-assembles the PDF — that is what makes the live preview quick
  const remember = (cache, key, max, make) => {
    if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
    const v = make(); cache.set(key, v);
    while (cache.size > max) cache.delete(cache.keys().next().value);
    v.catch(() => cache.delete(key));
    return v;
  };
  data.mapCache = data.mapCache || new Map(); data.insetCache = data.insetCache || new Map();
  const iconsKey = JSON.stringify([data.iconOverrides || {}, data.layerOrder || null]);
  const prepMap = (key, ls, solo) => remember(data.mapCache, `${key}|${solo}|${ls.map((l) => l.url).join(",")}|${iconsKey}`, 24, async () => {
    onStatus(`Drawing ${key} map…`);
    const base = await basemapFor(deps, data, baseCfg, data.ext, mapW, mapH);
    const r = await renderMapImage(deps, baseCfg, ordered(data, ls), data.ext, base, mapW, mapH, LANDSCAPE_FRAME_IN, solo);
    return { jpeg: await deps.toJpeg(r.canvas, 0.85), entries: r.entries, groundW: r.groundW, aspect: MAP_ASPECT, attribution: base.attribution };
  });
  const insetImage = (slot, wPt, hPt) => {
    if (uploads[slot]) return Promise.resolve(uploads[slot]);
    const ins = insets[slot] || defaultInset(data, slot), pop = slot === "crosswalk" ? input.popup || null : null;
    return remember(data.insetCache, `${slot}|${JSON.stringify(ins)}|${JSON.stringify(pop)}|${iconsKey}|${wPt}x${hPt}`, 9, async () => {
      onStatus(`Drawing ${INSETS[slot].label.toLowerCase()}…`);
      const Wpx = Math.round((wPt / 72) * 300), Hpx = Math.round((hPt / 72) * 300);
      const pp = pop && pop.oid != null ? await loadPopup(deps, data, slot, pop.oid, pop.fields || []) : null;
      const cv = await renderInset(deps, data, slot, ins, Wpx, Hpx, wPt / 72, pp);
      return { data: await deps.toJpeg(cv, 0.88), type: "JPEG", w: Wpx, h: Hpx };
    });
  };
  // widest map (<= maxW) that leaves room for what follows it on the page
  const fitW = (maxW, top, after) => Math.min(maxW, (BOTTOM - top - FIG_BELOW - after) * MAP_ASPECT);
  const G = data.groups;
  const CAP = {
    1: "Feet of sidewalk to be brought up to PROWAG standard in each phase of repair, starting with panels that present the greatest hazard and going to panels that present less hazard, by DCS.",
    2: "We broke sidewalk segments into categories based on the defects present. Categories list sidewalk by feet surveyed from least to most compliant, going from left to right.",
    8: "We broke curb ramps into categories based on the defects present. Categories list curb ramps from least to most compliant, going from left to right.",
    9: "Curb ramps to be brought up to PROWAG standard in each phase of repair, starting with curb ramps that present the greatest hazard and going to curb ramps that present less hazard, by DCS.",
    10: "Transit stops to be brought up to PROWAG standard in each phase of repair, starting with transit stops that present the greatest hazard and going to transit stops that present the fewest barriers to access.",
  };
  // a map figure followed by "Table N[: title]", the table and (optionally) its caption
  const mapAndTable = async ({ top, maxW, m, n, title, cap, north, inset }) => {
    const after = has(n) ? 37 + tableH(n) + (cap ? 14 + captionH(CAP[n]) : 0) : 0;
    const w = fitW(maxW, top, after), x = (PW - w) / 2 + (inset === "overview" ? -14 : 0);
    let y = await drawMapFigure(deps, doc, W, m, x, top, w, { date, north });
    if (inset) await placeInset(inset, x, top, w);
    if (!has(n)) return;
    h2(`Table ${tableNo + 1}${title ? `: ${title}` : ""}`, y + 26);
    y = table(n, y + 37);
    if (cap) caption(tableNo, CAP[n], y + 22);
  };
  const placeInset = async (slot, x, top, w) => {
    if (slot === "overview") {
      const iw = 157, ih = 99, ix = Math.min(x + w - 103, PW - iw - 29), iy = top;
      shadowBox(doc, ix, iy, iw, ih); img(doc, await insetImage("overview", iw, ih), ix, iy, iw, ih);
      W.text("Map", ix + iw - 46, iy + ih + 13, "PopL", 9, C.heading); W.text("Details", ix + iw - 46, iy + ih + 23.8, "PopL", 9, C.heading);
    } else {
      const iw = 100, ih = 96, ix = x + w - iw - 4, iy = top + 5;
      shadowBox(doc, ix, iy, iw, ih); img(doc, await insetImage("sidewalk", iw, ih), ix, iy, iw, ih);
      ["Sidewalk", "Panel", "Details"].forEach((s, k) => W.text(s, x + w + 14, iy + 26 + k * 10.8, "PopL", 9, C.heading));
    }
  };

  // ---- cover
  if (on("cover")) {
    newPage(null);
    img(doc, A.cover, 0, 0, PW, 501);
    doc.setFillColor(...C.stripe); doc.rect(0, 501, PW, 18, "F");
    doc.setFillColor(...C.coverBand); doc.rect(0, 519, PW, PH - 519, "F");
    img(doc, A.logo, ML, 54, 151);
    W.text("Public Rights-of-Way", ML, 585.4, "MontB", 35, C.white);
    W.text("Evaluation Data", ML, 626.8, "MontB", 35, C.white);
    const sub = `${f.coverName || city} (${f.year || new Date().getFullYear()})`;
    W.text(sub, ML, 654.9, "PopM", Math.min(23.35, 23.35 * 470 / W.tw(sub, "PopM", 23.35)), C.white);
    W.text("+1 541-360-0900  |  info@daxbot.com", ML, 739.3, "Pop", 11, C.white);
    W.text("556 N. 19th St., Philomath, OR 97370", ML, 755.3, "Pop", 11, C.white);
    W.text("www.daxbot.com", ML, 771.3, "Pop", 11, C.white);
  }

  // ---- overview
  if (on("overview")) {
    newPage("overview");
    h1("OVERVIEW", 75.3, 22);
    let y = W.para(texts.overview, ML, 109.3, 475) + 49.2;
    const items = [];
    if (on("overviewMap") || on("sidewalkMap")) items.push([A.iconSidewalks, "Sidewalks", `We scored sidewalk sections with a Dax Compliance Score (DCS) ranging from 0 to 100 based on running and cross slopes, uplifts, cracking, fixed obstructions, and other impediments to access. Daxbot evaluated ${f.miles || "—"} miles of sidewalk for this report.`, 28]);
    if (on("crosswalkMap") || on("crosswalkDetails")) items.push([A.iconCrosswalks, "Crosswalks", "We evaluated crosswalks for slope, intersection type, and whether striping was used to mark crosswalk locations.", 32]);
    if (on("curbMap") || on("curbPhasing")) items.push([A.iconCurbramps, "Curb Ramps", `We scored curb ramps with a Dax Compliance Score (DCS) ranging from 0 to 100 based on attributes such as cross slopes, running slopes, clear width, obstructions, and the presence of detectable warnings. For this report, we evaluated ${f.ramps || "—"} curb ramps.`, 47]);
    if (on("transit")) items.push([A.iconTransit, "Transit Stops", "We evaluated transit stop boarding areas for correct depth and slope.", 37]);
    for (const [icon, title, body, iw] of items) {
      img(doc, icon, 87 - iw / 2, y - 16, iw);
      W.text(title, 123.6, y, "MontSB", 16, C.heading);
      y = W.para(body, 123.6, y + 16, 412) + 32.7;
    }
  }

  // ---- data reliability
  if (on("reliability")) {
    newPage(null);
    h1("Data Reliability", 75.3, 22);
    W.para(texts.reliability, ML, 109.3, 475);
    if (tables.reliability) drawTable(doc, W, tables.reliability, ML, 234.5, 484, { tint: false, vsep: false, upper: true, headFont: "MontB", headSize: 9.5, firstW: 120, rowH: 31.5, headH: 23, regularFirst: true });
    W.text("*Binomial proportion confidence interval", ML, 535.6, "Pop", 9, C.body);
    img(doc, A.cone, 0, 546, PW, 174);
  }

  // ---- overview map + Table 1
  if (on("overviewMap")) {
    newPage("sidewalk");
    h1(`${heading} Public Rights-of-Way Overview`);
    const y = W.para(texts.overviewMap, ML, 107.1, 475) + 33;
    centered("Overview Map", y);
    await mapAndTable({ top: y + 5, maxW: 472, m: await prepMap("overview", data.layers, false), n: 1, cap: true, inset: "overview" });
  }

  // ---- sidewalk DCS map + Table 2
  if (on("sidewalkMap") && G.sidewalks.length) {
    newPage("sidewalk");
    W.para([{ t: "The sidewalk DCS Map", b: true }, { t: " below shows sidewalk panels by DCS." }], ML, 75.3, 475);
    centered("Sidewalk DCS Map", 116);
    await mapAndTable({ top: 125, maxW: 452, m: await prepMap("sidewalk", G.sidewalks, true), n: 2, cap: true, inset: "sidewalk" });
  }

  // ---- crosswalks
  const XT = { 4: "Yield or Stop Control Device", 5: "Traffic Control Signal", 6: "Uncontrolled", 7: "Midblock or Roundabout" };
  if (on("crosswalkMap") && G.crosswalks.length) {
    newPage("crosswalk");
    h1(`${heading} Crosswalks Overview`);
    centered("Crosswalks Map", 104.5);
    await mapAndTable({ top: 117, maxW: 476, m: await prepMap("crosswalk", G.crosswalks, true), n: 3, title: "Crosswalks by Compliance Score", north: true });
  }
  if (on("crosswalkDetails")) {
    newPage("crosswalk");
    centered("Crosswalk Details", 66.6);
    img(doc, await insetImage("crosswalk", 500, 270), ML, 82, 500, 270);
    let y = 352;
    const fitsHere = [4, 5, 6, 7].filter(has);
    let k = 0;
    for (; k < fitsHere.length; k++) {
      const n = fitsHere[k], need = 24 + tableH(n);
      if (y + need > BOTTOM) break;
      W.text(`Table ${tableNo + 1}: ${XT[n]}`, ML, y + 24, "MontB", 13, C.heading); y = table(n, y + 34) + 4;
    }
    if (k < fitsHere.length) {
      newPage("crosswalk"); y = 40;
      for (; k < fitsHere.length; k++) {
        const n = fitsHere[k];
        if (y + 34 + tableH(n) > BOTTOM) { newPage("crosswalk"); y = 40; }
        W.text(`Table ${tableNo + 1}: ${XT[n]}`, ML, y + 24, "MontB", 13, C.heading); y = table(n, y + 34) + 30;
      }
    }
  }

  // ---- curb ramps
  if (on("curbMap") && G.curbRamps.length) {
    newPage("curb");
    h1(`${heading} Curb Ramp Overview`);
    W.text("Curb Ramps Map", PW / 2, 97, "MontSB", 13, C.heading, { align: "center" });
    await mapAndTable({ top: 110, maxW: 434, m: await prepMap("curb", G.curbRamps, true), n: 8, cap: true, north: true });
  }
  if (on("curbPhasing") && has(9)) {
    newPage("curb");
    W.text(`Table ${tableNo + 1}: Curb Ramp Phasing by DCS`, ML, 78, "MontB", 13, C.heading);
    const y = table(9, 90);
    caption(tableNo, CAP[9], y + 22);
  }

  // ---- pedestrian refuge islands / signals: one page; the second map is frame-only, as in the original
  const pedMaps = [["refuge", "Pedestrian Refuge Islands", G.refuge], ["signals", "Pedestrian Signals", G.signals]].filter(([id, , ls]) => on(id) && ls.length);
  if (pedMaps.length) {
    newPage("ped");
    const both = pedMaps.length === 2, w = both ? 424 : 470, x = (PW - w) / 2;
    centered(pedMaps[0][1], 66.6);
    let y = await drawMapFigure(deps, doc, W, await prepMap(pedMaps[0][0], pedMaps[0][2], true), x, 80, w, { date, north: true });
    if (both) {
      centered(pedMaps[1][1], 406);
      await drawMapFigure(deps, doc, W, await prepMap(pedMaps[1][0], pedMaps[1][2], true), x, 420, w, { north: true, bare: true });
    }
    if (pedMaps.some(([id]) => id === "signals")) W.text("Pedestrian signal locations were recorded as shown above.", ML, both ? 705.6 : y + 20, "Pop", 11, C.body);
  }

  // ---- transit
  if (on("transit") && G.transit.length) {
    newPage("transit");
    h1(`${heading} Transit Stop Overview`);
    W.text("Transit Stop Boarding Areas", PW / 2, 113, "MontSB", 13, C.heading, { align: "center" });
    await mapAndTable({ top: 136, maxW: 426, m: await prepMap("transit", G.transit, true), n: 10, title: "Transit Stop Boarding Areas Overview", cap: true, north: true });
  }

  if (!pageNo) throw new Error("No pages selected.");
  onStatus(`Done: ${pageNo} pages.`);
  return doc.output("arraybuffer");
}
