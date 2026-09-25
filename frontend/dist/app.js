"use strict";
const $ = (id) => document.getElementById(id);
const api = () => window.go.main.App;

let roots = [];
let scanning = false;
let hasResult = false;

// ---------- formatting ----------
function gb(b) { return (b / 1e9).toFixed(1) + " GB"; }
function size(b) { return b >= 1e8 ? gb(b) : Math.max(1, Math.round(b / 1e6)) + " MB"; }
function date(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Logical size is shown under the allocated size when they differ by at
// least 10% and at least 10 MB.
function differs(alloc, logical) {
  const d = Math.abs(alloc - logical);
  return d >= 1e7 && d >= 0.1 * Math.max(alloc, logical);
}
function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500);
}
function sizeCell(r) {
  let h = `<td class="num" title="分配大小 ${r.alloc.toLocaleString()} 字节；逻辑大小 ${r.logical.toLocaleString()} 字节">${size(r.alloc)}`;
  if (differs(r.alloc, r.logical)) h += `<span class="logical">逻辑 ${size(r.logical)}</span>`;
  return h + "</td>";
}
function pathCell(p) { return `<td><a class="path" data-path="${esc(p)}" title="在文件管理器中显示">${esc(p)}</a></td>`; }

// ---------- roots ----------
function renderRoots() {
  $("rootList").innerHTML = roots.map((r, i) =>
    `<li><span>${esc(r)}</span><button data-i="${i}" title="移除">×</button></li>`).join("");
  refreshVolumes();
}
function addRoot(p) {
  p = (p || "").trim();
  if (!p || roots.includes(p)) return;
  roots.push(p); renderRoots();
}
$("rootList").addEventListener("click", (e) => {
  const i = e.target.dataset.i;
  if (i === undefined || scanning) return;
  roots.splice(+i, 1); renderRoots();
});
$("addBtn").onclick = () => { addRoot($("rootInput").value); $("rootInput").value = ""; };
$("rootInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("addBtn").onclick(); });
$("browseBtn").onclick = async () => {
  try { const d = await api().PickDirectory(); if (d) addRoot(d); } catch (e) { toast(String(e)); }
};

// ---------- volumes ----------
async function refreshVolumes() {
  const res = await api().Volumes(roots);
  const cards = res.volumes.map((v) => `
    <div class="vol">
      <div class="mount" title="${esc(v.roots.join("\n"))}">${esc(v.mount)}</div>
      <div class="pct">${v.percent.toFixed(1)}%</div>
      <div class="bar"><i style="width:${Math.min(100, v.percent).toFixed(1)}%"></i></div>
      <dl><div><dt>总容量</dt><dd>${gb(v.total)}</dd></div>
          <div><dt>已用</dt><dd>${gb(v.used)}</dd></div>
          <div><dt>可用</dt><dd>${gb(v.free)}</dd></div></dl>
    </div>`);
  const errs = (res.errors || []).map((e) => `<div class="vol"><div class="mount">${esc(e.path)}</div>无法读取：${esc(e.reason)}</div>`);
  $("volumes").innerHTML = cards.concat(errs).join("") || `<div class="empty">请添加扫描目录</div>`;
}

// ---------- scan ----------
function setScanning(on) {
  scanning = on;
  $("scanBtn").hidden = on; $("cancelBtn").hidden = !on;
  for (const id of ["addBtn", "browseBtn", "rootInput"]) $(id).disabled = on;
  $("status").classList.toggle("running", on);
}
$("scanBtn").onclick = async () => {
  if (!roots.length) { toast("请先添加要扫描的目录"); return; }
  try {
    setScanning(true);
    $("status").textContent = "正在准备扫描…";
    await api().StartScan(roots);
  } catch (e) { setScanning(false); $("status").textContent = String(e); }
};
$("cancelBtn").onclick = () => { $("status").textContent = "正在取消…"; api().CancelScan(); };

function onProgress(p) {
  if (!scanning) return;
  $("status").textContent = `已走过 ${p.walked.toLocaleString()} 个文件　失败 ${p.failed.toLocaleString()}　当前：${p.current}`;
  $("status").title = p.current;
}
function onDone(s) {
  setScanning(false);
  hasResult = s.hasResult;
  const head = s.canceled ? "扫描已取消（结果不完整）" : "扫描完成";
  $("status").textContent = `${head}：共走过 ${s.walked.toLocaleString()} 个文件，失败 ${s.failed.toLocaleString()} 个，用时 ${s.seconds.toFixed(1)} 秒。`;
  $("status").title = "";
  const fs = $("failSec");
  fs.hidden = s.failed === 0;
  if (s.failed) {
    const parts = Object.entries(s.failByReason).map(([k, v]) => `${k} ${v}`).join("，");
    $("failSummary").textContent = `跳过 ${s.failed.toLocaleString()} 个无法读取的路径（${parts}）` +
      (s.failSamples.length < s.failed ? `，下面列出前 ${s.failSamples.length} 个` : "");
    $("failList").innerHTML = s.failSamples.map((f) => `<li><span>${esc(f.reason)}</span>${esc(f.path)}</li>`).join("");
  }
  refreshVolumes();
  queryDirs(); queryFiles();
}

// ---------- tables ----------
function num(id, def) { const v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v : def; }
function countText(n, shown) { return n > shown ? `共 ${n.toLocaleString()} 条，显示前 ${shown.toLocaleString()} 条` : `共 ${n.toLocaleString()} 条`; }

async function queryDirs() {
  if (!hasResult) return;
  const res = await api().QueryDirs(Math.round(num("dirMin", 1) * 1e9));
  $("dirCount").textContent = countText(res.total, res.rows.length);
  $("dirBody").innerHTML = res.rows.length
    ? res.rows.map((r) => `<tr>${sizeCell(r)}${pathCell(r.path)}</tr>`).join("")
    : `<tr><td colspan="2" class="empty">没有达到阈值的目录</td></tr>`;
}
async function queryFiles() {
  if (!hasResult) return;
  const floorMB = 1;
  const mb = Math.max(floorMB, num("fileMin", 500));
  const res = await api().QueryFiles(Math.round(mb * 1e6), Math.round(num("fileDays", 60)));
  $("fileCount").textContent = countText(res.total, res.rows.length);
  $("fileBody").innerHTML = res.rows.length
    ? res.rows.map((r) => `<tr>${sizeCell(r)}<td class="date">${date(r.appeared)}${r.appearedIsMtime
        ? `<span class="badge" title="该文件系统未提供创建时间，出现日期使用修改时间">修改时间</span>` : ""}</td><td class="date">${date(r.modified)}</td>${pathCell(r.path)}</tr>`).join("")
    : `<tr><td colspan="4" class="empty">没有符合条件的文件</td></tr>`;
}
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
$("dirMin").addEventListener("input", debounce(queryDirs, 200));
$("fileMin").addEventListener("input", debounce(queryFiles, 200));
$("fileDays").addEventListener("input", debounce(queryFiles, 200));

document.addEventListener("click", async (e) => {
  const a = e.target.closest("a.path");
  if (!a) return;
  e.preventDefault();
  try { await api().Reveal(a.dataset.path); } catch (err) { toast(String(err)); }
});

// ---------- init ----------
window.addEventListener("DOMContentLoaded", async () => {
  window.runtime.EventsOn("scan:progress", onProgress);
  window.runtime.EventsOn("scan:done", onDone);
  $("version").textContent = "v" + (await api().Version());
  roots = await api().DefaultRoots();
  renderRoots();
});
