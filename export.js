// Data export tab — the browser version of daxbot_data_export_gdb.py.
// For each feature service behind the chosen web map it writes, into a folder the user picks:
//   <Service_Title>/<Service_Title>.gdb      file geodatabase, built by ArcGIS (createReplica) and unzipped here
//   <Service_Title>/images/<layer>/<OBJECTID>_<name>   every photo attachment
// Photos already in the folder (same name and size) are skipped, so an interrupted export can simply be re-run.
import { resolveLayers } from "./renderer.js?v=20261022142347";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const safe = (s) => String(s).trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_") || "FeatureService";
const WORKERS = 8;
let ctx = null, services = [], loadedMap = null, loadingMap = null, running = false, stopRequested = false;

function log(msg, progress) {
  const el = $("xlog");
  if (progress && el.lastChild && el.lastChild.dataset.progress) el.lastChild.textContent = msg;
  else { const d = document.createElement("div"); d.textContent = msg; if (progress) d.dataset.progress = "1"; el.appendChild(d); }
  el.scrollTop = el.scrollHeight;
}
const fail = (msg) => { log(msg); const d = $("xlog").lastChild; d.className = "warn"; };

// ---------------------------------------------------------------- step 2: services and layers behind the map
async function loadMap() {
  const id = $("map").value; if (!id) return;
  loadingMap = id; $("xsteps").hidden = false; $("xlayers").innerHTML = '<p class="muted busy">Reading the map’s layers…</p>';
  $("mload").classList.add("busy");
  try {
    const { layers } = await resolveLayers({ fetchJson: ctx.fetchJson }, ctx.SHARING, id);
    if ($("map").value !== id) return;
    const bases = [...new Set(layers.map((l) => l.url.replace(/\/\d+\/?$/, "")).filter((u) => /FeatureServer$/i.test(u)))];
    services = [];
    for (const url of bases) {
      const info = await ctx.fetchJson(url, {});
      if (info.error) { services.push({ url, title: url, error: info.error.message, layers: [] }); continue; }
      let title = (info.serviceDescription || "").split(":")[0] || url.split("/services/")[1].split("/")[0];
      if (info.serviceItemId) { const item = await ctx.fetchJson(`${ctx.SHARING}/content/items/${info.serviceItemId}`, {}); if (item.title) title = item.title; }
      else title = url.split("/services/")[1].split("/")[0];
      const inMap = new Set(layers.filter((l) => l.url.replace(/\/\d+\/?$/, "") === url).map((l) => +l.url.match(/\/(\d+)\/?$/)[1]));
      const ls = [];
      for (const L of info.layers || []) {
        const [meta, cnt] = await Promise.all([ctx.fetchJson(`${url}/${L.id}`, {}), ctx.fetchJson(`${url}/${L.id}/query`, { where: "1=1", returnCountOnly: "true" })]);
        ls.push({ id: L.id, name: meta.name || L.name, count: cnt.count ?? null, photos: !!meta.hasAttachments, inMap: inMap.has(L.id), oidField: meta.objectIdField || "OBJECTID",
          queryAttachments: !!meta.supportsQueryAttachments || /queryAttachments/i.test(JSON.stringify(meta.advancedQueryCapabilities || {})) });
      }
      services.push({ url, title, folder: safe(title), layers: ls });
    }
    loadedMap = id; loadingMap = null;
    renderLayers();
  } catch (e) { $("xlayers").innerHTML = `<p class="warn">${esc(e.message)}</p>`; loadingMap = null; }
  $("mload").classList.remove("busy");
}
function renderLayers() {
  if (!services.length) { $("xlayers").innerHTML = '<p class="muted">This map has no feature service layers to export.</p>'; return; }
  $("xlayers").innerHTML = services.map((s, si) => s.error ? `<p class="warn">${esc(s.url)}: ${esc(s.error)}</p>` : `
    <div class="xsvc"><p><b>${esc(s.title)}</b> <span class="muted">→ folder <code>${esc(s.folder)}</code></span></p>
    <table class="icons"><tr><th>Export</th><th>Layer</th><th>Features</th><th>Photos</th></tr>
    ${s.layers.map((L, li) => `<tr><td><input type="checkbox" data-s="${si}" data-l="${li}" ${L.count ? "checked" : ""} aria-label="Export ${esc(L.name)}"></td>
      <td>${esc(L.name)}${L.inMap ? "" : ' <span class="muted">(not in the map)</span>'}</td><td>${L.count == null ? "?" : L.count.toLocaleString()}</td><td>${L.photos ? "yes" : '<span class="muted">—</span>'}</td></tr>`).join("")}
    </table></div>`).join("");
  $("xlayers").querySelectorAll("input[data-s]").forEach((c) => c.onchange = updateGo);
  updateGo();
}
const chosen = (s) => s.layers.filter((L, li) => $("xlayers").querySelector(`input[data-s="${services.indexOf(s)}"][data-l="${li}"]`)?.checked);
function updateGo() {
  const n = services.reduce((a, s) => a + (s.error ? 0 : chosen(s).length), 0), what = [$("xgdb").checked && "geodatabase", $("ximg").checked && "photos"].filter(Boolean);
  $("xgo").disabled = running || !n || !what.length;
  $("xgo").textContent = running ? "Exporting…" : `Export ${n} layer${n === 1 ? "" : "s"}${what.length ? ` (${what.join(" + ")})` : ""}`;
}

