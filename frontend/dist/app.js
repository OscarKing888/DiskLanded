"use strict";
const $ = (id) => document.getElementById(id);
const api = () => window.go.main.App;

let roots = [];
let scanning = false;
let hasResult = false;
let trashing = false;
let fileQueryID = 0;
const graph = new DiskGraph();

function setResultView(view) {
  document.body.dataset.view = view;
  $("volumeSection").open = view === "list";
  for (const mode of ["graph", "list"]) {
    const active = mode === view, tab = $(mode + "Tab");
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    $(mode + "View").hidden = !active;
  }
}
for (const mode of ["graph", "list"]) {
  $(mode + "Tab").onclick = () => setResultView(mode);
  $(mode + "Tab").onkeydown = (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const next = e.key === "Home" ? "graph" : e.key === "End" ? "list" : mode === "graph" ? "list" : "graph";
      setResultView(next); $(next + "Tab").focus();
    }
  };
}

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
  $("volumeSummary").textContent = res.volumes.map((v) => `${v.mount} · 已用 ${v.percent.toFixed(1)}% · 可用 ${gb(v.free)}`).join("　") || "请添加扫描目录";
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
  updateTrashButtons();
}
function updateTrashButtons() {
  for (const button of document.querySelectorAll("button.trash")) button.disabled = scanning || trashing;
  $("scanBtn").disabled = trashing;
  graph.syncControls();
}
$("scanBtn").onclick = async () => {
  if (!roots.length) { toast("请先添加要扫描的目录"); return; }
  const previousResult = hasResult;
  try {
    setScanning(true);
    hasResult = false; ++fileQueryID; graph.reset();
    $("status").textContent = "正在准备扫描…";
    await api().StartScan(roots);
  } catch (e) { hasResult = previousResult; setScanning(false); $("status").textContent = String(e); graph.refresh(true); }
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
  $("scanHint").hidden = true;
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
  graph.refresh(true);
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
  const queryID = ++fileQueryID;
  const floorMB = 1;
  const mb = Math.max(floorMB, num("fileMin", 500));
  const res = await api().QueryFiles(Math.round(mb * 1e6), Math.min(36500, Math.round(num("fileDays", 60))));
  // 删除或修改筛选条件后，忽略旧请求，避免已删除的文件重新出现在列表。
  if (queryID !== fileQueryID) return;
  $("fileCount").textContent = countText(res.total, res.rows.length);
  $("fileBody").innerHTML = res.rows.length
    ? res.rows.map((r) => `<tr>${sizeCell(r)}<td class="date">${date(r.appeared)}${r.appearedIsMtime
        ? `<span class="badge" title="该文件系统未提供创建时间，出现日期使用修改时间">修改时间</span>` : ""}</td><td class="date">${date(r.modified)}</td>${pathCell(r.path)}<td class="action"><button class="trash" data-path="${esc(r.path)}" title="移入系统回收站，可在回收站恢复" aria-label="删除 ${esc(r.path)}">删除</button></td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">没有符合条件的文件</td></tr>`;
  updateTrashButtons();
}

async function trashFile(button) {
  if (scanning || trashing || button.disabled) return;
  trashing = true;
  ++fileQueryID;
  updateTrashButtons();
  button.textContent = "删除中…";
  try {
    await api().TrashFile(button.dataset.path);
  } catch (err) {
    toast(String(err));
    button.textContent = "删除";
    trashing = false;
    updateTrashButtons();
    return;
  }
  const row = button.closest("tr");
  if (row) row.remove();
  graph.removeCollected(button.dataset.path);
  $("scanHint").hidden = false;
  toast("已移入回收站，可在系统回收站恢复");
  try {
    await Promise.all([queryFiles(), refreshVolumes(), graph.refresh()]);
  } catch (err) {
    toast("文件已移入回收站，刷新失败，请重新扫描：" + String(err));
  } finally {
    trashing = false;
    updateTrashButtons();
  }
}
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
$("dirMin").addEventListener("input", debounce(queryDirs, 200));
for (const [list, visual] of [["fileMin", "graphFileMin"], ["fileDays", "graphFileDays"]]) {
  for (const [source, target] of [[list, visual], [visual, list]]) {
    $(source).addEventListener("input", debounce(() => {
      $(target).value = $(source).value;
      queryFiles(); if (graph.mode === "files") graph.refresh();
    }, 200));
  }
}

document.addEventListener("click", async (e) => {
  const button = e.target.closest("button.trash");
  if (button) { await trashFile(button); return; }
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
