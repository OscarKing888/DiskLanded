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
