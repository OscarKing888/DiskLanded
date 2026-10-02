"use strict";
const $ = (id) => document.getElementById(id);
const api = () => window.go.main.App;

let roots = [];
let scanning = false;
let hasResult = false;
let trashing = false;
let fileQueryID = 0;
let dirRows = [], fileRows = [];
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
  let head = s.canceled ? "扫描已取消（结果不完整）" : "扫描完成";
  if (s.restored) head = `已加载上次扫描结果（${new Date(s.started).toLocaleString("zh-CN")}）${s.canceled ? "，结果不完整" : ""}`;
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
  if (s.cacheError) toast(s.cacheError);
  return Promise.all([refreshVolumes(), queryDirs(), queryFiles(), graph.refresh(true)]);
}

// ---------- tables ----------
function num(id, def) { const v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v : def; }
function countText(n, shown) { return n > shown ? `共 ${n.toLocaleString()} 条，显示前 ${shown.toLocaleString()} 条` : `共 ${n.toLocaleString()} 条`; }

async function queryDirs() {
  if (!hasResult) return;
  const res = await api().QueryDirs(Math.round(num("dirMin", 1) * 1e9));
  dirRows = res.rows;
  $("dirCount").textContent = countText(res.total, res.rows.length);
  $("dirBody").innerHTML = res.rows.length
    ? res.rows.map((r, i) => `<tr data-row="${i}">${sizeCell(r)}${pathCell(r.path)}</tr>`).join("")
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
  fileRows = res.rows;
  $("fileCount").textContent = countText(res.total, res.rows.length);
  $("fileBody").innerHTML = res.rows.length
    ? res.rows.map((r, i) => `<tr data-row="${i}">${sizeCell(r)}<td class="date">${date(r.appeared)}${r.appearedIsMtime
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
    const summary = await api().Summary();
    if (summary.cacheError) toast("文件已移入回收站，但" + summary.cacheError);
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

// ---------- context menu ----------
// 右键文件或目录弹出菜单：文件可加入/移出待删除；目录不能删除（产品约束），只提供查看与定位。
function baseName(p) { return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p; }
function rowNode(r, kind) { return { ...r, name: baseName(r.path), kind, children: [] }; }
function contextNode(el) {
  const row = el.closest("#dirBody tr[data-row], #fileBody tr[data-row]");
  if (row) {
    const dirs = row.parentElement.id === "dirBody", r = (dirs ? dirRows : fileRows)[+row.dataset.row];
    return r ? { node: rowNode(r, dirs ? "dir" : "file"), from: "list" } : null;
  }
  const chip = el.closest("#collectorItems > span[data-path]");
  if (chip) return graph.collected.has(chip.dataset.path) ? { node: graph.collected.get(chip.dataset.path), from: "collector" } : null;
  const node = graph.nodeFromElement(el);
  return node && node.kind !== "other" ? { node, from: "graph" } : null;
}
async function copyPath(path) {
  try {
    if (window.runtime && window.runtime.ClipboardSetText) await window.runtime.ClipboardSetText(path);
    else await navigator.clipboard.writeText(path);
    toast("已复制路径");
  } catch (err) { toast("复制失败：" + String(err)); }
}
async function revealPath(path) { try { await api().Reveal(path); } catch (err) { toast(String(err)); } }
// 目录本身不删除；可把其中达到「单个文件至少」阈值的文件一次加入待删除，打开菜单后再统计数量。
function dirFilesItem(dir) {
  const mb = Math.max(1, num("fileMin", 500));
  return {
    label: `正在查找其中 ≥ ${mb} MB 的文件…`, hint: "目录本身不会删除", disabled: true,
    async load() {
      const res = await api().QueryDirFiles(dir.path, Math.round(mb * 1e6));
      const files = res.rows.filter((r) => !graph.collected.has(r.path)).map((r) => rowNode(r, "file"));
      const size = graphSize(files.reduce((sum, f) => sum + f.alloc, 0));
      if (!res.total) return { label: `其中没有 ≥ ${mb} MB 的文件`, hint: "阈值与「单个文件至少」设置相同" };
      if (!files.length) return { label: "其中的大文件均已在待删除中", hint: `共 ${res.total} 个 ≥ ${mb} MB 的文件` };
      return {
        label: `将其中 ${files.length} 个 ≥ ${mb} MB 的文件加入待删除`,
        hint: `共 ${size}${res.total > res.rows.length ? `，按大小取前 ${res.rows.length} 个` : ""}；目录本身不会删除`,
        disabled: scanning || trashing, run: () => graph.collectMany(files),
      };
    },
  };
}
function contextItems({ node, from }) {
  const busy = scanning || trashing, items = [];
  if (node.kind === "file") {
    items.push(graph.collected.has(node.path)
      ? { label: "移出待删除", run: () => graph.removeCollected(node.path), disabled: trashing }
      : { label: "加入待删除", run: () => graph.collect(node), disabled: busy });
  } else if (node.kind === "group") {
    const files = graph.groupFiles(node).filter((f) => !graph.collected.has(f.path));
    items.push({ label: files.length ? `将其中 ${files.length} 个新文件加入待删除` : "其中的文件均已在待删除中", run: () => graph.collectMany(files), disabled: busy || !files.length });
  } else if (node.kind === "dir") {
    if (from === "list") items.push({ label: "在图形中查看", run: () => { setResultView("graph"); graph.showDirectory(node.path); }, disabled: scanning });
    else if (graph.mode === "dirs") items.push({ label: "进入目录", run: () => graph.activate(node), disabled: scanning });
    items.push(dirFilesItem(node));
  }
  if (node.path) {
    items.push({ separator: true });
    items.push({ label: "在文件管理器中显示", run: () => revealPath(node.path) });
    items.push({ label: "复制路径", run: () => copyPath(node.path) });
  }
  return items;
}
const contextMenu = {
  el: $("contextMenu"), items: [], restore: null, serial: 0,
  html(item, i) {
    return item.separator ? '<hr>' : `<button role="menuitem" data-i="${i}" ${item.disabled ? 'disabled' : ''} ${item.hint ? `title="${esc(item.hint)}"` : ''}>${esc(item.label)}${item.hint ? `<small>${esc(item.hint)}</small>` : ''}</button>`;
  },
  // 异步项目（如目录中的大文件数量）返回后只替换该项；菜单已关闭或重新打开则忽略。
  async load(index, serial) {
    let next;
    try { next = await this.items[index].load(); }
    catch (err) { next = { label: "无法统计其中的文件", hint: String(err) }; }
    if (serial !== this.serial || this.el.hidden) return;
    this.items[index] = next = { disabled: !next.run, ...next };
    const button = this.el.querySelector(`button[data-i="${index}"]`);
    if (button) button.outerHTML = this.html(next, index);
    this.place(this.x, this.y);
  },
  place(x, y) {
    this.x = x; this.y = y;
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    this.el.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + "px";
    this.el.style.top = Math.max(4, Math.min(y, innerHeight - h - 4)) + "px";
  },
  open(target, x, y) {
    const items = contextItems(target);
    graph.cancelHover();
    this.items = items; this.restore = document.activeElement;
    this.el.innerHTML = `<div class="contextTitle" title="${esc(target.node.path || target.node.name)}">${esc(target.node.name)}</div>` +
      items.map((item, i) => this.html(item, i)).join("");
    const serial = ++this.serial;
    items.forEach((item, i) => { if (item.load) this.load(i, serial); });
    this.el.hidden = false;
    this.place(x, y);
    const first = this.el.querySelector("button:not(:disabled)");
    if (first) first.focus(); else this.el.focus();
  },
  close(restoreFocus) {
    if (this.el.hidden) return;
    this.el.hidden = true; this.items = []; ++this.serial;
    if (restoreFocus && this.restore && this.restore.focus) this.restore.focus();
    this.restore = null;
  },
};
document.addEventListener("contextmenu", (e) => {
  const target = contextNode(e.target);
  if (!target) { contextMenu.close(); return; }
  e.preventDefault();
  // 键盘触发（Shift+F10 / 菜单键）时没有指针坐标，定位到元素旁边。
  let x = e.clientX, y = e.clientY;
  if (!x && !y) { const box = e.target.getBoundingClientRect(); x = box.left + 12; y = box.bottom; }
  contextMenu.open(target, x, y);
});
contextMenu.el.addEventListener("click", (e) => {
  const button = e.target.closest("button[data-i]");
  if (!button || button.disabled) return;
  const item = contextMenu.items[+button.dataset.i];
  contextMenu.close(true);
  item.run();
});
contextMenu.el.addEventListener("keydown", (e) => {
  const buttons = Array.from(contextMenu.el.querySelectorAll("button:not(:disabled)"));
  const index = buttons.indexOf(document.activeElement);
  if (e.key === "Escape") { e.preventDefault(); contextMenu.close(true); }
  else if (e.key === "Tab") contextMenu.close(false);
  else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && buttons.length) {
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }
});
document.addEventListener("pointerdown", (e) => { if (!contextMenu.el.contains(e.target)) contextMenu.close(); }, true);
window.addEventListener("blur", () => contextMenu.close());
window.addEventListener("resize", () => contextMenu.close());
document.addEventListener("scroll", (e) => { if (!contextMenu.el.contains(e.target)) contextMenu.close(); }, true);

// ---------- init ----------
window.addEventListener("DOMContentLoaded", async () => {
  window.runtime.EventsOn("scan:progress", onProgress);
  window.runtime.EventsOn("scan:done", (s) => {
    onDone(s).catch((err) => toast("刷新扫描结果失败：" + String(err)));
  });
  $("version").textContent = "v" + (await api().Version());
  $("scanBtn").disabled = true;
  try {
    const summary = await api().Summary();
    roots = summary.hasResult ? summary.roots : await api().DefaultRoots();
    renderRoots();
    if (summary.hasResult) await onDone(summary);
    else if (summary.cacheError) toast(summary.cacheError);
  } catch (err) {
    toast("加载扫描结果失败：" + String(err));
  } finally {
    updateTrashButtons();
  }
});