// ---------------------------------------------------------------- folder helpers (File System Access API: Chrome / Edge)
async function subdir(dir, path) { for (const p of path.split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(p, { create: true }); return dir; }
async function writeFile(dir, name, data) { const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(data); await w.close(); }
async function existingSize(dir, name) { try { return (await (await dir.getFileHandle(name)).getFile()).size; } catch { return -1; } }

// ---------------------------------------------------------------- geodatabase: ArcGIS builds it (createReplica), we unzip it into the folder
async function exportGdb(s, root) {
  const ids = chosen(s).map((L) => L.id);
  log(`${s.title}: asking ArcGIS to build the geodatabase (${ids.length} layer${ids.length === 1 ? "" : "s"})…`);
  const job = await ctx.fetchJson(`${s.url}/createReplica`, { layers: ids.join(","), returnAttachments: "false", syncModel: "none", dataFormat: "filegdb", async: "true", replicaName: s.folder });
  if (job.error) throw new Error(`ArcGIS won't export this service: ${job.error.message}${/extract|permission|not allowed|403/i.test(job.error.message + (job.error.details || "")) ? " (export needs the service's Extract setting on, or the owner/an admin signed in)" : ""}`);
  let st = job, t0 = Date.now();
  while (job.statusUrl && !/Completed|Failed/i.test(st.status || "")) {
    if (stopRequested) throw new Error("stopped");
    await new Promise((r) => setTimeout(r, 3000));
    st = await ctx.fetchJson(job.statusUrl, {});
    log(`${s.title}: building the geodatabase… ${st.status || ""} (${Math.round((Date.now() - t0) / 1000)} s)`, true);
  }
  if (/Failed/i.test(st.status || "") || !(st.resultUrl || job.URL)) throw new Error(`ArcGIS couldn't build the geodatabase${st.error ? `: ${st.error.message || st.error}` : ""}.`);
  log(`${s.title}: downloading the geodatabase…`);
  const r = await fetch(`${st.resultUrl || job.URL}?token=${encodeURIComponent(ctx.token())}`);
  if (!r.ok) throw new Error(`geodatabase download failed (${r.status})`);
  const zip = await JSZip.loadAsync(await r.blob());
  const files = Object.values(zip.files).filter((f) => !f.dir);
  // ArcGIS names the .gdb after the service plus a number; save it as <Service_Title>.gdb like the script
  const top = files[0] && files[0].name.split("/")[0], rename = top && /\.gdb$/i.test(top) ? `${s.folder}.gdb` : null;
  let n = 0;
  for (const f of files) {
    const parts = f.name.split("/"); if (rename && parts[0] === top) parts[0] = rename;
    await writeFile(await subdir(root, parts.slice(0, -1).join("/")), parts[parts.length - 1], await f.async("uint8array"));
    if (++n % 20 === 0) log(`${s.title}: writing the geodatabase… ${n} / ${files.length} files`, true);
  }
  log(`${s.title}: ✓ ${rename || top || "geodatabase"} saved (${files.length} files).`);
}

// ---------------------------------------------------------------- photos: every attachment, into images/<layer>/<OBJECTID>_<name>
async function attachmentsFor(s, L, oids) {
  const out = [];
  if (L.queryAttachments) {
    for (let i = 0; i < oids.length; i += 200) {
      if (stopRequested) throw new Error("stopped");
      const r = await ctx.fetchJson(`${s.url}/${L.id}/queryAttachments`, { objectIds: oids.slice(i, i + 200).join(","), returnMetadata: "false" });
      if (r.error) { L.queryAttachments = false; return attachmentsFor(s, L, oids); }
      for (const g of r.attachmentGroups || []) for (const a of g.attachmentInfos || []) out.push({ oid: g.parentObjectId, ...a });
      log(`${L.name}: listing photos… ${Math.min(i + 200, oids.length).toLocaleString()} / ${oids.length.toLocaleString()} features`, true);
    }
    return out;
  }
  // older services: one request per feature, like the script
  await pool(oids, async (oid) => { const r = await ctx.fetchJson(`${s.url}/${L.id}/${oid}/attachments`, {}); for (const a of r.attachmentInfos || []) out.push({ oid, ...a }); },
    (d) => log(`${L.name}: listing photos… ${d.toLocaleString()} / ${oids.length.toLocaleString()} features`, true));
  return out;
}
async function pool(items, fn, onDone) {
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(WORKERS, items.length) }, async () => {
    while (next < items.length) {
      if (stopRequested) throw new Error("stopped");
      const it = items[next++]; await fn(it); done++; if (onDone && (done % 10 === 0 || done === items.length)) onDone(done);
    }
  }));
}
async function exportPhotos(s, root) {
  for (const L of chosen(s).filter((x) => x.photos)) {
    const ids = await ctx.fetchJson(`${s.url}/${L.id}/query`, { where: "1=1", returnIdsOnly: "true" });
    const oids = (ids.objectIds || []).sort((a, b) => a - b);
    if (!oids.length) { log(`${L.name}: no features.`); continue; }
    const atts = await attachmentsFor(s, L, oids);
    const dir = await subdir(root, `images/${safe(L.name)}`);
    let saved = 0, skipped = 0; const failed = [];
    const bar = $("xbar"); bar.hidden = false; bar.max = atts.length || 1; bar.value = 0;
    await pool(atts, async (a) => {
      const name = `${a.oid}_${a.name}`;
      if (a.size && await existingSize(dir, name) === a.size) { skipped++; return; }
      try {
        if (!ctx.token()) throw new Error("Your sign-in expired — sign in again, then click Export again; photos already saved are skipped.");
        let r;
        for (let k = 0; k < 4; k++) {
          r = await fetch(`${s.url}/${L.id}/${a.oid}/attachments/${a.id}?token=${encodeURIComponent(ctx.token())}`).catch(() => null);
          if (r && r.ok && !/json/i.test(r.headers.get("content-type") || "")) break;
          await new Promise((res) => setTimeout(res, 1000 * 2 ** k + Math.random() * 500));
        }
        if (!r || !r.ok || /json/i.test(r.headers.get("content-type") || "")) throw new Error(r ? `HTTP ${r.status}` : "network error");
        await writeFile(dir, name, await r.blob()); saved++;
      } catch (e) { if (/sign-in expired/.test(e.message)) throw e; failed.push(`${name}: ${e.message}`); }
    }, (d) => { bar.value = d; log(`${L.name}: photos ${d.toLocaleString()} / ${atts.length.toLocaleString()} (${saved.toLocaleString()} saved, ${skipped.toLocaleString()} already there${failed.length ? `, ${failed.length} failed` : ""})`, true); });
    log(`${L.name}: ✓ ${saved.toLocaleString()} photos saved${skipped ? `, ${skipped.toLocaleString()} were already there` : ""}.`);
    if (failed.length) { fail(`${L.name}: ${failed.length} photo${failed.length === 1 ? "" : "s"} failed — click Export again to retry them.`); failed.slice(0, 20).forEach((f) => log(`  ${f}`)); }
  }
}

