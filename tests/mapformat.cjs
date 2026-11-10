const assert = require('node:assert/strict');
require('../js/mapformat.js');
require('../js/mapwrite.js');
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

async function checkArchives() {
  const zip = P.writeZip([{ name: 'skin.ini', data: 'Name: Test' }]);
  const commented = new Uint8Array(zip.length + 24);
  commented.set(zip);
  const view = new DataView(commented.buffer);
  view.setUint16(zip.length - 2, 24, true);
  view.setUint32(zip.length, 0x06054b50, true);
  const files = await P.readZip(commented.buffer);
  assert.equal(new TextDecoder().decode(await files.get('skin.ini').get()), 'Name: Test');

  const broken = zip.slice();
  new DataView(broken.buffer).setUint32(broken.length - 6, 0xffffffff, true);
  await assert.rejects(P.readZip(broken.buffer), /Corrupt beatmap or skin archive/);
  console.log('Archive boundary checks passed.');
}

checkArchives().catch(error => { console.error(error); process.exitCode = 1; });
