"use strict";

const graphHues = [155, 182, 211, 244, 275, 313, 340, 34, 67, 105];
function graphSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + " KB";
  return Math.max(0, bytes) + " B";
}
function sectorPath(inner, outer, start, end) {
  const span = Math.min(end - start, Math.PI * 2 - 0.000001);
  if (!Number.isFinite(span) || span <= 0) return "";
  end = start + span;
  const point = (r, a) => `${(320 + r * Math.cos(a)).toFixed(3)},${(320 + r * Math.sin(a)).toFixed(3)}`;
  const large = span > Math.PI ? 1 : 0;
  return `M${point(outer, start)} A${outer},${outer} 0 ${large} 1 ${point(outer, end)} L${point(inner, end)} A${inner},${inner} 0 ${large} 0 ${point(inner, start)} Z`;
}
function graphSegments(root) {
  const segments = [];
  function walk(parent, start, end, depth, hue, lineage) {
    if (depth >= 4 || parent.alloc <= 0) return;
    let angle = start;
    (parent.children || []).forEach((node, i) => {
      const next = Math.min(end, angle + (end - start) * node.alloc / parent.alloc);
      const colorHue = depth === 0 ? graphHues[i % graphHues.length] : hue;
      const branch = lineage.concat(node.path);
      if (next - angle > 0.00001) {
        const color = node.kind === "other" ? "#626873" : node.kind === "file"
          ? `hsl(${colorHue}, 17%, ${61 + depth * 4}%)` : `hsl(${colorHue}, 89%, ${56 + depth * 7}%)`;
        segments.push({ node, color, lineage: branch, d: sectorPath(85 + depth * 52, 136 + depth * 52, angle, next) });
        walk(node, angle, next, depth + 1, colorHue, branch);
      }
      angle = next;
    });
  }
  walk(root, -Math.PI / 2, Math.PI * 1.5, 0, 155, []);
  return segments;
}