// ---------------------------------------------------------------- run
async function run() {
  if (!window.showDirectoryPicker) { fail("Saving into a folder needs Chrome or Edge on a computer. Open this page there to export."); return; }
  let root;
  log("Pick a folder to export into. Chrome won't allow your home folder or folders with system files — use New Folder in the picker to make one, e.g. Downloads/PROW exports.");
  try { root = await window.showDirectoryPicker({ id: "prow-export", mode: "readwrite", startIn: "downloads" }); } catch { $("xlog").innerHTML = ""; return; }   // cancelled
  running = true; stopRequested = false; updateGo(); $("xstop").hidden = false; $("xlog").innerHTML = "";
  const t0 = Date.now();
  try {
    for (const s of services.filter((x) => !x.error && chosen(x).length)) {
      const dir = await subdir(root, s.folder);
      log(`— ${s.title} → ${root.name}/${s.folder}/`);
      if ($("xgdb").checked) { try { await exportGdb(s, dir); } catch (e) { if (e.message === "stopped") throw e; fail(`${s.title}: ${e.message}`); } }
      if ($("ximg").checked) await exportPhotos(s, dir);
    }
    log(`Done in ${Math.round((Date.now() - t0) / 60000)} min. Everything is in the folder “${root.name}”.`);
  } catch (e) { e.message === "stopped" ? log("Stopped. Click Export again to carry on — photos already saved are skipped.") : fail(`Error: ${e.message}`); }
  running = false; $("xstop").hidden = true; $("xbar").hidden = true; updateGo();
}

export function initExportTab(c) {
  ctx = c;
  $("mload").onclick = loadMap;
  $("map").onchange = () => { $("xsteps").hidden = true; loadedMap = null; };
  $("xgo").onclick = run;
  $("xstop").onclick = () => { stopRequested = true; log("Stopping after the downloads in progress…"); };
  $("xgdb").onchange = $("ximg").onchange = updateGo;
  if (!window.showDirectoryPicker) $("xnote").innerHTML = '<span class="warn">Exporting saves straight into a folder, which needs <b>Chrome or Edge</b> on a computer.</span>';
  // follow the map the other tabs load, like they follow each other
  window.addEventListener("prow:map-loaded", (e) => {
    const { id, source } = e.detail;
    if (source === "export" || loadedMap === id || loadingMap === id || running) return;
    if (![...$("map").options].some((o) => o.value === id)) return;
    $("map").value = id; loadMap();
  });
}
