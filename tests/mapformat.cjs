const assert = require('node:assert/strict');
require('../js/mapformat.js');
const P = globalThis.Pulsar;
// Exceeds JavaScript's argument-count limit, as the XNOR slider paths do.
const points = Array.from({ length: 150000 }, (_, i) => [i, 0]);
const path = P.makeSegmentedPath([{ kind: 'L', points }], 149999);
assert.equal(path.length, 149999);
assert.deepEqual(P.pointOnPath(path, 74999.5), [74999.5, 0]);
assert.deepEqual(P.pointOnPath(path, path.length), [149999, 0]);
const short = P.makeSegmentedPath([{ kind: 'L', points }], 2.5);
assert.equal(short.length, 2.5);
assert.deepEqual(short.pts.at(-1), [2.5, 0]);
console.log('Large-slider import checks passed.');
