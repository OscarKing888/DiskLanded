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
  return {graph,nodes,counters,$,frames,graphMarkup,flush() { const jobs=[...frames.values()]; frames.clear(); jobs.forEach(fn=>fn()); }};
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
});

test('rainbow spans soft red to violet without cycling for many siblings', () => {
  const {graphColor}=require('./dist/graph.js');
  assert.equal(graphColor(0),'#d77a78');
  assert.equal(graphColor(1),'#ad8ac6');
  assert.equal(new Set(Array.from({length:36},(_,i)=>graphColor(i/35))).size,36);
});

test('colors follow size rank, retain branch hue, and exclude grouped/empty items', () => {
  const leaf={path:'/large/file',kind:'file',alloc:10,children:[]};
  const large={path:'/large',kind:'dir',alloc:20,children:[leaf]};
  const small={path:'/small',kind:'file',alloc:5,children:[]};
  const other={kind:'other',alloc:100,children:[]};
  const root={alloc:125,children:[small,other,{kind:'dir',alloc:0,children:[]},large]};
  const colors=new Map(graphSegments(root).map(s=>[s.node,s.color]));
  assert.equal(colors.get(large),'#d77a78');
  assert.equal(colors.get(small),'#ad8ac6');
  assert.equal(colors.get(other),'#626873');
  assert.equal(colors.get(leaf),'#d98684');
});

test('a long tail of tiny directories does not make the largest branches all red', () => {
  const children=Array.from({length:36},(_,i)=>({path:'/'+i,kind:'dir',alloc:i<3?[360,250,65][i]:1,children:[]}));
  const segments=graphSegments({alloc:children.reduce((s,n)=>s+n.alloc,0),children});
  assert.equal(segments[0].color,'#d77a78');
  assert.equal(segments.at(-1).color,'#ad8ac6');
  const [red,green,blue]=[1,3,5].map(offset=>parseInt(segments[1].color.slice(offset,offset+2),16));
  assert(green-blue>25 && red>green,'second large branch should be a distinct warm orange/yellow');
});
