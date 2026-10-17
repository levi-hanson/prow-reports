// PROW report renderer — a JavaScript port of prow_report.py.
//
// Given a web map item id it pulls every operational layer and its AGOL styling,
// downloads the features, and renders one combined map + one map per layer, each
// as a landscape PDF page (framed map, title, date, legend, scale bars, north arrow,
// attribution). Everything inside the map frame is flattened into ONE image (no
// per-icon objects) and fonts are embedded TrueType, so InDesign handles the files.
//
// Environment-agnostic: the caller supplies `deps` (browser or Node).
//   deps.fetchJson(url, params) -> object        (adds auth)
//   deps.createCanvas(w, h)     -> canvas with getContext('2d')
//   deps.loadImage(src)         -> image usable by drawImage (src = url or data: url)
//   deps.toJpeg(canvas, q)      -> Uint8Array of a JPEG
//   deps.jsPDF                  -> jsPDF constructor
//   deps.fonts                  -> { regular: base64 TTF, bold: base64 TTF }

export const DEFAULTS = {
  basemap: "topo",            // topo / imagery / streets / none
  basemapZoomAdjust: 1,       // same as prow_report.py (contextily zoom rule + 1)
  page: "letter",             // letter / tabloid / a3 (landscape)
  dpi: 300,                   // resolution of the flattened map image
  jpegQuality: 0.85,
  featureLw: 0.7,             // polygon outline weight (pt)
  iconScale: 0.3,             // point-icon size multiplier
  fixRamps0to100: true,       // DCS/RAI ramps pinned to 0-100
  reverseStack: false,
  date: null,                 // null = today, e.g. "11/04/2025"
  // Per-layer icon sizes (title, case-insensitive). overview = combined map,
  // solo = the layer's own page. *_pt = fixed size in points; plain = multiplier.
  iconOverrides: {
    "accessible on-street parking locations": { overview: 0.5, solo_pt: 9 },
    "pedestrian signals":                     { overview: 0.5, solo_pt: 9 },
    "transit stop boarding areas":            { solo_pt: 9 },
    "passenger loading zones":                { solo_pt: 9 },
    "pedestrian refuge islands":              { solo_pt: 9 },
    "curb ramps":                             { overview_pt: 1.8, solo_pt: 1.8 },
    "access barriers":                        { overview_pt: 1.8, solo_pt: 1.8 },
  },
};

