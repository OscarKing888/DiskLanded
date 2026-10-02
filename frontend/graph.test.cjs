const test = require('node:test');
const assert = require('node:assert/strict');
const { graphSize, sectorPath, graphSegments } = require('./dist/graph.js');

test('full-circle and tiny sectors have finite SVG geometry', () => {
  for (const [start, end] of [[0, Math.PI * 2], [0, 0.0001], [-Math.PI / 2, Math.PI]]) {
    const d = sectorPath(85, 136, start, end);
    assert(d.startsWith('M'));
    assert(!/NaN|Infinity/.test(d));
    assert(d.endsWith('Z'));
  }
  assert.equal(sectorPath(85, 136, 1, 1), '');
});

test('nested directory sectors preserve weights and branch membership', () => {
  const file = {path: '/root/sub/file', kind: 'file', alloc: 20, children: []};
  const sub = {path: '/root/sub', kind: 'dir', alloc: 60, children: [file, {kind: 'other', alloc: 40, children: []}]};
  const root = {alloc: 100, children: [sub, {path: '/root/other', kind: 'dir', alloc: 40, children: []}]};
  const segments = graphSegments(root);
  assert.equal(segments.length, 4);
  assert.deepEqual(segments.find(s => s.node === file).lineage, ['/root/sub', '/root/sub/file']);
  assert.equal(segments[0].node, sub);
  assert(!segments.some(s => /NaN|Infinity/.test(s.d)));
  assert.deepEqual(graphSegments({alloc: 0, children: []}), []);
});

test('small and empty allocations are not reported as one MB', () => {
  assert.equal(graphSize(0), '0 B');
  assert.equal(graphSize(2048), '2.0 KB');
  assert.equal(graphSize(1500000000), '1.5 GB');
});

// 在独立 JS 上下文内提供最小 DOM，验证每帧工作量，不依赖机器计时。
function hoverHarness() {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const counters = { writes: 0, layouts: 0, detail: 0, text: 0 };
  const elements = new Map(), frames = new Map();
  let serial = 0;
  function element() {
    const attrs = new Map();
    return {
      attrs, hidden: true, style: {},
      setAttribute(k,v) { counters.writes++; attrs.set(k,v); },
      removeAttribute(k) { counters.writes++; attrs.delete(k); },
      classList: { add() { counters.writes++; }, remove() { counters.writes++; } },
      querySelectorAll() { return []; },
      set innerHTML(v) { counters.detail++; this.html = v; },
      set textContent(v) { counters.text++; this.text = v; },
      get offsetWidth() { counters.layouts++; return 100; },
      get offsetHeight() { counters.layouts++; return 30; },
      getBoundingClientRect() { counters.layouts++; return {left: 10, top: 20, width: 640, height: 640}; }
    };
  }
  const $ = id => { if (!elements.has(id)) elements.set(id,element()); return elements.get(id); };
  $('sunburst').parentElement = element();
  const context = vm.createContext({
    module: {exports:{}}, $, scanning: false, trashing: false,
    esc: s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    differs: () => false, date: () => '2026-10-02',
    requestAnimationFrame: fn => { frames.set(++serial,fn); return serial; },
    cancelAnimationFrame: id => frames.delete(id)
  });
  vm.runInContext(fs.readFileSync(require.resolve('./dist/graph.js'),'utf8'),context);
  const {DiskGraph,graphMarkup} = context.module.exports;
  const graph = Object.create(DiskGraph.prototype);
  Object.assign(graph, {mode:'dirs',selected:null,data:{root:{alloc:2000}},hoverFrame:0,
    hoverElements:{base:$('graphSectors'),layer:$('graphHover'),branch:$('graphHoverBranch'),outline:$('graphHoverOutline')},
    sectorByNode:new Map(),legendByNode:new Map(),highlighted:null});
  const nodes = Array.from({length:2000},(_,i)=>({path:'/root/'+i,name:'file '+i,kind:'file',alloc:1,logical:1}));
  nodes.forEach((node,index)=>graph.sectorByNode.set(node,{index,d:'sector-'+index}));
  return {graph,nodes,counters,$,frames,graphMarkup,exports:context.module.exports,flush() { const jobs=[...frames.values()]; frames.clear(); jobs.forEach(fn=>fn()); }};
}

test('bursts of hover events apply only the latest target once per frame', () => {
  const h=hoverHarness();
  for (let i=0;i<2000;i++) h.graph.queueHover(h.nodes[i],{x:100,y:120});
  assert.equal(h.frames.size,1);
  assert.equal(h.counters.writes,0);
  h.flush();
  assert.equal(h.$('graphHoverBranch').attrs.get('href'),'#graphBranch1999');
  assert.equal(h.counters.detail,1);
  assert(h.counters.writes<=6,'hover work grew with total sector count');
  const before={...h.counters};
  for (let i=0;i<120;i++) { h.graph.queueHover(h.nodes[1999],{x:100+i,y:120}); h.flush(); }
  assert.deepEqual(h.counters,before,'moving within one sector repeated layout or rebuilt details');
  assert.match(h.$('graphTooltip').style.transform,/translate3d/);
});

