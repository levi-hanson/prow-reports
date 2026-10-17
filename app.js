import { CONFIG } from "./config.js?v=20261017112120";
import { buildReport, resolveLayers, layerKey, defaultOrder, ALL_KEY, DEFAULTS } from "./renderer.js?v=20261017112120";
import { initReportTab, setReportMaps } from "./report-ui.js?v=20261017112120";
import { initCompletenessTab, setCompletenessMaps } from "./completeness.js?v=20261017112120";

const $ = (id) => document.getElementById(id);
const SHARING = `${CONFIG.portal}/sharing/rest`;
const store = {
  get: (k) => { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: (k) => { try { sessionStorage.removeItem(k); } catch {} },
};

// ---------------------------------------------------------------- sign-in (OAuth 2 + PKCE, no secrets)
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function signIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  store.set("pkce", { verifier, state });
  const q = new URLSearchParams({ client_id: CONFIG.clientId, response_type: "code", redirect_uri: CONFIG.redirectUri,
    code_challenge: challenge, code_challenge_method: "S256", state, expiration: "120" });
  location.href = `${SHARING}/oauth2/authorize?${q}`;
}
async function finishSignIn() {
  const p = new URLSearchParams(location.search);
  if (!p.get("code")) return;
  const pk = store.get("pkce"); history.replaceState(null, "", location.pathname);
  if (!pk || pk.state !== p.get("state")) throw new Error("Sign-in expired — please sign in again.");
  const r = await fetch(`${SHARING}/oauth2/token`, { method: "POST", body: new URLSearchParams({
    client_id: CONFIG.clientId, grant_type: "authorization_code", code: p.get("code"), redirect_uri: CONFIG.redirectUri, code_verifier: pk.verifier }) });
  const j = await r.json(); store.del("pkce");
  if (!j.access_token) throw new Error(j.error_description || "Sign-in failed.");
  store.set("auth", { token: j.access_token, user: j.username, expires: Date.now() + (j.expires_in - 60) * 1000 });
}
const auth = () => { const a = store.get("auth"); return a && a.expires > Date.now() ? a : null; };