const PAGE_SIZES = { letter: [11, 8.5], tabloid: [17, 11], a3: [16.54, 11.69] };
const BASEMAPS = {
  topo:    { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", attribution: "Esri, HERE, Garmin, USGS, NGA, EPA, USDA, NPS", maxZ: 19 },
  imagery: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", attribution: "Esri, Maxar, Earthstar Geographics", maxZ: 19 },
  gray:    { url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", attribution: "Esri, HERE, Garmin", maxZ: 16 },
  // light grey look that stays sharp past zoom 16 (where the grey canvas tiles stop): topo, desaturated and washed out
  lightTopo: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", attribution: "Esri, HERE, Garmin, USGS, NGA, EPA, USDA, NPS", maxZ: 19, wash: 0.42 },
  streets: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", attribution: "Esri, HERE, Garmin, USGS", maxZ: 19 },
};
const AX = { L: 0.025, B: 0.155, W: 0.95, H: 0.78 };   // map frame, figure fractions
const ORIGIN = 20037508.342789244;
const GREY = [153, 153, 153, 1];

// ---------------------------------------------------------------- colours / styles
export const esriColor = (a) => (Array.isArray(a) && a.length >= 3 ? [a[0], a[1], a[2], a.length > 3 ? a[3] / 255 : 1] : null);
export const css = (c, mult = 1) => (c ? `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 1) * mult})` : "rgba(0,0,0,0)");
const normValue = (v) => {
  if (v === null || v === undefined) return null;
  const f = Number(v);
  if (!Number.isNaN(f) && String(v).trim() !== "") return Number.isInteger(f) ? String(f) : String(f);
  return String(v).trim();
};

function fillStyle(sym) {
  const s = { face: [153, 153, 153, 1], edge: null, lw: 0 };
  if (!sym) return s;
  if (sym.type === "esriSFS" || sym.type === "esriPFS") {
    s.face = sym.style === "esriSFSNull" ? null : esriColor(sym.color);
    const o = sym.outline;
    if (o && o.style !== "esriSLSNull") { s.edge = esriColor(o.color); s.lw = Number(o.width ?? 0.4); }
  }
  return s;
}

function symbolResolver(r) {
  if (r.type === "uniqueValue") {
    const field = r.field1 || r.field;
    const lut = new Map((r.uniqueValueInfos || []).map((i) => [normValue(i.value), i.symbol]));
    return { field, resolve: (v) => lut.get(normValue(v)) ?? r.defaultSymbol };
  }
  if (r.type === "classBreaks") {
    const infos = r.classBreakInfos || [];
    return {
      field: r.field,
      resolve: (v) => {
        const x = Number(v);
        if (v === null || v === undefined || Number.isNaN(x)) return r.defaultSymbol;
        for (const i of infos) if (x <= (i.classMaxValue ?? Infinity)) return i.symbol;
        return r.defaultSymbol;
      },
    };
  }
  return { field: null, resolve: () => r.symbol };
}

function colorRamp(r) {
  for (const vv of r.visualVariables || []) {
    if (vv.type !== "colorInfo") continue;
    const stops = (vv.stops || []).filter((s) => esriColor(s.color)).map((s) => [s.value, esriColor(s.color)]).sort((a, b) => a[0] - b[0]);
    if (stops.length < 2) continue;
    const m = /\$feature[.\[]\s*['"]?([A-Za-z0-9_]+)/.exec(vv.valueExpression || r.valueExpression || "");
    return { field: vv.field || (m && m[1]) || r.field, stops };
  }
  return null;
}

export function rampColor(ramp, v, fixed) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return GREY;
  const s = ramp.stops, smin = s[0][0], smax = s[s.length - 1][0];
  let t = fixed ? (Math.min(Math.max(Number(v), 0), 100) / 100) : (Math.min(Math.max(Number(v), smin), smax) - smin) / ((smax - smin) || 1);
  const val = smin + t * (smax - smin);
  for (let k = 1; k < s.length; k++) {
    if (val <= s[k][0]) {
      const [v0, c0] = s[k - 1], [v1, c1] = s[k], f = (val - v0) / ((v1 - v0) || 1);
      return [0, 1, 2, 3].map((j) => (j < 3 ? Math.round(c0[j] + f * (c1[j] - c0[j])) : c0[3] + f * (c1[3] - c0[3])));
    }
  }
  return s[s.length - 1][1];
}

function sizeFromScale(r, mapScale, def) {
  for (const vv of r.visualVariables || []) {
    if (vv.type !== "sizeInfo" || !/scale/i.test(vv.valueExpression || "")) continue;
    const st = (vv.stops || []).filter((s) => s.value != null && s.size != null).map((s) => [s.value, s.size]).sort((a, b) => a[0] - b[0]);
    if (st.length === 1) return st[0][1];
    if (st.length >= 2) {
      if (mapScale <= st[0][0]) return st[0][1];
      if (mapScale >= st[st.length - 1][0]) return st[st.length - 1][1];
      for (let k = 1; k < st.length; k++) if (mapScale <= st[k][0]) {
        const [x0, y0] = st[k - 1], [x1, y1] = st[k]; return y0 + ((mapScale - x0) / ((x1 - x0) || 1)) * (y1 - y0);
      }
    }
  }
  return def;
}

const iconOverride = (cfg, title, solo) => cfg.iconOverrides[title.trim().toLowerCase()] || {};
const iconMult = (cfg, title, solo) => iconOverride(cfg, title, solo)[solo ? "solo" : "overview"] ?? 1;
const iconPt = (cfg, title, solo) => iconOverride(cfg, title, solo)[solo ? "solo_pt" : "overview_pt"] ?? null;

// ---------------------------------------------------------------- CIM point symbols
function cimPrims(ps) {
  const layers = [];
  for (const sl of ps.symbolLayers || []) {
    if (sl.type !== "CIMVectorMarker" || sl.enable === false) continue;
    const fr = sl.frame || {}, fh = ((fr.ymax ?? 1) - (fr.ymin ?? 0)) || 1;
    const cx = ((fr.xmin ?? 0) + (fr.xmax ?? 1)) / 2, cy = ((fr.ymin ?? 0) + (fr.ymax ?? 1)) / 2, sc = (sl.size || 10) / fh;
    const tf = (p) => [(p[0] - cx) * sc, (p[1] - cy) * sc];
    const prims = [];
    for (const mg of sl.markerGraphics || []) {
      const g = mg.geometry || {};
      let face = null, edge = null, ew = 0;
      for (const s of (mg.symbol || {}).symbolLayers || []) {
        const c = esriColor(s.color);
        if (s.type === "CIMSolidFill" && c) face = c;
        else if (s.type === "CIMSolidStroke" && c && c[3] > 0) { edge = c; ew = Number(s.width || 0); }
      }
      const rings = (g.rings || []).map((r) => r.filter((p) => Array.isArray(p) && p.length >= 2).map(tf)).filter((r) => r.length >= 3);
      if (rings.length) prims.push({ kind: "poly", rings, face, edge, ew });
      for (const p of g.paths || []) { const pts = p.filter((q) => Array.isArray(q)).map(tf); if (pts.length >= 2) prims.push({ kind: "line", pts, face: face || edge, edge, ew }); }
    }
    if (prims.length) layers.push(prims);
  }
  return layers;
}

function cimCanvas(deps, ps, px = 256) {
  const layers = cimPrims(ps);
  if (!layers.length) return null;
  const all = layers.flat().flatMap((p) => (p.kind === "poly" ? p.rings.flat() : p.pts));
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const half = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 || 1;
  const ccx = (Math.min(...xs) + Math.max(...xs)) / 2, ccy = (Math.min(...ys) + Math.max(...ys)) / 2, m = half * 0.06 + 1e-6;
  const span = 2 * (half + m), k = px / span;
  const cv = deps.createCanvas(px, px), ctx = cv.getContext("2d");
  const X = (p) => (p[0] - (ccx - half - m)) * k, Y = (p) => px - (p[1] - (ccy - half - m)) * k;
  const lwPx = (ew) => ew * (36 / half) * (px / 72);
  for (const prims of [...layers].reverse()) {
    for (const p of prims) {
      if (p.kind === "poly") {
        ctx.beginPath();
        for (const r of p.rings) { ctx.moveTo(X(r[0]), Y(r[0])); for (const q of r.slice(1)) ctx.lineTo(X(q), Y(q)); ctx.closePath(); }
        if (p.face) { ctx.fillStyle = css(p.face); ctx.fill("nonzero"); }
        if (p.edge) { ctx.strokeStyle = css(p.edge); ctx.lineWidth = lwPx(p.ew); ctx.stroke(); }
      } else {
        ctx.beginPath(); ctx.moveTo(X(p.pts[0]), Y(p.pts[0])); for (const q of p.pts.slice(1)) ctx.lineTo(X(q), Y(q));
        ctx.strokeStyle = css(p.edge || p.face); ctx.lineWidth = Math.max(lwPx(p.ew), 0.4 * px / 72); ctx.lineCap = "round"; ctx.stroke();
      }
    }
  }
  return cv;
}

// ---------------------------------------------------------------- data
function flatten(ops) { const out = []; for (const l of ops || []) { out.push(l); out.push(...flatten(l.layers || l.sublayers)); } return out; }

export const layerKey = (L) => `${L.title}|${L.url}`;
export const ALL_KEY = "__ALL__";

// default stacking, top of the map first (same rule renderPage uses without a layerOrder)
export function defaultOrder(layers) {
  const band = { point: 0, line: 1000, polygon: 2000 };
  return layers.map((L, i) => ({ L, z: band[geomKind(L)] + i })).sort((a, b) => b.z - a.z).map((o) => o.L);
}

export async function resolveLayers(deps, sharing, webmapId) {
  const item = await deps.fetchJson(`${sharing}/content/items/${webmapId}`, {});
  const data = await deps.fetchJson(`${sharing}/content/items/${webmapId}/data`, {});
  if (!data.operationalLayers) throw new Error("That item is not a web map.");
  const layers = [];
  for (const l of flatten(data.operationalLayers)) {
    if (!l.url) continue;
    const di = (l.layerDefinition || {}).drawingInfo || {};
    let renderer = di.renderer;
    const meta = await deps.fetchJson(l.url, {});
    if (meta.error) throw new Error(`${l.title}: ${meta.error.message}`);
    if (!renderer) renderer = (meta.drawingInfo || {}).renderer;
    if (!renderer) continue;
    const opacity = di.transparency != null ? 1 - di.transparency / 100 : (l.opacity ?? 1);
    layers.push({ title: l.title || meta.name, url: l.url, renderer, opacity, maxRecordCount: meta.maxRecordCount || 1000, geometryType: meta.geometryType,
      oidField: meta.objectIdField || "OBJECTID", fields: meta.fields || [], popupInfo: l.popupInfo || null, hasAttachments: !!meta.hasAttachments });
  }
  if (!layers.length) throw new Error("No styled layers found in that web map.");
  return { title: item.title || "PROW_Map", layers };
}

function rendererFields(r) {
  const f = new Set();
  for (const k of ["field", "field1", "field2", "field3"]) if (r[k]) f.add(r[k]);
  const ramp = colorRamp(r); if (ramp && ramp.field) f.add(ramp.field);
  return [...f];
}

export async function fetchFeatures(deps, layer, onPage) {
  const count = (await deps.fetchJson(`${layer.url}/query`, { where: "1=1", returnCountOnly: "true" })).count || 0;
  const page = Math.min(layer.maxRecordCount || 1000, 2000), offsets = [];
  for (let o = 0; o < count; o += page) offsets.push(o);
  const fields = [...new Set([...rendererFields(layer.renderer), layer.oidField || "OBJECTID"])].join(",");
  const out = []; let done = 0;
  const worker = async () => {
    while (offsets.length) {
      const o = offsets.shift();
      let res;
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await deps.fetchJson(`${layer.url}/query`, { where: "1=1", outFields: fields, outSR: "3857", returnGeometry: "true", resultOffset: o, resultRecordCount: page, orderByFields: "OBJECTID" });
        if (!res.error) break;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
      if (res.error) throw new Error(`${layer.title}: ${res.error.message}`);
      out.push(...(res.features || []).filter((f) => f.geometry));
      done += (res.features || []).length; onPage && onPage(done, count);
    }
  };
  await Promise.all([1, 2, 3, 4].map(worker));
  return { features: out, expected: count };
}

export function geomKind(layer) {
  const t = layer.geometryType || "";
  if (/Point/i.test(t)) return "point";
  if (/Polyline/i.test(t)) return "line";
  return "polygon";
}

function boundsOf(features) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const f of features) {
    const g = f.geometry;
    if (g.x !== undefined) add(g.x, g.y);
    for (const r of g.rings || g.paths || []) for (const p of r) add(p[0], p[1]);
  }
  return [x0, y0, x1, y1];
}

export function combinedExtent(layers, page) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const L of layers) { const c = boundsOf(L.features); b = [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[2]), Math.max(b[3], c[3])]; }
  let [x0, y0, x1, y1] = b; const w = x1 - x0, h = y1 - y0;
  x0 -= w * 0.03; x1 += w * 0.03; y0 -= h * 0.03; y1 += h * 0.03;
  const [pw, ph] = PAGE_SIZES[page] || PAGE_SIZES.letter, pa = (pw * AX.W) / (ph * AX.H);
  const W = x1 - x0, H = y1 - y0;
  if (W / H < pa) { const nw = H * pa, m = (x0 + x1) / 2; x0 = m - nw / 2; x1 = m + nw / 2; }
  else { const nh = W / pa, m = (y0 + y1) / 2; y0 = m - nh / 2; y1 = m + nh / 2; }
  const lat = (2 * Math.atan(Math.exp(((y0 + y1) / 2) / 6378137)) - Math.PI / 2) * 180 / Math.PI;
  return { x0, y0, x1, y1, lat };
}