test('leaving and repainting cannot apply a queued stale hover', () => {
  const h=hoverHarness();
  h.graph.queueHover(h.nodes[0],{x:100,y:120});
  h.graph.queueHover(null);
  h.flush();
  assert.equal(h.graph.highlighted,null);
  assert.equal(h.$('graphTooltip').hidden,true);
  h.graph.queueHover(h.nodes[1],{x:100,y:120});
  h.graph.cancelHover(); h.flush();
  assert.equal(h.frames.size,0);
  assert.equal(h.graph.highlighted,null);
});

test('selection updates actions even when hovering the same file', () => {
  const h=hoverHarness(), node=h.nodes[0];
  h.graph.highlight(node);
  assert(!h.$('graphDetail').html.includes('data-collect'));
  h.graph.selected=node; h.graph.highlight(node);
  assert(h.$('graphDetail').html.includes('data-collect'));
  const count=h.counters.detail;
  h.graph.highlight(node);
  assert.equal(h.counters.detail,count);
  h.graph.highlight(null);
  assert.equal(h.$('graphHover').attrs.get('display'),'none');
  assert(h.$('graphDetail').html.includes('data-collect'),'pinned file actions disappeared');
});

test('highlight references a nested branch without native duplicate tooltips', () => {
  const h=hoverHarness();
  const nodes=[{path:'/a',name:'a',kind:'dir',alloc:2},{path:'/a/f',name:'<file>',kind:'file',alloc:1},{path:'/b',name:'b',kind:'dir',alloc:1}];
  const html=h.graphMarkup(nodes.map((node,i)=>({node,d:'M0,0Z',color:'#fff',lineage:i===1?['/a','/a/f']:[node.path]})));
  const parents=new Map(),stack=[];
  for (const token of html.matchAll(/<g\b[^>]*>|<\/g>/g)) {
    if(token[0]==='</g>') stack.pop();
    else { const id=token[0].match(/id="([^"]+)"/)[1]; parents.set(id,stack.at(-1)); stack.push(id); }
  }
  assert.equal(parents.get('graphBranch1'),'graphBranch0');
  assert.equal(parents.get('graphBranch2'),'graphSectors');
  assert.equal(stack.length,0);
  assert(!html.includes('<title>'));
  assert(html.includes('&lt;file&gt;'));
  assert(html.includes('aria-hidden="true"'));
  assert(html.includes('data-kind="file"'),'file sectors should be marked draggable');
});

test('colour wheel is continuous, bright and lightens with depth', () => {
  const {graphColor}=require('./dist/graph.js');
  assert.equal(graphColor(0),graphColor(1),'wheel should wrap without a seam');
  assert.equal(new Set(Array.from({length:36},(_,i)=>graphColor(i/36))).size,36);
  const light=c=>[1,3,5].map(o=>parseInt(c.slice(o,o+2),16)).reduce((a,b)=>a+b,0);
  assert(light(graphColor(.3,3))>light(graphColor(.3,0)),'outer rings should be lighter');
  const [r,g,b]=[1,3,5].map(o=>parseInt(graphColor(.3).slice(o,o+2),16));
  assert(Math.max(r,g,b)-Math.min(r,g,b)>120,'sectors should be vivid, not muted');
});

test('sector colours follow angular position and grey out grouped items', () => {
  const {graphColor,graphOtherColor}=require('./dist/graph.js');
  const leaf={path:'/a/file',kind:'file',alloc:10,children:[]};
  const a={path:'/a',kind:'dir',alloc:50,children:[leaf,{kind:'other',alloc:40,children:[]}]};
  const b={path:'/b',kind:'dir',alloc:50,children:[]};
  const colors=new Map(graphSegments({alloc:100,children:[a,b]}).map(s=>[s.node,s.color]));
  assert.equal(colors.get(a),graphColor(.25,0));
  assert.equal(colors.get(b),graphColor(.75,0));
  assert.equal(colors.get(leaf),graphColor(.05,1),'children take the hue of their own midpoint');
  assert.equal(colors.get(a.children[1]),graphOtherColor);
  const only={path:'/only',kind:'dir',alloc:5,children:[]};
  assert.equal(graphSegments({alloc:5,children:[only]})[0].color,graphColor(.5,0));
});

const day=86400, now=1790000000;
function newFile(path,gb,daysAgo){ const alloc=gb*1e9; return {path,alloc,logical:alloc,appeared:now-daysAgo*day,modified:now-daysAgo*day,appearedIsMtime:false}; }