class DiskGraph {
  constructor() {
    this.mode = "dirs";
    this.history = { dirs: { paths: [""], index: 0 }, files: { paths: [""], index: 0 } };
    this.request = 0;
    this.data = null;
    this.selected = null;
    this.segments = [];
    this.collected = new Map();
    this.bind();
    this.renderCollector();
  }
  bind() {
    $("graphDirs").onclick = () => this.changeMode("dirs");
    $("graphFiles").onclick = () => this.changeMode("files");
    $("graphBack").onclick = () => this.travel(-1);
    $("graphForward").onclick = () => this.travel(1);
    $("graphBreadcrumbs").onclick = (e) => {
      const button = e.target.closest("button[data-path]");
      if (button) this.navigate(button.dataset.path);
    };
    $("sunburst").addEventListener("pointerover", (e) => {
      const path = e.target.closest("path[data-node]");
      if (path) this.highlight(this.segments[+path.dataset.node].node);
    });
    $("sunburst").addEventListener("pointermove", (e) => {
      const path = e.target.closest("path[data-node]");
      if (!path) { $("graphTooltip").hidden = true; return; }
      const n = this.segments[+path.dataset.node].node;
      const tip = $("graphTooltip"), bounds = $("sunburst").parentElement.getBoundingClientRect();
      tip.textContent = `${n.name} · ${graphSize(n.alloc)}`;
      tip.hidden = false;
      tip.style.left = Math.max(8, Math.min(bounds.width - tip.offsetWidth - 8, e.clientX - bounds.left + 12)) + "px";
      tip.style.top = Math.max(8, Math.min(bounds.height - tip.offsetHeight - 30, e.clientY - bounds.top + 12)) + "px";
    });
    $("sunburst").addEventListener("pointerleave", () => { this.highlight(this.selected); $("graphTooltip").hidden = true; });
    const activate = (e) => {
      const path = e.target.closest("path[data-node]");
      if (path) this.activate(this.segments[+path.dataset.node].node);
      else if (e.target.closest(".graphCenter")) this.up();
    };
    $("sunburst").onclick = activate;
    $("sunburst").onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(e); }
      if (e.key === "Backspace") { e.preventDefault(); this.up(); }
    };
    $("graphLegend").onpointerover = (e) => {
      const row = e.target.closest("[data-child]");
      if (row) this.highlight(this.data.root.children[+row.dataset.child]);
    };
    $("graphLegend").onpointerleave = () => this.highlight(this.selected);
    $("graphLegend").onclick = (e) => {
      const row = e.target.closest("[data-child]");
      if (row) this.activate(this.data.root.children[+row.dataset.child]);
    };
    $("graphLegend").onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("graphLegend").onclick(e); }
    };
    $("graphDetail").onclick = async (e) => {
      const collect = e.target.closest("[data-collect]");
      if (collect && this.selected) this.collect(this.selected);
      const reveal = e.target.closest("[data-reveal]");
      if (reveal) { try { await api().Reveal(reveal.dataset.reveal); } catch (err) { toast(String(err)); } }
    };
    this.bindFileDrag();
    $("collectorClear").onclick = () => { this.collected.clear(); this.renderCollector(); };
    $("collectorItems").onclick = (e) => {
      const button = e.target.closest("button[data-remove]");
      if (button && !trashing) { this.collected.delete(button.dataset.remove); this.renderCollector(); }
    };
    $("collectorTrash").onclick = () => this.trashCollected();
  }
  bindFileDrag() {
    // 使用指针捕获，兼容 macOS WKWebView 和 Windows WebView2 的拖动行为。
    for (const id of ["sunburst", "graphLegend", "graphDetail"]) {
      const surface = $(id);
      let drag = null, suppressClick = false;
      surface.ondragstart = (e) => e.preventDefault();
      surface.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || scanning || trashing || e.target.closest(".detailActions")) return;
        const sector = e.target.closest("path[data-node]"), file = e.target.closest("[data-file]");
        const node = sector ? this.segments[+sector.dataset.node].node : file && this.segments.find((s) => s.node.path === file.dataset.file)?.node;
        if (!node || node.kind !== "file") return;
        drag = { node, x: e.clientX, y: e.clientY, moved: false };
        e.preventDefault(); surface.setPointerCapture(e.pointerId);
      });
      const inside = (e) => {
        const box = $("collector").getBoundingClientRect();
        return e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
      };
      surface.addEventListener("pointermove", (e) => {
        if (!drag) return;
        drag.moved ||= Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8;
        $("collector").classList.toggle("dragover", drag.moved && inside(e));
      });
      surface.addEventListener("pointerup", (e) => {
        if (!drag) return;
        const pending = drag; drag = null;
        $("collector").classList.remove("dragover");
        if (!pending.moved) return;
        suppressClick = true;
        if (inside(e)) this.collect(pending.node);
        setTimeout(() => { suppressClick = false; }, 0);
      });
      surface.addEventListener("pointercancel", () => { drag = null; $("collector").classList.remove("dragover"); });
      surface.addEventListener("click", (e) => {
        if (suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); }
      }, true);
    }
  }
  changeMode(mode) {
    this.mode = mode; this.selected = null;
    $("graphDirs").classList.toggle("active", mode === "dirs");
    $("graphFiles").classList.toggle("active", mode === "files");
    $("graphDirs").setAttribute("aria-pressed", String(mode === "dirs"));
    $("graphFiles").setAttribute("aria-pressed", String(mode === "files"));
    $("graphFilters").hidden = mode !== "files";
    $("sunburst").setAttribute("aria-label", mode === "dirs" ? "目录占用环形图" : "新出现文件占用环形图");
    this.refresh(this.history[mode].paths.length === 1);
  }
  reset() {
    ++this.request; this.data = null; this.selected = null;
    this.history = { dirs: { paths: [""], index: 0 }, files: { paths: [""], index: 0 } };
    this.collected.clear(); this.renderCollector();
    $("sunburst").innerHTML = ""; $("graphLegend").innerHTML = "";
    $("graphDetail").innerHTML = "<p>正在扫描，完成后显示图形结果。</p>";
    $("graphTitle").textContent = "扫描目录"; $("graphTotal").textContent = "—";
    $("graphPath").textContent = "扫描完成后显示目录和文件明细";
    $("graphBreadcrumbs").innerHTML = "<span>扫描目录</span>";
    this.empty("正在扫描…", "可以随时取消，完成后显示已扫描的结果");
    this.syncControls();
  }
  empty(title, subtitle) {
    $("graphEmpty").innerHTML = `<strong>${esc(title)}</strong><span>${esc(subtitle)}</span>`;
    $("graphEmpty").hidden = false;
  }
  async refresh(autoFocus = false) {
    if (!hasResult) return;
    const token = ++this.request, mode = this.mode, history = this.history[mode];
    let path = history.paths[history.index];
    const fetch = (p) => api().QueryGraph(p, mode, Math.round(Math.max(1, num("fileMin", 500)) * 1e6), Math.min(36500, Math.round(num("fileDays", 60))));
    $("graphView").setAttribute("aria-busy", "true");
    try {
      let data;
      try { data = await fetch(path); }
      catch (err) {
        if (!path) throw err;
        data = await fetch(""); path = "";
      }
      if (token !== this.request) return;
      if (autoFocus && !path && data.root.children.length === 1 && data.root.children[0].kind === "dir") {
        path = data.root.children[0].path; data = await fetch(path);
        if (token !== this.request) return;
        history.paths = ["", path]; history.index = 1;
      } else if (path !== history.paths[history.index]) { history.paths = [""]; history.index = 0; }
      this.data = data; this.selected = null; this.render();
    } catch (err) {
      if (token === this.request) { this.empty("暂时无法显示图形", String(err)); toast(String(err)); }
    } finally { if (token === this.request) $("graphView").setAttribute("aria-busy", "false"); }
  }
  navigate(path) {
    const h = this.history[this.mode];
    if (h.paths[h.index] === path) return;
    h.paths = h.paths.slice(0, h.index + 1).concat(path); ++h.index;
    this.refresh();
  }
  travel(step) {
    const h = this.history[this.mode], index = h.index + step;
    if (index < 0 || index >= h.paths.length) return;
    h.index = index; this.refresh();
  }
  up() {
    if (this.data && this.data.breadcrumbs.length > 1) this.navigate(this.data.breadcrumbs[this.data.breadcrumbs.length - 2].path);
  }
  activate(node) {
    if (scanning) return;
    if (node.kind === "dir") this.navigate(node.path);
    else if (node.kind === "file") { this.selected = node; this.highlight(node); }
    else this.showDetail(node);
  }
  render() {
    const root = this.data.root;
    $("graphTooltip").hidden = true;
    this.segments = graphSegments(root);
    $("graphEmpty").hidden = root.alloc > 0;
    if (root.alloc <= 0) this.empty(this.mode === "files" ? "没有符合条件的新文件" : "这个目录暂无占用数据", "可以调整筛选条件或重新扫描");
    const label = graphSize(root.alloc).split(" ");
    $("sunburst").innerHTML = this.segments.map((s, i) => `<path data-node="${i}" d="${s.d}" fill="${s.color}" tabindex="${s.node.kind === "other" ? -1 : 0}" role="button" aria-label="${esc(s.node.name)} ${graphSize(s.node.alloc)}${s.node.kind === "dir" ? '，点击进入目录' : ''}"><title>${esc(s.node.name)} · ${graphSize(s.node.alloc)}</title></path>`).join("") +
      `<g class="graphCenter" tabindex="0" role="button" aria-label="返回上层目录"><circle cx="320" cy="320" r="76"/><text x="320" y="310" class="centerValue">${label[0]}</text><text x="320" y="343" class="centerUnit">${label[1]}</text><text x="320" y="369" class="centerBack">${this.data.breadcrumbs.length > 1 ? '↑ 返回上层' : '扫描目录'}</text></g>`;
    $("graphTitle").textContent = root.name;
    $("graphTotal").textContent = graphSize(root.alloc);
    $("graphPath").textContent = root.path || "全部扫描目录";
    $("graphBreadcrumbs").innerHTML = this.data.breadcrumbs.map((n) => `<button data-path="${esc(n.path)}" title="${esc(n.path || n.name)}">${esc(n.name)}</button>`).join('<span aria-hidden="true">›</span>');
    $("graphLegend").innerHTML = root.children.map((n, i) => {
      const sector = this.segments.find((s) => s.node === n);
      return `<div class="legendRow ${n.kind === "other" ? 'other' : ''}" data-child="${i}" tabindex="0" role="button" aria-label="${esc(n.name)} ${graphSize(n.alloc)}" ${n.kind === "file" ? `draggable="true" data-file="${esc(n.path)}"` : ''} title="${esc(n.path || '小文件、目录元数据与合并显示的项目')}"><i style="background:${sector ? sector.color : '#626873'}"></i><span>${esc(n.name)}${n.kind === "dir" ? ' <b>›</b>' : ''}</span><strong>${graphSize(n.alloc)}</strong></div>`;
    }).join("");
    this.showDetail(null); this.syncControls();
  }
  highlight(node) {
    const active = node && node.kind !== "other" ? node.path : null;
    for (const path of $("sunburst").querySelectorAll("path[data-node]")) {
      const segment = this.segments[+path.dataset.node];
      path.classList.toggle("dim", !!active && !segment.lineage.includes(active));
      path.classList.toggle("highlight", !!active && segment.node.path === active);
    }
    for (const row of $("graphLegend").querySelectorAll("[data-child]")) row.classList.toggle("highlight", !!active && this.data.root.children[+row.dataset.child].path === active);
    this.showDetail(node || this.selected);
  }
  showDetail(node) {
    if (!node) {
      $("graphDetail").innerHTML = `<p>${this.mode === "files" ? '仅显示符合大小和出现日期筛选的文件。' : '扇区宽度表示占用大小，从内到外表示目录层级。'}</p><p>灰色为文件或合并的较小项目。点击文件查看日期、定位或加入待删除。</p>`;
      return;
    }
    const percent = this.data.root.alloc ? (node.alloc / this.data.root.alloc * 100).toFixed(1) : "0.0";
    const files = node.kind === "file";
    $("graphDetail").innerHTML = `<div ${files ? `draggable="true" data-file="${esc(node.path)}"` : ''}><h3>${esc(node.name)}</h3><p class="detailPath">${esc(node.path)}</p><div class="detailSize">${graphSize(node.alloc)} <span>${percent}%</span></div>${differs(node.alloc, node.logical) && node.kind !== 'other' ? `<p>逻辑大小 ${graphSize(node.logical)}</p>` : ''}${files ? `<p>出现日期 ${date(node.appeared)}${node.appearedIsMtime ? '（修改时间）' : ''}<br>修改日期 ${date(node.modified)}</p>` : ''}</div>${this.selected === node && files ? `<div class="detailActions"><button data-reveal="${esc(node.path)}">定位</button><button data-collect="true" ${scanning || trashing ? 'disabled' : ''}>加入待删除</button><button class="trash" data-path="${esc(node.path)}">删除</button></div>` : `<p>${files ? '点击文件可定位、加入待删除，或拖到下方待删除区。' : node.kind === 'dir' ? '点击进入此目录，查看下一层。' : '小文件、目录元数据及超过显示数量的项目合并于此。'}</p>`}`;
    for (const button of $("graphDetail").querySelectorAll("button.trash")) button.disabled = scanning || trashing;
  }
  collect(node) {
    if (node.kind !== "file" || scanning || trashing) return;
    this.collected.set(node.path, node); this.renderCollector(); toast("已加入待删除，文件尚未移动");
  }
  removeCollected(path) { this.collected.delete(path); this.renderCollector(); }
  renderCollector() {
    const nodes = Array.from(this.collected.values()), total = nodes.reduce((sum, n) => sum + n.alloc, 0);
    $("collectorCount").textContent = nodes.length ? `${nodes.length} 个待删除文件 · ${graphSize(total)}` : "待删除文件";
    $("collectorHint").textContent = nodes.length ? "点击移入回收站后才会移动文件，可在系统回收站恢复" : "将文件拖到这里，或在详情中加入待删除";
    $("collectorItems").innerHTML = nodes.map((n) => `<span title="${esc(n.path)}">${esc(n.name)}<button data-remove="${esc(n.path)}" aria-label="移除待选 ${esc(n.name)}" ${trashing ? 'disabled' : ''}>×</button></span>`).join("");
    this.syncControls();
  }
  syncControls() {
    const h = this.history[this.mode];
    $("graphBack").disabled = scanning || h.index === 0;
    $("graphForward").disabled = scanning || h.index >= h.paths.length - 1;
    for (const id of ["collectorClear", "collectorTrash"]) $(id).disabled = scanning || trashing || this.collected.size === 0;
    for (const button of $("collectorItems").querySelectorAll("button")) button.disabled = scanning || trashing;
    for (const button of $("graphDetail").querySelectorAll("button[data-collect]")) button.disabled = scanning || trashing;
  }
  async trashCollected() {
    if (scanning || trashing || !this.collected.size) return;
    trashing = true; ++fileQueryID; updateTrashButtons();
    let success = 0, errors = [];
    for (const node of Array.from(this.collected.values())) {
      try { await api().TrashFile(node.path); this.collected.delete(node.path); ++success; }
      catch (err) { errors.push(node.name + ": " + String(err)); }
    }
    $("scanHint").hidden = success === 0 && $("scanHint").hidden;
    try {
      await Promise.all([queryFiles(), refreshVolumes(), this.refresh()]);
      const summary = await api().Summary();
      if (summary.cacheError) errors.push(summary.cacheError);
    }
    catch (err) { errors.push("刷新结果失败：" + String(err)); }
    finally { trashing = false; this.renderCollector(); updateTrashButtons(); }
    toast(`已将 ${success} 个文件移入回收站` + (errors.length ? `；${errors.length} 项未完成：${errors.join("；")}` : ""));
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = { graphSize, sectorPath, graphSegments };