// ---------------------------------------------------------------- basemap
export async function renderBasemap(deps, cfg, ext, W, H, onStatus) {
  const bm = BASEMAPS[cfg.basemap];
  const cv = deps.createCanvas(W, H), ctx = cv.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
  if (!bm) return { canvas: cv, attribution: "" };
  const lon = (x) => (x / ORIGIN) * 180, lat = (y) => (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI;
  const zLon = Math.ceil(Math.log2(720 / (lon(ext.x1) - lon(ext.x0)))), zLat = Math.ceil(Math.log2(720 / (lat(ext.y1) - lat(ext.y0))));
  const z = Math.min(bm.maxZ, Math.max(0, Math.min(zLon, zLat) + (cfg.basemapZoomAdjust ?? 1)));
  const tileM = (2 * ORIGIN) / 2 ** z;
  const tx0 = Math.floor((ext.x0 + ORIGIN) / tileM), tx1 = Math.floor((ext.x1 + ORIGIN) / tileM);
  const ty0 = Math.floor((ORIGIN - ext.y1) / tileM), ty1 = Math.floor((ORIGIN - ext.y0) / tileM);
  const jobs = [];
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) jobs.push([x, y]);
  onStatus && onStatus(`Basemap: ${jobs.length} tiles (zoom ${z})`);
  const px = (mx) => ((mx - ext.x0) / (ext.x1 - ext.x0)) * W, py = (my) => ((ext.y1 - my) / (ext.y1 - ext.y0)) * H;
  let failed = 0;
  const worker = async () => {
    while (jobs.length) {
      const [x, y] = jobs.shift();
      try {
        const img = await deps.loadImage(bm.url.replace("{z}", z).replace("{x}", x).replace("{y}", y));
        const mx0 = x * tileM - ORIGIN, my0 = ORIGIN - y * tileM;
        const X0 = px(mx0), Y0 = py(my0), X1 = px(mx0 + tileM), Y1 = py(my0 - tileM);
        ctx.drawImage(img, X0, Y0, X1 - X0 + 0.5, Y1 - Y0 + 0.5);
      } catch (e) { failed++; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (failed) onStatus && onStatus(`Basemap: ${failed} tiles failed to load`);
  if (bm.wash) {
    const im = ctx.getImageData(0, 0, W, H), d = im.data;
    for (let i = 0; i < d.length; i += 4) { const g = 255 - (255 - (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2])) * bm.wash; d[i] = d[i + 1] = d[i + 2] = g; }
    ctx.putImageData(im, 0, 0);
  }
  return { canvas: cv, attribution: bm.attribution };
}

// ---------------------------------------------------------------- feature drawing
async function drawLayer(deps, ctx, L, ctxInfo, cfg, solo, symCache) {
  const { X, Y, pxPerPt, mapScale } = ctxInfo;
  const r = L.renderer, kind = geomKind(L), ramp = colorRamp(r), fixed = cfg.fixRamps0to100;
  const attr = (f, name) => {
    if (!name) return undefined;
    const a = f.attributes || {}; if (name in a) return a[name];
    const k = Object.keys(a).find((x) => x.toLowerCase() === name.toLowerCase()); return k ? a[k] : undefined;
  };
  const tracePoly = (g) => { ctx.beginPath(); for (const ring of g.rings) { ctx.moveTo(X(ring[0][0]), Y(ring[0][1])); for (let i = 1; i < ring.length; i++) ctx.lineTo(X(ring[i][0]), Y(ring[i][1])); ctx.closePath(); } };
  const tracePath = (g) => { ctx.beginPath(); for (const p of g.paths) { ctx.moveTo(X(p[0][0]), Y(p[0][1])); for (let i = 1; i < p.length; i++) ctx.lineTo(X(p[i][0]), Y(p[i][1])); } };

  if (kind === "polygon") {
    if (ramp) {
      ctx.lineWidth = cfg.featureLw * pxPerPt; ctx.lineJoin = "round";
      for (const f of L.features) { const c = css(rampColor(ramp, attr(f, ramp.field), fixed), L.opacity); tracePoly(f.geometry); ctx.fillStyle = c; ctx.strokeStyle = c; ctx.fill("evenodd"); ctx.stroke(); }
      return { kind: "ramp", label: L.title, ramp, vmin: fixed ? 0 : ramp.stops[0][0], vmax: fixed ? 100 : ramp.stops[ramp.stops.length - 1][0] };
    }
    const { field, resolve } = symbolResolver(r); let rep = null;
    for (const f of L.features) {
      const st = fillStyle(resolve(attr(f, field))); rep = rep || st; tracePoly(f.geometry);
      if (st.face) { ctx.fillStyle = css(st.face, L.opacity); ctx.fill("evenodd"); }
      if (st.edge && st.lw > 0) { ctx.strokeStyle = css(st.edge); ctx.lineWidth = st.lw * pxPerPt; ctx.stroke(); }
    }
    rep = rep || fillStyle(r.symbol);
    return { kind: "swatch", label: L.title, face: rep.face, edge: rep.edge || GREY };
  }

  if (kind === "line") {
    if (ramp) {
      ctx.lineWidth = 1.8 * pxPerPt;
      for (const f of L.features) { ctx.strokeStyle = css(rampColor(ramp, attr(f, ramp.field), fixed), L.opacity); tracePath(f.geometry); ctx.stroke(); }
      return { kind: "ramp", label: L.title, ramp, vmin: fixed ? 0 : ramp.stops[0][0], vmax: fixed ? 100 : ramp.stops[ramp.stops.length - 1][0] };
    }
    const { field, resolve } = symbolResolver(r); let rep = null;
    for (const f of L.features) {
      const s = resolve(attr(f, field)); const c = (s && esriColor(s.color)) || [77, 77, 77, 1]; const lw = Math.max(Number((s && s.width) || 1.5), 0.8);
      ctx.strokeStyle = css(c); ctx.lineWidth = lw * pxPerPt; ctx.setLineDash(s && /Dash|Dot/.test(s.style || "") ? [4 * pxPerPt, 2 * pxPerPt] : []);
      tracePath(f.geometry); ctx.stroke(); rep = rep || { kind: "line", label: L.title, color: c, lw: Math.max(lw, 1.2) };
    }
    ctx.setLineDash([]);
    return rep || { kind: "line", label: L.title, color: [77, 77, 77, 1], lw: 1.2 };
  }

  // points
  const fixedPt = iconPt(cfg, L.title, solo), scale = cfg.iconScale * iconMult(cfg, L.title, solo);
  const pt = (f) => { const g = f.geometry; if (g.x !== undefined) return [g.x, g.y]; const r0 = (g.rings || g.paths || [[[0, 0]]])[0]; return r0[0]; };
  const marker = (st, cx, cy, sizePx, color) => {
    ctx.fillStyle = css(color); ctx.beginPath(); const h = sizePx / 2;
    if (st === "esriSMSSquare") ctx.rect(cx - h, cy - h, sizePx, sizePx);
    else if (st === "esriSMSDiamond") { ctx.moveTo(cx, cy - h); ctx.lineTo(cx + h, cy); ctx.lineTo(cx, cy + h); ctx.lineTo(cx - h, cy); ctx.closePath(); }
    else if (st === "esriSMSTriangle") { ctx.moveTo(cx, cy - h); ctx.lineTo(cx + h, cy + h); ctx.lineTo(cx - h, cy + h); ctx.closePath(); }
    else ctx.arc(cx, cy, h, 0, 2 * Math.PI);
    ctx.fill();
  };
  if (ramp) {
    const base = r.symbol || ((r.classBreakInfos || [])[0] || {}).symbol || {};
    const sizePt = fixedPt || sizeFromScale(r, mapScale, base.size ?? 7) * scale;
    cfg.usedPt[`${L.title}|${solo}`] ??= sizePt;
    for (const f of L.features) { const [x, y] = pt(f); marker(base.style, X(x), Y(y), sizePt * 1.05 * pxPerPt, rampColor(ramp, attr(f, ramp.field), fixed)); }
    return { kind: "ramp", label: L.title, ramp, vmin: fixed ? 0 : ramp.stops[0][0], vmax: fixed ? 100 : ramp.stops[ramp.stops.length - 1][0] };
  }
  const { field, resolve } = symbolResolver(r); let legend = null;
  for (const f of L.features) {
    const s = resolve(attr(f, field)); if (!s) continue;
    let icon = symCache.get(s);
    if (icon === undefined) {
      icon = null;
      if (s.type === "esriPMS" && s.imageData) icon = { img: await deps.loadImage(`data:${s.contentType || "image/png"};base64,${s.imageData}`), nominal: s.width || 18 };
      else if (s.type === "CIMSymbolReference" && (s.symbol || {}).type === "CIMPointSymbol") { const c = cimCanvas(deps, s.symbol); if (c) icon = { img: c, nominal: 18 }; }
      symCache.set(s, icon);
    }
    const [x, y] = pt(f);
    if (icon) {
      const sizePt = fixedPt || sizeFromScale(r, mapScale, icon.nominal) * scale;
      const w = sizePt * pxPerPt, h = w * (icon.img.height / icon.img.width);
      ctx.drawImage(icon.img, X(x) - w / 2, Y(y) - h / 2, w, h);
      cfg.usedPt[`${L.title}|${solo}`] ??= sizePt;
      legend = legend || { kind: "icon", label: L.title, img: icon.img };
    } else {
      const c = esriColor(s.color) || [51, 102, 204, 1];
      const sizePt = fixedPt || sizeFromScale(r, mapScale, s.size ?? 6) * scale;
      marker(s.style, X(x), Y(y), sizePt * pxPerPt, c);
      cfg.usedPt[`${L.title}|${solo}`] ??= sizePt;
      legend = legend || { kind: "marker", label: L.title, color: c, style: s.style };
    }
  }
  return legend || { kind: "marker", label: L.title, color: [51, 102, 204, 1], style: "esriSMSCircle" };
}

// ---------------------------------------------------------------- page
export const niceRound = (x) => { if (x <= 0) return 1; const b = 10 ** Math.floor(Math.log10(x)); for (const m of [5, 2, 1]) if (x >= m * b) return m * b; return b; };
export const fmtNum = (v) => (Math.round(v * 1000) / 1000).toString();

// Draws the layers over a basemap canvas. frameIn = printed width of the map frame in inches
// (sets the map scale that scale-dependent symbol sizes use). Returns the canvas + legend entries.
export async function renderMapImage(deps, cfg, layers, ext, base, W, H, frameIn, solo, onStatus) {
  const groundW = (ext.x1 - ext.x0) * Math.cos(ext.lat * Math.PI / 180);
  const mapScale = groundW / (frameIn * 0.0254);
  const cv = deps.createCanvas(W, H), ctx = cv.getContext("2d");
  ctx.drawImage(base.canvas, 0, 0, W, H);
  const X = (x) => ((x - ext.x0) / (ext.x1 - ext.x0)) * W, Y = (y) => ((ext.y1 - y) / (ext.y1 - ext.y0)) * H;
  const info = { X, Y, pxPerPt: (W / frameIn) / 72, mapScale };
  // stacking as in the Python script: points < lines < polygons, then layer order
  const band = { point: 0, line: 1000, polygon: 2000 }, n = layers.length;
  // a user-chosen order (cfg.layerOrder, top of the list first) replaces that: the top layer is drawn last
  const order = cfg.layerOrder ? layers.slice().reverse().map((L) => ({ L }))
    : layers.map((L, i) => ({ L, z: band[geomKind(L)] + (cfg.reverseStack ? n - 1 - i : i) })).sort((a, b) => a.z - b.z);
  const legend = new Map(), symCache = new Map();
  for (const { L } of order) { onStatus && onStatus(`  drawing ${L.title}`); const e = await drawLayer(deps, ctx, L, info, cfg, solo, symCache); if (e) legend.set(L, e); }
  const entries = layers.filter((L) => legend.has(L)).map((L) => legend.get(L));
  return { canvas: cv, entries, mapScale, groundW };
}

async function renderPage(deps, cfg, layers, ext, base, title, dateStr, solo, onStatus) {
  const [pw, ph] = PAGE_SIZES[cfg.page] || PAGE_SIZES.letter;
  const W = Math.round(pw * AX.W * cfg.dpi), H = Math.round(ph * AX.H * cfg.dpi);
  const { canvas: cv, entries, mapScale, groundW } = await renderMapImage(deps, cfg, layers, ext, base, W, H, pw * AX.W, solo, onStatus);

  const doc = new deps.jsPDF({ orientation: "landscape", unit: "in", format: [pw, ph], compress: true });
  doc.addFileToVFS("DejaVuSans.ttf", deps.fonts.regular); doc.addFont("DejaVuSans.ttf", "DejaVu", "normal");
  doc.addFileToVFS("DejaVuSans-Bold.ttf", deps.fonts.bold); doc.addFont("DejaVuSans-Bold.ttf", "DejaVu", "bold");
  const fx = (f) => f * pw, fy = (f) => ph * (1 - f);
  doc.setFillColor(255, 255, 255); doc.rect(0, 0, pw, ph, "F");   // opaque white page
  const text = (s, x, y, size, opts = {}) => { doc.setFont("DejaVu", opts.bold ? "bold" : "normal"); doc.setFontSize(size); doc.setTextColor(...(opts.color || [0, 0, 0])); doc.text(String(s), fx(x), fy(y), { align: opts.align || "left", baseline: opts.baseline || "middle" }); };

  // map image + frame
  doc.addImage(await deps.toJpeg(cv, cfg.jpegQuality), "JPEG", fx(AX.L), fy(AX.B + AX.H), pw * AX.W, ph * AX.H, undefined, "FAST");
  doc.setDrawColor(0); doc.setLineWidth(1.3 / 72); doc.rect(fx(AX.L), fy(AX.B + AX.H), pw * AX.W, ph * AX.H);

  // north arrow (inside the frame, top right)
  const ax1 = AX.L + AX.W, ay1 = AX.B + AX.H, axw = AX.W, axh = AX.H;
  const nx = ax1 - axw * 0.04, ny0 = ay1 - axh * 0.10, len = axh * 0.05, hw = axw * 0.010, hl = axh * 0.015, sw = axw * 0.002;
  doc.setFillColor(0); doc.rect(fx(nx - sw / 2), fy(ny0 + len - hl), fx(sw), (len - hl) * ph, "F");
  doc.triangle(fx(nx - hw / 2), fy(ny0 + len - hl), fx(nx + hw / 2), fy(ny0 + len - hl), fx(nx), fy(ny0 + len), "F");
  text("N", nx, ny0 - axh * 0.015, 10, { bold: true, align: "center", baseline: "top" });

  // title, date, ratio
  text(title, 0.5, 0.965, 20, { bold: true, align: "center" });
  text(dateStr, AX.L, 0.125, 11);
  text(`1:${Math.round(mapScale).toLocaleString("en-US")}`, 0.80, 0.125, 11, { align: "center" });

  // legend: columns of 4 rows across the bottom left
  const swW = 0.020, colW = 0.16, rowH = 0.030;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], col = Math.floor(i / 4), row = i % 4, x = AX.L + col * colW, y = 0.100 - row * rowH;
    if (e.kind === "icon") {
      const s = 14 / 72, ic = deps.createCanvas(e.img.width, e.img.height); ic.getContext("2d").drawImage(e.img, 0, 0);
      const ar = e.img.height / e.img.width;
      doc.addImage(await deps.toPng(ic), "PNG", fx(x + swW / 2) - s / 2, fy(y) - (s * ar) / 2, s, s * ar);
    } else if (e.kind === "marker") {
      doc.setFillColor(...e.color.slice(0, 3)); doc.setDrawColor(0); doc.setLineWidth(0.4 / 72);
      doc.circle(fx(x + swW / 2), fy(y), 3.5 / 72, "FD");
    } else if (e.kind === "line") {
      doc.setDrawColor(...e.color.slice(0, 3)); doc.setLineWidth(Math.max(e.lw, 1.3) / 72); doc.line(fx(x), fy(y), fx(x + swW), fy(y));
    } else if (e.kind === "swatch") {
      if (e.face) doc.setFillColor(...e.face.slice(0, 3)); doc.setDrawColor(...e.edge.slice(0, 3)); doc.setLineWidth(0.5 / 72);
      doc.rect(fx(x), fy(y + 0.008), fx(swW), 0.016 * ph, e.face ? "FD" : "S");
    } else if (e.kind === "ramp") {
      const gc = deps.createCanvas(64, 1), g = gc.getContext("2d");
      for (let k = 0; k < 64; k++) { g.fillStyle = css(rampColor(e.ramp, e.vmin + (k / 63) * (e.vmax - e.vmin), false)); g.fillRect(k, 0, 1, 1); }
      doc.addImage(await deps.toPng(gc), "PNG", fx(x), fy(y + 0.009), fx(swW), 0.018 * ph);
      doc.setDrawColor(102); doc.setLineWidth(0.4 / 72); doc.rect(fx(x), fy(y + 0.009), fx(swW), 0.018 * ph);
    }
    const label = e.kind === "ramp" ? `${e.label} (${fmtNum(e.vmin)}–${fmtNum(e.vmax)})` : e.label;
    text(String(label).slice(0, 26 + (e.kind === "ramp" ? 10 : 0)), x + swW + 0.006, y, 7);
  }

  // scale bars (km above, mi below)
  const figW = (d) => (d / groundW) * AX.W;
  const bar = (y, totalM, div, unit, above) => {
    const segs = 4, hh = 0.010, left = 0.63, seg = totalM / segs;
    doc.setLineWidth(0.8 / 72); doc.setDrawColor(0);
    for (let i = 0; i < segs; i++) { doc.setFillColor(i % 2 ? 255 : 0); doc.rect(fx(left + figW(seg * i)), fy(y + hh), fx(figW(seg)), hh * ph, "FD"); }
    for (let i = 0; i <= segs; i++) text(fmtNum((totalM * i / segs) / div), left + figW(seg * i), above ? y + hh + 0.006 : y - 0.006, 6.5, { align: "center", baseline: above ? "bottom" : "top" });
    text(unit, left + figW(totalM) + 0.008, y + hh / 2, 8);
  };
  bar(0.075, niceRound((0.20 / AX.W) * groundW), 1000, "km", true);
  bar(0.038, niceRound(((0.20 / AX.W) * groundW) / 1609.344) * 1609.344, 1609.344, "mi", false);
  text((base.attribution ? `Basemap: ${base.attribution}` : "").slice(0, 95), AX.L + AX.W, 0.015, 6, { align: "right", color: [89, 89, 89] });

  return doc.output("arraybuffer");
}