test('new files are grouped by folder, with a merged group beyond the colour limit', () => {
  const {fileTimeline}=require('./dist/graph.js');
  const rows=[newFile('/u/Downloads/a.dmg',4,1),newFile('/u/Downloads/b.iso',2,3),newFile('C:\\Users\\me\\Videos\\c.mp4',3,2),newFile('/top.bin',1,5)];
  for (let i=0;i<10;i++) rows.push(newFile(`/u/many/${i}/f.bin`,0.5,i));
  const data=fileTimeline(rows,60,now);
  const byPath=new Map(data.root.children.map(g=>[g.path,g]));
  assert.equal(byPath.get('/u/Downloads').count,2);
  assert.equal(byPath.get('/u/Downloads').name,'Downloads');
  assert.equal(byPath.get('C:\\Users\\me\\Videos').name,'Videos');
  assert.equal(data.root.children.length,9);
  const other=data.root.children.at(-1);
  assert(other.other && other.path==='');
  assert.equal(data.root.alloc,data.root.children.reduce((s,g)=>s+g.alloc,0));
  assert.equal(data.files.filter(f=>f.group===other).length,other.count);
  assert.equal(new Set(data.root.children.map(g=>g.color)).size,9);
  assert.equal(data.files[0].group,byPath.get('/u/Downloads'));
  const root=fileTimeline([newFile('/top.bin',1,1),newFile('C:\\x.bin',1,1)],60,now).root.children.map(g=>g.path).sort();
  assert.deepEqual(root,['/','C:\\']);
});

test('timeline places newer files to the right without overlapping bubbles', () => {
  const {fileTimeline,timelineLayout,timelineBox}=require('./dist/graph.js');
  const rows=[];
  for (let i=0;i<120;i++) rows.push(newFile(`/u/d${i%7}/f${i}.bin`,0.5+(i*37%23),i%4===0?2:(i*13)%58));
  const data=fileTimeline(rows,60,now), {points,ticks}=timelineLayout(data);
  assert.equal(points.length,120);
  assert.equal(ticks[0].label,'今天');
  assert(ticks[0].x>ticks.at(-1).x);
  for (const p of points) {
    assert(p.y-p.r>=timelineBox.top-0.01 && p.y+p.r<=timelineBox.axis+0.01,'bubble left the plot');
    assert(!/NaN|Infinity/.test(`${p.x}${p.y}${p.r}`));
  }
  for (let i=0;i<points.length;i++) for (let j=i+1;j<points.length;j++) {
    const a=points[i],b=points[j];
    assert(Math.hypot(a.x-b.x,a.y-b.y)>=a.r+b.r,'bubbles overlap');
  }
  const newest=points.find(p=>p.node.appeared===now-2*day), oldest=points.reduce((m,p)=>p.node.appeared<m.node.appeared?p:m);
  assert(newest.x>oldest.x);
  const big=points.reduce((m,p)=>p.node.alloc>m.node.alloc?p:m), small=points.reduce((m,p)=>p.node.alloc<m.node.alloc?p:m);
  assert(big.r>small.r);
  assert.deepEqual(timelineLayout(fileTimeline([],60,now)).points,[]);
});

test('timeline markup keeps labels inside each bubble and escapes names', () => {
  const h=hoverHarness();
  const {fileTimeline,timelineLayout,timelineMarkup}=h.exports;
  const data=fileTimeline([newFile('/u/a/<big>.bin',30,1),newFile('/u/a/small.bin',0.6,2)],60,now);
  const html=timelineMarkup(timelineLayout(data));
  assert.equal((html.match(/class="bubble"/g)||[]).length,2);
  assert(/<g class="bubble"[^>]*><circle[^>]*\/><text[^>]*>30\.0 GB<\/text><\/g>/.test(html),'size label should live inside its bubble group');
  assert(html.includes('&lt;big&gt;.bin'));
  assert(!html.includes('<big>'));
});

test('file bubbles highlight alone or by folder group', () => {
  const h=hoverHarness();
  const {fileTimeline}=h.exports;
  const data=fileTimeline([newFile('/u/a/1.bin',3,1),newFile('/u/a/2.bin',2,2),newFile('/u/b/3.bin',1,3)],60,now);
  const el=()=>{ const c=new Set(); return {classes:c,classList:{add:k=>c.add(k),remove:k=>c.delete(k),toggle:(k,on)=>on?c.add(k):c.delete(k)}}; };
  const bubbles=new Map(data.files.map(f=>[f,el()])), groups=new Map();
  for (const f of data.files) { if(!groups.has(f.group)) groups.set(f.group,[]); groups.get(f.group).push(bubbles.get(f)); }
  const svg=el(); h.$('sunburst').classList=svg.classList;
  Object.assign(h.graph,{mode:'files',data,hoverElements:null,bubbleByNode:bubbles,groupBubbles:groups,activeBubbles:[],
    legendByNode:new Map(data.root.children.map(g=>[g,el()]))});
  h.graph.highlight(data.root.children[0]);
  assert.deepEqual(data.files.map(f=>bubbles.get(f).classes.has('on')),[true,true,false]);
  assert(svg.classes.has('dim'));
  assert(h.graph.legendByNode.get(data.root.children[0]).classes.has('highlight'));
  h.graph.highlight(data.files[2]);
  assert.deepEqual(data.files.map(f=>bubbles.get(f).classes.has('on')),[false,false,true]);
  assert(h.graph.legendByNode.get(data.root.children[1]).classes.has('highlight'));
  h.graph.highlight(null);
  assert(!svg.classes.has('dim'));
  assert(h.$('graphDetail').html.includes('横轴'));
});
