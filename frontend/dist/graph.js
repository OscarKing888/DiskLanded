"use strict";

// 参考 DaisyDisk：颜色取自扇区中点在色环上的位置，整圈形成连续的明亮彩虹，
// 子项沿父项附近的色相渐变；合并的小项目使用深灰，不抢占视线。
const graphOtherColor = "#41454e";
const graphHueOffset = 330;
function hslColor(hue, saturation, lightness) {
  const s = saturation / 100, l = lightness / 100, a = s * Math.min(l, 1 - l);
  const channel = (n) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0");
  };
  return "#" + channel(0) + channel(8) + channel(4);
}
// fraction 为扇区中点在整圈中的位置（0–1，从 12 点方向顺时针）；越外层越亮。
function graphColor(fraction, depth = 0) {
  const hue = ((graphHueOffset + fraction * 360) % 360 + 360) % 360;
  return hslColor(hue, 82, Math.min(80, 68 + depth * 3));
}
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
  const segments = [], origin = -Math.PI / 2;
  function walk(parent, start, end, depth, lineage) {
    if (depth >= 4 || parent.alloc <= 0) return;
    let angle = start;
    (parent.children || []).forEach((node) => {
      const next = Math.min(end, angle + (end - start) * node.alloc / parent.alloc);
      const branch = lineage.concat(node.path);
      if (next - angle > 0.00001) {
        const color = node.kind === "other" ? graphOtherColor : graphColor(((angle + next) / 2 - origin) / (Math.PI * 2), depth);
        segments.push({ node, color, lineage: branch, d: sectorPath(85 + depth * 52, 136 + depth * 52, angle, next) });
        walk(node, angle, next, depth + 1, branch);
      }
      angle = next;
    });
  }
  walk(root, origin, origin + Math.PI * 2, 0, []);
  return segments;
}

function graphMarkup(segments) {
  // 层级只在绘图时建立；悬停通过 <use> 引用分支，不逐一修改上千个扇区。
  const parts = [];
  let depth = 0;
  segments.forEach((s, i) => {
    while (depth >= s.lineage.length) { parts.push("</g>"); --depth; }
    parts.push(`<g id="graphBranch${i}"><path data-node="${i}" data-kind="${s.node.kind}" d="${s.d}" fill="${s.color}" tabindex="${s.node.kind === "other" ? -1 : 0}" role="button" aria-label="${esc(s.node.name)} ${graphSize(s.node.alloc)}${s.node.kind === "dir" ? '，点击进入目录' : ''}"/>`);
    ++depth;
  });
  while (depth-- > 0) parts.push("</g>");
  return `<g id="graphSectors">${parts.join("")}</g><g id="graphHover" aria-hidden="true" display="none"><use id="graphHoverBranch"/><path id="graphHoverOutline"/></g>`;
}