// ---------------------------------------------------------------- API helpers
async function fetchJson(url, params) {
  const a = auth(); if (!a) throw new Error("Your sign-in expired — sign in again.");
  const body = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), f: "json", token: a.token });
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(url, { method: "POST", body }); return await r.json(); }
    catch (e) { if (i === 3) throw e; await new Promise((res) => setTimeout(res, 2000)); }
  }
}
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = () => rej(new Error("image")); i.src = src; });
const createCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
// an ArcGIS-hosted image (e.g. a feature's photo attachment), fetched with the sign-in token
const fetchImage = async (url) => { const a = auth(); const r = await fetch(`${url}?token=${encodeURIComponent(a ? a.token : "")}`); if (!r.ok) throw new Error("image"); return loadImage(URL.createObjectURL(await r.blob())); };
const blobBytes = (cv, type, q) => new Promise((res) => cv.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), type, q));
let fontsCache = null;
async function fonts() {
  if (fontsCache) return fontsCache;
  const get = async (f) => { const b = new Uint8Array(await (await fetch(`fonts/${f}`)).arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
  fontsCache = { regular: await get("DejaVuSans.ttf"), bold: await get("DejaVuSans-Bold.ttf") };
  return fontsCache;
}

// ---------------------------------------------------------------- UI
function log(msg, progress) {
  const el = $("log");
  if (progress && el.lastChild && el.lastChild.dataset.progress) el.lastChild.textContent = msg;
  else { const d = document.createElement("div"); d.textContent = msg; if (progress) d.dataset.progress = "1"; el.appendChild(d); }
  el.scrollTop = el.scrollHeight;
}

// one search feeds both tabs; q comes from whichever tab's search box was used
async function searchMaps(q = $("search").value.trim()) {
  $("search").value = q; $("rsearch").value = q; $("csearch").value = q;
  const sel = $("map"); sel.innerHTML = "<option>Searching…</option>"; $("rmap").innerHTML = "<option>Searching…</option>";
  const me = await fetchJson(`${SHARING}/portals/self`, {});
  const r = await fetchJson(`${SHARING}/search`, { q: `${q ? `title:"${q.replace(/"/g, "")}" ` : ""}type:"Web Map" orgid:${me.id}`, num: 100, sortField: "title", sortOrder: "asc" });
  const items = (r.results || []).filter((i) => i.type === "Web Map");
  sel.innerHTML = items.length ? items.map((i) => `<option value="${i.id}">${i.title.replace(/</g, "&lt;")}</option>`).join("") : "<option value=''>No maps found</option>";
  $("go").disabled = !items.length;
  setReportMaps(items);
  setCompletenessMaps(items);
  loadIcons();
}

// ---------------------------------------------------------------- icon sizes (point layers only)
const local = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let pointLayers = [], mapLayers = [];
const isPoint = (l) => /Point/.test(l.geometryType || "");
async function loadIcons() {
  const id = $("map").value, box = $("icons");
  pointLayers = []; mapLayers = [];
  if (!id) { box.innerHTML = '<p class="muted">Pick a map to see its layers.</p>'; return; }
  box.innerHTML = '<p class="muted">Reading layers…</p>';
  let layers;
  try { ({ layers } = await resolveLayers({ fetchJson }, SHARING, id)); if ($("map").value !== id) return; }
  catch (e) { box.innerHTML = `<p class="warn">${esc(e.message)}</p>`; return; }
  const saved = local.get(`order:${id}`) || [];
  const rank = (l) => { const k = saved.indexOf(layerKey(l)); return k < 0 ? 1e9 : k; };
  const dflt = defaultOrder(layers);
  mapLayers = dflt.map((l, i) => ({ l, i })).sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i).map((o) => o.l);
  pointLayers = layers.filter(isPoint).map((l) => l.title);
  drawTable();
}
function drawTable() {
  const id = $("map").value, box = $("icons"), saved = local.get(`icons:${id}`) || {};
  const prev = $("icons").querySelector("input[data-k]") ? readIcons() : null;
  const cell = (title, kind) => {
    const k = title.trim().toLowerCase(), d = DEFAULTS.iconOverrides[k] || {};
    const src = prev && prev[k] ? prev : saved;
    const v = src[k] ? src[k][kind] : d[`${kind}_pt`];
    const mult = d[kind] && d[kind] !== 1 ? ` ×${d[kind]}` : "";
    return `<input type="number" min="0.5" max="40" step="0.1" data-k="${esc(k)}" data-kind="${kind}" value="${v ?? ""}" placeholder="auto${mult}" aria-label="${esc(title)} ${kind} size">`;
  };
  const n = mapLayers.length, off = local.get(`off:${id}`) || [];
  box.innerHTML = `<table class="icons"><tr><th>Order</th><th>Generate</th><th>Layer</th><th>All-layers map (pt)</th><th>Own map (pt)</th></tr>
    <tr><td></td><td><input type="checkbox" class="use" data-key="${ALL_KEY}" ${off.includes(ALL_KEY) ? "" : "checked"} aria-label="Generate the all-layers map"></td><td><b>All-layers map</b> <span class="muted">(every layer below)</span></td><td class="muted">—</td><td class="muted">—</td></tr>
    ${mapLayers.map((l, i) => `<tr><td class="mv"><button class="secondary" data-mv="${i}" data-d="-1" ${i ? "" : "disabled"} aria-label="Move ${esc(l.title)} up">▲</button><button class="secondary" data-mv="${i}" data-d="1" ${i < n - 1 ? "" : "disabled"} aria-label="Move ${esc(l.title)} down">▼</button></td>
      <td><input type="checkbox" class="use" data-key="${esc(layerKey(l))}" ${off.includes(layerKey(l)) ? "" : "checked"} aria-label="Generate ${esc(l.title)} map"></td>
      <td>${esc(l.title)}</td>${isPoint(l) ? `<td>${cell(l.title, "overview")}</td><td>${cell(l.title, "solo")}</td>` : '<td class="muted">—</td><td class="muted">—</td>'}</tr>`).join("")}</table>
    <p class="muted">Top of the list is drawn on top and comes first in the legend. Icon sizes are in points; blank = automatic size from the web map. <a href="#" id="iconreset">Reset to defaults</a></p>`;
  box.querySelectorAll("input[data-k]").forEach((i) => i.oninput = saveIcons);
  box.querySelectorAll("input.use").forEach((c) => c.onchange = () => { local.set(`off:${id}`, skipped()); updateGo(); });
  updateGo();
  box.querySelectorAll("[data-mv]").forEach((b) => b.onclick = () => {
    const i = +b.dataset.mv, j = i + +b.dataset.d; [mapLayers[i], mapLayers[j]] = [mapLayers[j], mapLayers[i]];
    local.set(`order:${id}`, mapLayers.map(layerKey)); drawTable();
    box.querySelector(`[data-mv="${j}"][data-d="${b.dataset.d}"]`)?.focus();
  });
  $("iconreset").onclick = (e) => { e.preventDefault(); try { localStorage.removeItem(`icons:${id}`); localStorage.removeItem(`order:${id}`); localStorage.removeItem(`off:${id}`); } catch {} box.innerHTML = ""; loadIcons(); };
}
const skipped = () => [...$("icons").querySelectorAll("input.use")].filter((c) => !c.checked).map((c) => c.dataset.key);
function updateGo() {
  const boxes = $("icons").querySelectorAll("input.use"), on = [...boxes].filter((c) => c.checked).length;
  $("go").disabled = !$("map").value || (boxes.length > 0 && !on);
  $("go").textContent = !boxes.length || on === boxes.length ? "Generate PDFs" : on === 1 ? "Generate 1 PDF" : `Generate ${on} PDFs`;
}
function readIcons() {
  const out = {};
  $("icons").querySelectorAll("input[data-k]").forEach((i) => {
    const o = (out[i.dataset.k] ||= {}); const n = parseFloat(i.value);
    o[i.dataset.kind] = n > 0 ? n : null;
  });
  return out;
}
function saveIcons() { local.set(`icons:${$("map").value}`, readIcons()); }
function iconOverrides() {
  const res = {};
  for (const [k, v] of Object.entries(readIcons())) {
    const o = { ...(DEFAULTS.iconOverrides[k] || {}) };
    for (const kind of ["overview", "solo"]) { if (v[kind]) o[`${kind}_pt`] = v[kind]; else delete o[`${kind}_pt`]; }
    res[k] = o;
  }
  return res;
}

async function generate() {
  const id = $("map").value; if (!id) return;
  $("go").disabled = true; $("log").innerHTML = ""; $("result").innerHTML = "";
  try {
    const deps = { fetchJson, createCanvas, loadImage, jsPDF: window.jspdf.jsPDF, fonts: await fonts(),
      toJpeg: (cv, q) => blobBytes(cv, "image/jpeg", q), toPng: (cv) => blobBytes(cv, "image/png") };
    const options = { page: $("page").value, basemap: $("basemap").value, date: $("date").value.trim() || null, iconOverrides: iconOverrides(), layerOrder: mapLayers.length ? mapLayers.map(layerKey) : null, skipLayers: skipped() };
    const res = await buildReport(deps, { sharing: SHARING, webmapId: id, options, onStatus: log });
    const used = pointLayers.map((t) => {
      const a = res.usedPt[`${t}|false`], b = res.usedPt[`${t}|true`];
      return a || b ? `${t}: ${a ? a.toFixed(1) : "–"} / ${b ? b.toFixed(1) : "–"}` : null;
    }).filter(Boolean);
    if (used.length) log(`Icon sizes used, pt (all-layers map / own map): ${used.join(" · ")}`);
    const one = res.files.length === 1;
    let blob, name;
    if (one) { blob = new Blob([res.files[0].data], { type: "application/pdf" }); name = res.files[0].name; }
    else {
      log("Zipping…");
      const zip = new JSZip(); for (const f of res.files) zip.file(f.name, f.data);
      blob = await zip.generateAsync({ type: "blob" }); name = `${res.title.replace(/[^A-Za-z0-9_-]/g, "_")}_PDFs.zip`;
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    a.textContent = `Download ${one ? "PDF" : `${res.files.length} PDFs`} (${(blob.size / 1048576).toFixed(1)} MB)`; a.className = "btn";
    $("result").appendChild(a); a.click();
  } catch (e) { log(`Error: ${e.message}`); }
  updateGo();
}

async function init() {
  if (!CONFIG.clientId) { $("signedout").innerHTML = "<p class='warn'>This tool isn't connected to ArcGIS yet (missing app Client ID in config.js).</p>"; return; }
  try { await finishSignIn(); } catch (e) { $("signedout").insertAdjacentHTML("beforeend", `<p class="warn">${e.message}</p>`); }
  const a = auth();
  $("signedout").hidden = !!a; $("app").hidden = !a;
  if (!a) return;
  $("who").textContent = a.user;
  $("tabs").hidden = false;
  document.querySelectorAll("#tabs button").forEach((b) => b.onclick = () => {
    document.querySelectorAll("#tabs button").forEach((x) => { x.setAttribute("aria-selected", String(x === b)); $(x.dataset.tab).hidden = x !== b; });
    document.body.classList.toggle("wide", b.dataset.tab === "tab-report");
  });
  // the Full report tab must never stop the Map PDFs tab from working
  try { initReportTab({ fetchJson, fetchImage, SHARING, createCanvas, loadImage, blobBytes, searchMaps }); } catch (e) { console.error("Full report tab:", e); }
  try { initCompletenessTab({ fetchJson, SHARING, loadImage, searchMaps }); } catch (e) { console.error("Completeness tab:", e); }
  document.querySelector('#tabs [data-tab="tab-report"]').click();   // Full report is the default screen
  $("search").value = CONFIG.defaultSearch;
  $("page").value = DEFAULTS.page; $("basemap").value = DEFAULTS.basemap;
  await searchMaps();
}

$("signin").onclick = signIn;
$("signout").onclick = () => { store.del("auth"); location.reload(); };
$("find").onclick = () => searchMaps().catch((e) => log(`Error: ${e.message}`));
$("search").onkeydown = (e) => { if (e.key === "Enter") $("find").click(); };
$("go").onclick = generate;
$("map").onchange = loadIcons;
init();
