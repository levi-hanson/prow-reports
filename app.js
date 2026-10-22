import { CONFIG } from "./config.js?v=20261022135329";
import { initReportTab, setReportMaps } from "./report-ui.js?v=20261022135329";
import { initCompletenessTab, setCompletenessMaps } from "./completeness.js?v=20261022135329";
import { initExportTab } from "./export.js?v=20261022135329";

const $ = (id) => document.getElementById(id);
// One map at a time across the tabs: whichever tab loads a map announces it ("prow:map-loaded") and the other
// tabs load the same map in the background, sharing the downloaded layers.
window.__prowShared = window.__prowShared || { features: new Map() };
export const announceMap = (id, source) => window.dispatchEvent(new CustomEvent("prow:map-loaded", { detail: { id, source } }));
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
// ---------------------------------------------------------------- UI
function log(msg) { const d = document.createElement("div"); d.textContent = msg; $("xlog").appendChild(d); }

// one search feeds both tabs; q comes from whichever tab's search box was used
async function searchMaps(q = $("search").value.trim()) {
  $("search").value = q; $("rsearch").value = q; $("csearch").value = q;
  const sel = $("map"); sel.innerHTML = "<option>Searching…</option>"; $("rmap").innerHTML = "<option>Searching…</option>";
  const me = await fetchJson(`${SHARING}/portals/self`, {});
  const r = await fetchJson(`${SHARING}/search`, { q: `${q ? `title:"${q.replace(/"/g, "")}" ` : ""}type:"Web Map" orgid:${me.id}`, num: 100, sortField: "title", sortOrder: "asc" });
  const items = (r.results || []).filter((i) => i.type === "Web Map");
  sel.innerHTML = items.length ? items.map((i) => `<option value="${i.id}">${i.title.replace(/</g, "&lt;")}</option>`).join("") : "<option value=''>No maps found</option>";
  $("mload").disabled = !items.length; $("xsteps").hidden = true;
  setReportMaps(items);
  setCompletenessMaps(items);
}

async function init() {
  if (!CONFIG.clientId) { $("signedout").innerHTML = "<p class='warn'>This tool isn't connected to ArcGIS yet (missing app Client ID in config.js).</p>"; return; }
  try { await finishSignIn(); } catch (e) { $("signedout").insertAdjacentHTML("beforeend", `<p class="warn">${e.message}</p>`); }
  const a = auth();
  $("signedout").hidden = !!a; $("app").hidden = !a; $("whoami").hidden = !a;
  if (!a) return;
  $("who").textContent = a.user;
  $("tabs").hidden = false;
  document.querySelectorAll("#tabs button").forEach((b) => b.onclick = () => {
    document.querySelectorAll("#tabs button").forEach((x) => { x.setAttribute("aria-selected", String(x === b)); $(x.dataset.tab).hidden = x !== b; });
    document.body.classList.add("wide");   // every tab is split-screen now
  });
  // one tab failing must never stop the others from working
  try { initReportTab({ fetchJson, fetchImage, SHARING, createCanvas, loadImage, blobBytes, searchMaps }); } catch (e) { console.error("Full report tab:", e); }
  try { initCompletenessTab({ fetchJson, SHARING, loadImage, searchMaps }); } catch (e) { console.error("Completeness tab:", e); }
  try { initExportTab({ fetchJson, SHARING, token: () => (auth() || {}).token }); } catch (e) { console.error("Data export tab:", e); }
  document.querySelector('#tabs [data-tab="tab-report"]').click();   // Full report is the default screen
  $("search").value = CONFIG.defaultSearch;
  await searchMaps();
}

$("signin").onclick = signIn;
$("signout").onclick = () => { store.del("auth"); location.reload(); };
$("find").onclick = () => searchMaps().catch((e) => log(`Error: ${e.message}`));
$("search").onkeydown = (e) => { if (e.key === "Enter") $("find").click(); };
init();