const safeName = (s) => (String(s).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "PROW_Map");

// ---------------------------------------------------------------- main entry
export async function buildReport(deps, { sharing, webmapId, options = {}, onStatus = () => {} }) {
  const cfg = { ...DEFAULTS, ...options, iconOverrides: { ...DEFAULTS.iconOverrides, ...(options.iconOverrides || {}) }, usedPt: {} };
  onStatus("Reading the web map…");
  const { title, layers: all } = await resolveLayers(deps, sharing, webmapId);
  // cfg.skipLayers: PDFs not to make — layerKeys (no own page) and/or ALL_KEY (no all-layers page).
  // The all-layers page always shows every layer; without it only the layers being made are downloaded.
  const skip = cfg.skipLayers || [], makeAll = !skip.includes(ALL_KEY);
  const layers = makeAll ? all : all.filter((L) => !skip.includes(layerKey(L)));
  if (!layers.length) throw new Error("Nothing selected to generate.");
  if (cfg.layerOrder) {
    const rank = (L) => { const k = cfg.layerOrder.indexOf(layerKey(L)); return k < 0 ? 1e9 : k; };
    layers.sort((a, b) => rank(a) - rank(b));
  }
  onStatus(`Layers: ${layers.map((l) => l.title).join(", ")}`);
  for (const L of layers) {
    const { features, expected } = await fetchFeatures(deps, L, (d, n) => onStatus(`Downloading ${L.title}: ${d.toLocaleString()} / ${n.toLocaleString()}`, true));
    L.features = features;
    onStatus(`${L.title}: ${features.length.toLocaleString()} features${features.length < expected ? ` (of ${expected.toLocaleString()} — some have no shape)` : ""}`);
  }
  const drawable = layers.filter((L) => L.features.length);
  if (!drawable.length) throw new Error("No features in any layer.");
  const ext = combinedExtent(drawable, cfg.page);
  const [pw, ph] = PAGE_SIZES[cfg.page] || PAGE_SIZES.letter;
  const W = Math.round(pw * AX.W * cfg.dpi), H = Math.round(ph * AX.H * cfg.dpi);
  const base = await renderBasemap(deps, cfg, ext, W, H, onStatus);
  const dateStr = cfg.date || new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  const files = [], st = safeName(title);
  if (makeAll) {
    onStatus("Rendering combined map…");
    files.push({ name: `${st}_ALL.pdf`, data: await renderPage(deps, cfg, drawable, ext, base, title, dateStr, false, onStatus) });
  }
  for (const L of drawable.filter((L) => !skip.includes(layerKey(L)))) {
    onStatus(`Rendering ${L.title}…`);
    files.push({ name: `${st}__${safeName(L.title)}.pdf`, data: await renderPage(deps, cfg, [L], ext, base, `${title} — ${L.title}`, dateStr, true, onStatus) });
  }
  onStatus(`Done: ${files.length} PDFs.`);
  return { title, files, usedPt: cfg.usedPt };
}