// ---------- 新出现的文件：时间线气泡图 ----------
// 横轴为出现日期，圆面积表示分配大小，颜色区分文件所在目录。
const timelineBox = { width: 900, height: 440, left: 30, right: 30, top: 16, axis: 396 };
const timelineLimit = 300, timelineGroups = 9, timelineOtherColor = "#787e8a";
function splitPath(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  let dir = cut > 0 ? path.slice(0, cut) : path.slice(0, cut + 1);
  if (/^[A-Za-z]:$/.test(dir)) dir += "\\";
  return { dir, name: path.slice(cut + 1) };
}
function fileTimeline(rows, days, now = Date.now() / 1000) {
  const groups = new Map();
  const files = rows.map((r) => {
    const { dir, name } = splitPath(r.path);
    let group = groups.get(dir);
    if (!group) groups.set(dir, group = { path: dir, name: splitPath(dir.replace(/[\\/]+$/, "")).name || dir, kind: "group", alloc: 0, logical: 0, count: 0, children: [] });
    group.alloc += r.alloc; group.logical += r.logical; ++group.count;
    return { path: r.path, name, kind: "file", alloc: r.alloc, logical: r.logical, appeared: r.appeared, modified: r.modified, appearedIsMtime: r.appearedIsMtime, group, children: [] };
  });
  let ranked = Array.from(groups.values()).sort((a, b) => b.alloc - a.alloc || (a.path < b.path ? -1 : 1));
  if (ranked.length > timelineGroups) {
    const merged = ranked.slice(timelineGroups - 1);
    const other = { path: "", name: `其他 ${merged.length} 个目录`, kind: "group", other: true, color: timelineOtherColor, children: [],
      alloc: merged.reduce((s, g) => s + g.alloc, 0), logical: merged.reduce((s, g) => s + g.logical, 0), count: merged.reduce((s, g) => s + g.count, 0) };
    for (const file of files) if (merged.includes(file.group)) file.group = other;
    ranked = ranked.slice(0, timelineGroups - 1).concat(other);
  }
  ranked.forEach((group, i) => { if (!group.other) group.color = graphColor(i / Math.max(ranked.length, 3) + 0.08, 1); });
  const root = { path: "", name: "新出现的文件", kind: "group", children: ranked, count: files.length,
    alloc: files.reduce((s, f) => s + f.alloc, 0), logical: files.reduce((s, f) => s + f.logical, 0) };
  return { root, files, days: Math.max(1, days), now, breadcrumbs: [] };
}
function timelineDate(sec, format) {
  const d = new Date(sec * 1000), p = (n) => String(n).padStart(2, "0");
  const year = d.getFullYear(), month = p(d.getMonth() + 1), day = p(d.getDate());
  return format === "month" ? `${year}-${month}` : format === "day" ? `${month}-${day}` : `${year}-${month}-${day}`;
}
function timelineLayout(data) {
  const { width, left, right, top, axis } = timelineBox;
  const span = data.days * 86400, start = data.now - span, plot = width - left - right;
  const xOf = (t) => left + plot * Math.min(1, Math.max(0, (t - start) / span));
  const step = [1, 2, 7, 14, 30, 60, 90, 180, 365, 730, 1825, 3650, 7300].find((s) => data.days / s <= 6) || 18250;
  const ticks = [];
  for (let d = 0; d <= data.days; d += step) ticks.push({ x: xOf(data.now - d * 86400), label: d === 0 ? "今天" : timelineDate(data.now - d * 86400, data.days > 400 ? "month" : "day") });
  const shown = data.files.slice().sort((a, b) => b.alloc - a.alloc).slice(0, timelineLimit);
  const largest = shown.length ? shown[0].alloc : 1, middle = (top + axis) / 2, gap = 2;
  // 由大到小逐个放置：x 取出现日期，y 取离中线最近且不重叠的位置。放不下时先整体缩小半径，
  // 最后才把圆横向挪到最近的空位，保证任何情况下都不重叠。
  // 只有横向相距小于两圆半径之和的圆才可能相交。
  const column = (points, x, r) => {
    const near = points.filter((p) => Math.abs(p.x - x) < p.r + r + gap), candidates = [middle];
    for (const p of near) {
      const dy = Math.sqrt(Math.max(0, (p.r + r + gap) ** 2 - (p.x - x) ** 2));
      candidates.push(p.y - dy, p.y + dy);
    }
    candidates.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
    return candidates.find((y) => y - r >= top && y + r <= axis - 4 &&
      near.every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 >= (p.r + r + gap - 0.5) ** 2));
  };
  // 圆的总面积不超过绘图区约 35%，避免大小相近的大量文件挤满画面。
  const weight = shown.reduce((sum, node) => sum + Math.max(0, node.alloc) / largest, 0);
  const fill = Math.sqrt(0.35 * (width - 4) * (axis - 4 - top) / (Math.PI * 56 * 56 * Math.max(weight, 1)));
  let points = [];
  for (let scale = Math.min(1, fill), attempt = 0; attempt < 3; ++attempt, scale *= 0.8) {
    let shifted = false;
    points = [];
    for (const node of shown) {
      const r = Math.max(3, 56 * scale * Math.sqrt(Math.max(0, node.alloc) / largest));
      const x0 = Math.min(width - r - 2, Math.max(r + 2, xOf(node.appeared)));
      let x = x0, y = column(points, x, r);
      for (let step = 1; y === undefined && step * (r + gap) < width; ++step) {
        for (const sign of [-1, 1]) {
          x = x0 + sign * step * (r + gap);
          if (x - r < 2 || x + r > width - 2) continue;
          if ((y = column(points, x, r)) !== undefined) break;
        }
      }
      if (y === undefined) { x = x0; y = middle; shifted = true; }
      shifted ||= x !== x0;
      points.push({ node, x, y, r, color: node.group.color });
    }
    if (!shifted) break;
  }
  return { points, ticks };
}
function timelineMarkup(layout) {
  const { width, left, right, top, axis } = timelineBox;
  const ticks = layout.ticks.map((t) => `<line class="timelineGrid" x1="${t.x.toFixed(1)}" x2="${t.x.toFixed(1)}" y1="${top}" y2="${axis}"/><text class="timelineTick" x="${t.x.toFixed(1)}" y="${axis + 24}">${esc(t.label)}</text>`).join("");
  // 尺寸标签与圆放在同一组内，悬停变暗时一起变暗。
  const bubbles = layout.points.map((p, i) => `<g class="bubble" data-node="${i}" tabindex="0" role="button" aria-label="${esc(p.node.name)} ${graphSize(p.node.alloc)}，${timelineDate(p.node.appeared)} 出现"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.r.toFixed(1)}" fill="${p.color}"/>${p.r >= 24 ? `<text x="${p.x.toFixed(1)}" y="${(p.y + 4).toFixed(1)}" font-size="${Math.min(14, p.r / 2.6).toFixed(1)}">${graphSize(p.node.alloc)}</text>` : ""}</g>`).join("");
  return `<g aria-hidden="true">${ticks}<line class="timelineAxis" x1="${left}" x2="${width - right}" y1="${axis}" y2="${axis}"/></g><g id="graphBubbles">${bubbles}</g>`;
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
    this.hoverFrame = 0;
    this.tooltipNode = null;
    this.tooltipBounds = null;
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
    const hoverSector = (e) => {
      const target = e.target.closest("[data-node]");
      this.queueHover(target ? this.segments[+target.dataset.node].node : this.selected,
        target ? { x: e.clientX, y: e.clientY } : null);
    };
    $("sunburst").addEventListener("pointerover", hoverSector);
    $("sunburst").addEventListener("pointermove", hoverSector);
    $("sunburst").addEventListener("pointerleave", () => this.queueHover(this.selected));
    const invalidateBounds = () => { this.tooltipBounds = null; };
    window.addEventListener("resize", invalidateBounds);
    window.addEventListener("scroll", invalidateBounds, true);
    const activate = (e) => {
      const target = e.target.closest("[data-node]");
      if (target) this.activate(this.segments[+target.dataset.node].node);
      else if (e.target.closest(".graphCenter")) this.up();
      else if (this.mode === "files" && this.selected) { this.selected = null; this.highlight(null); }
    };
    $("sunburst").onclick = activate;
    $("sunburst").onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(e); }
      if (e.key === "Backspace") { e.preventDefault(); this.up(); }
    };
    $("graphLegend").onpointerover = (e) => {
      const row = e.target.closest("[data-child]");
      if (row) this.queueHover(this.data.root.children[+row.dataset.child]);
    };
    $("graphLegend").onpointerleave = () => this.queueHover(this.selected);
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
  queueHover(node, point = null) {
    this.pendingHover = { node, point };
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const pending = this.pendingHover;
      this.pendingHover = null;
      // 先读取容器位置，避免在高亮和详情写入后强制重新布局。
      if (pending.point && !this.tooltipBounds) this.tooltipBounds = $("sunburst").parentElement.getBoundingClientRect();
      this.highlight(pending.node);
      this.moveTooltip(pending.node, pending.point);
    });
  }
  cancelHover() {
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = 0; this.pendingHover = null;
    this.tooltipNode = null; this.tooltipBounds = null;
    $("graphTooltip").hidden = true;
  }
  moveTooltip(node, point) {
    const tip = $("graphTooltip");
    if (!node || !point) { tip.hidden = true; this.tooltipNode = null; return; }
    if (this.tooltipNode !== node || !this.tooltipSize) {
      tip.textContent = `${node.name} · ${graphSize(node.alloc)}` +
        (node.kind === "group" ? ` · ${node.count} 个文件` : this.mode === "files" && node.kind === "file" ? ` · ${date(node.appeared)} 出现` : "");
      tip.hidden = false;
      this.tooltipSize = { width: tip.offsetWidth, height: tip.offsetHeight };
      this.tooltipNode = node;
    }
    const bounds = this.tooltipBounds;
    const x = Math.max(8, Math.min(bounds.width - this.tooltipSize.width - 8, point.x - bounds.left + 12));
    const y = Math.max(8, Math.min(bounds.height - this.tooltipSize.height - 30, point.y - bounds.top + 12));
    tip.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }
  // 图形内的扇区、气泡、右侧列表和详情都可以映射回对应节点（拖动与右键菜单共用）。
  nodeFromElement(el) {
    if (!this.data || !el || !el.closest) return null;
    const item = el.closest("#sunburst [data-node]");
    if (item) return this.segments[+item.dataset.node]?.node || null;
    const row = el.closest("#graphLegend [data-child]");
    if (row) return this.data.root.children[+row.dataset.child] || null;
    const file = el.closest("#graphDetail [data-file]");
    if (file) return this.segments.find((s) => s.node.path === file.dataset.file)?.node || null;
    return null;
  }
  bindFileDrag() {
    // 使用指针捕获，兼容 macOS WKWebView 和 Windows WebView2 的拖动行为。
    // 拖动中光标变为抓取，进入待删除区变为“复制”，并有文件名标签跟随指针。
    const ghost = $("dragGhost");
    const setReady = (drag, ready) => {
      if (drag.ready === ready) return;
      drag.ready = ready;
      document.body.classList.toggle("fileDropReady", ready);
      $("collector").classList.toggle("dragover", ready);
      ghost.classList.toggle("ready", ready);
      ghost.lastChild.textContent = ready ? "松开加入待删除" : graphSize(drag.node.alloc);
    };
    const finish = (drag) => {
      if (drag && drag.moved) setReady(drag, false);
      document.body.classList.remove("fileDragging");
      ghost.hidden = true;
    };
    for (const id of ["sunburst", "graphLegend", "graphDetail"]) {
      const surface = $(id);
      let drag = null, suppressClick = false;
      surface.ondragstart = (e) => e.preventDefault();
      surface.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.ctrlKey || scanning || trashing || e.target.closest(".detailActions")) return;
        const node = this.nodeFromElement(e.target);
        if (!node || node.kind !== "file") return;
        drag = { node, x: e.clientX, y: e.clientY, moved: false, ready: false };
        e.preventDefault();
      });
      const inside = (e) => {
        const box = $("collector").getBoundingClientRect();
        return e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
      };
      surface.addEventListener("pointermove", (e) => {
        if (!drag) return;
        if (!e.buttons) { finish(drag); drag = null; return; }
        // 移动超过阈值才捕获指针：过早捕获会把普通点击的目标改成容器，导致无法选中文件。
        if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) {
          drag.moved = true; surface.setPointerCapture(e.pointerId);
          this.cancelHover();
          document.body.classList.add("fileDragging");
          ghost.innerHTML = `<strong>${esc(drag.node.name)}</strong><span>${graphSize(drag.node.alloc)}</span>`;
          ghost.hidden = false;
        }
        if (!drag.moved) return;
        ghost.style.transform = `translate3d(${e.clientX + 14}px, ${e.clientY + 16}px, 0)`;
        setReady(drag, inside(e));
      });
      surface.addEventListener("pointerup", (e) => {
        if (!drag) return;
        const pending = drag; drag = null;
        finish(pending);
        if (!pending.moved) return;
        suppressClick = true;
        if (inside(e)) this.collect(pending.node);
        setTimeout(() => { suppressClick = false; }, 0);
      });
      surface.addEventListener("pointercancel", () => { finish(drag); drag = null; });
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
    this.applyMode();
    this.refresh(this.history[mode].paths.length === 1);
  }
  applyMode() {
    // 两种模式使用不同的图形：目录占用为环形层级图，新出现的文件为时间线气泡图。
    const files = this.mode === "files";
    $("graphView").dataset.mode = this.mode;
    $("graphGuide").textContent = files ? "横轴为出现日期 · 圆面积表示文件大小 · 颜色区分所在目录 · 点击文件查看详情" : "悬停查看详情 · 点击目录深入 · 点击圆心返回上层";
    $("sunburst").setAttribute("viewBox", files ? `0 0 ${timelineBox.width} ${timelineBox.height}` : "0 0 640 640");
    $("sunburst").setAttribute("aria-label", files ? "新出现文件时间线" : "目录占用环形图");
  }
  reset() {
    this.cancelHover(); this.detailState = null;
    ++this.request; this.data = null; this.selected = null; this.hoverElements = null; this.bubbleByNode = null;
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
    const fetch = (p) => api().QueryGraph(p);
    $("graphView").setAttribute("aria-busy", "true");
    try {
      if (mode === "files") {
        const minMB = Math.max(1, num("fileMin", 500)), days = Math.max(1, Math.min(36500, Math.round(num("fileDays", 60))));
        const res = await api().QueryFiles(Math.round(minMB * 1e6), days);
        if (token !== this.request) return;
        this.data = Object.assign(fileTimeline(res.rows, days), { total: res.total, minMB });
        this.selected = null; this.render();
        return;
      }
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
    this.cancelHover();
    const h = this.history[this.mode];
    if (h.paths[h.index] === path) return;
    h.paths = h.paths.slice(0, h.index + 1).concat(path); ++h.index;
    this.refresh();
  }
  showDirectory(path) {
    if (this.mode !== "dirs") this.changeMode("dirs");
    this.navigate(path);
  }
  travel(step) {
    this.cancelHover();
    const h = this.history[this.mode], index = h.index + step;
    if (index < 0 || index >= h.paths.length) return;
    h.index = index; this.refresh();
  }
  up() {
    if (this.data && this.data.breadcrumbs.length > 1) this.navigate(this.data.breadcrumbs[this.data.breadcrumbs.length - 2].path);
  }
  activate(node) {
    if (scanning) return;
    this.cancelHover();
    if (node.kind === "dir") this.navigate(node.path);
    else if (node.kind === "file" || node.kind === "group") { this.selected = node; this.highlight(node); }
    else this.showDetail(node);
  }
  render() {
    const root = this.data.root, files = this.mode === "files";
    this.cancelHover(); this.detailState = null; this.highlighted = null; this.highlightedRow = null;
    this.applyMode();
    $("sunburst").classList.remove("dim");
    $("graphEmpty").hidden = root.alloc > 0;
    if (root.alloc <= 0) this.empty(files ? "没有符合条件的新文件" : "这个目录暂无占用数据", files ? "可以调低大小阈值或放宽天数" : "可以重新扫描");
    if (files) this.renderTimeline(); else this.renderSunburst();
    $("graphTitle").textContent = root.name;
    $("graphTotal").textContent = graphSize(root.alloc);
    $("graphLegend").innerHTML = root.children.map((n, i) => {
      const sector = files ? n : this.sectorByNode.get(n);
      const muted = n.kind === "other" || n.other;
      return `<div class="legendRow ${muted ? 'other' : ''}" data-child="${i}" tabindex="0" role="button" aria-label="${esc(n.name)} ${graphSize(n.alloc)}" ${n.kind === "file" ? `draggable="true" data-file="${esc(n.path)}"` : ''} title="${esc(n.path || (files ? '文件较少的位置合并显示' : '小文件、目录元数据与合并显示的项目'))}"><i style="background:${sector && sector.color || graphOtherColor}"></i><span>${esc(n.name)}${n.kind === "dir" ? ' <b>›</b>' : n.kind === "group" ? ` <b>${n.count} 个文件</b>` : ''}</span><strong>${graphSize(n.alloc)}</strong></div>`;
    }).join("");
    this.legendByNode = new Map(Array.from($("graphLegend").children, (row, i) => [root.children[i], row]));
    this.showDetail(null); this.syncControls();
  }
  renderSunburst() {
    const root = this.data.root;
    this.bubbleByNode = null;
    this.segments = graphSegments(root);
    this.sectorByNode = new Map(this.segments.map((s, i) => [s.node, { ...s, index: i }]));
    const label = graphSize(root.alloc).split(" ");
    $("sunburst").innerHTML = graphMarkup(this.segments) +
      `<g class="graphCenter" tabindex="0" role="button" aria-label="返回上层目录"><circle cx="320" cy="320" r="76"/><text x="320" y="310" class="centerValue">${label[0]}</text><text x="320" y="343" class="centerUnit">${label[1]}</text><text x="320" y="369" class="centerBack">${this.data.breadcrumbs.length > 1 ? '↑ 返回上层' : '扫描目录'}</text></g>`;
    this.hoverElements = { base: $("graphSectors"), layer: $("graphHover"), branch: $("graphHoverBranch"), outline: $("graphHoverOutline") };
    $("graphPath").textContent = root.path || "全部扫描目录";
    $("graphBreadcrumbs").innerHTML = this.data.breadcrumbs.map((n) => `<button data-path="${esc(n.path)}" title="${esc(n.path || n.name)}">${esc(n.name)}</button>`).join('<span aria-hidden="true">›</span>');
  }
  renderTimeline() {
    const data = this.data, layout = timelineLayout(data);
    this.hoverElements = null; this.sectorByNode = new Map();
    this.segments = layout.points;
    const svg = $("sunburst");
    svg.innerHTML = data.files.length ? timelineMarkup(layout) : "";
    this.bubbleByNode = new Map(); this.groupBubbles = new Map(); this.activeBubbles = [];
    for (const el of svg.querySelectorAll(".bubble[data-node]")) {
      const node = this.segments[+el.dataset.node].node;
      this.bubbleByNode.set(node, el);
      if (!this.groupBubbles.has(node.group)) this.groupBubbles.set(node.group, []);
      this.groupBubbles.get(node.group).push(el);
    }
    const total = Math.max(data.total || 0, data.files.length), shown = layout.points.length;
    $("graphPath").textContent = `最近 ${data.days} 天 · 单个至少 ${data.minMB} MB · ${total.toLocaleString()} 个文件` +
      (shown < total ? `，图中显示其中最大的 ${shown} 个` : "");
    $("graphBreadcrumbs").innerHTML = "";
  }
  highlight(node) {
    if (!this.data || !(this.hoverElements || this.bubbleByNode)) return;
    if (this.highlighted !== node) {
      const row = this.bubbleByNode ? this.highlightBubbles(node) : this.highlightSectors(node);
      if (this.highlightedRow) this.highlightedRow.classList.remove("highlight");
      this.highlightedRow = row || null;
      if (this.highlightedRow) this.highlightedRow.classList.add("highlight");
      this.highlighted = node;
    }
    this.showDetail(node || this.selected);
  }
  highlightSectors(node) {
    const active = node && node.kind !== "other" ? this.sectorByNode.get(node) : null;
    const { base, layer, branch, outline } = this.hoverElements;
    if (active) {
      base.setAttribute("opacity", ".22");
      branch.setAttribute("href", `#graphBranch${active.index}`);
      outline.setAttribute("d", active.d);
      layer.removeAttribute("display");
    } else {
      base.removeAttribute("opacity"); layer.setAttribute("display", "none");
    }
    return active ? this.legendByNode.get(node) : null;
  }
  highlightBubbles(node) {
    for (const el of this.activeBubbles) el.classList.remove("on");
    const group = node && (node.kind === "group" ? node : node.group);
    this.activeBubbles = !node ? [] : node.kind === "group" ? this.groupBubbles.get(node) || [] : [this.bubbleByNode.get(node)].filter(Boolean);
    for (const el of this.activeBubbles) el.classList.add("on");
    $("sunburst").classList.toggle("dim", this.activeBubbles.length > 0);
    return group ? this.legendByNode.get(group) : null;
  }
  showDetail(node) {
    const pinned = this.selected === node;
    const previous = this.detailState;
    if (previous && previous.node === node && previous.pinned === pinned && previous.root === this.data?.root && previous.mode === this.mode) return;
    this.detailState = { node, pinned, root: this.data?.root, mode: this.mode };
    if (!node) {
      $("graphDetail").innerHTML = this.mode === "files"
        ? '<p>横轴是文件出现日期，越靠右越新；圆面积表示文件大小，颜色区分所在目录。</p><p>点击文件查看日期、定位或加入待删除，也可直接拖到下方待删除区；点击右侧目录可高亮其中的文件。</p>'
        : '<p>扇区宽度表示占用大小，从内到外表示目录层级。</p><p>颜色沿色环按位置渐变，同一分支色调相近；深灰为合并的小项目。点击文件查看日期、定位或加入待删除。</p>';
      return;
    }
    const percent = this.data.root.alloc ? (node.alloc / this.data.root.alloc * 100).toFixed(1) : "0.0";
    const files = node.kind === "file";
    if (node.kind === "group") {
      $("graphDetail").innerHTML = `<div><h3>${esc(node.name)}</h3><p class="detailPath">${esc(node.path || '多个目录')}</p><div class="detailSize">${graphSize(node.alloc)} <span>${percent}%</span></div><p>${node.count} 个新出现的文件</p></div>${pinned && node.path ? `<div class="detailActions"><button data-reveal="${esc(node.path)}">定位目录</button></div>` : `<p>${node.path ? '点击可固定高亮并定位该目录。' : '文件较少的目录合并于此。'}</p>`}`;
      return;
    }
    $("graphDetail").innerHTML = `<div ${files ? `draggable="true" data-file="${esc(node.path)}"` : ''}><h3>${esc(node.name)}</h3><p class="detailPath">${esc(node.path)}</p><div class="detailSize">${graphSize(node.alloc)} <span>${percent}%</span></div>${differs(node.alloc, node.logical) && node.kind !== 'other' ? `<p>逻辑大小 ${graphSize(node.logical)}</p>` : ''}${files ? `<p>出现日期 ${date(node.appeared)}${node.appearedIsMtime ? '（修改时间）' : ''}<br>修改日期 ${date(node.modified)}</p>` : ''}</div>${this.selected === node && files ? `<div class="detailActions"><button data-reveal="${esc(node.path)}">定位</button><button data-collect="true" ${scanning || trashing ? 'disabled' : ''}>加入待删除</button><button class="trash" data-path="${esc(node.path)}">删除</button></div>` : `<p>${files ? '点击文件可定位、加入待删除，或拖到下方待删除区。' : node.kind === 'dir' ? '点击进入此目录，查看下一层。' : '小文件、目录元数据及超过显示数量的项目合并于此。'}</p>`}`;
    for (const button of $("graphDetail").querySelectorAll("button.trash")) button.disabled = scanning || trashing;
  }
  collect(node) { this.collectMany([node]); }
  collectMany(nodes) {
    if (scanning || trashing) return;
    const files = nodes.filter((n) => n && n.kind === "file");
    if (!files.length) return;
    for (const node of files) this.collected.set(node.path, node);
    this.renderCollector();
    const what = files.length > 1 ? `已将 ${files.length} 个文件加入待删除` : "已加入待删除";
    toast(document.body.dataset.view === "list" ? `${what}，可在图形视图底部移入回收站` : `${what}，文件尚未移动`);
  }
  groupFiles(group) { return this.data && this.data.files ? this.data.files.filter((f) => f.group === group) : []; }
  removeCollected(path) { this.collected.delete(path); this.renderCollector(); }
  renderCollector() {
    const nodes = Array.from(this.collected.values()), total = nodes.reduce((sum, n) => sum + n.alloc, 0);
    $("collectorCount").textContent = nodes.length ? `${nodes.length} 个待删除文件 · ${graphSize(total)}` : "待删除文件";
    $("collectorHint").textContent = nodes.length ? "点击移入回收站后才会移动文件，可在系统回收站恢复" : "将文件拖到这里，或在详情中加入待删除";
    $("collectorItems").innerHTML = nodes.map((n) => `<span title="${esc(n.path)}" data-path="${esc(n.path)}">${esc(n.name)}<button data-remove="${esc(n.path)}" aria-label="移除待选 ${esc(n.name)}" ${trashing ? 'disabled' : ''}>×</button></span>`).join("");
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

if (typeof module !== "undefined" && module.exports) module.exports = { graphSize, sectorPath, graphSegments, graphMarkup, graphColor, graphOtherColor, fileTimeline, timelineLayout, timelineMarkup, timelineBox, DiskGraph };
