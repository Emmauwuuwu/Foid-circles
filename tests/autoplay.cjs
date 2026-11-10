const assert = require('node:assert/strict');
require('../js/game.js');
const P = globalThis.Pulsar;
globalThis.window = { innerWidth: 1024, innerHeight: 768 };
P.sliderPos = o => [o.x, o.y];
const tap = t => ({ type: 'tap', t, x: 20, y: 20, color: 0 });
const slider = (t, endT, x) => ({ ...tap(t), type: 'slider', endT, x });
const spin = (t, endT) => ({ ...tap(t), type: 'spin', endT });
function session(objects, auto = true) {
  const game = new P.StandardGame({ getContext: () => ({}) }, {
    map: { ar: 10, cs: 5, od: 10, hp: 5, objects }, mods: { auto },
    audioCtx: { currentTime: 0 },
  });
  game.time = () => 0;
  return game;
}
function perfect(game, count) {
  assert.equal(game.counts.perfect, count);
  assert.equal(game.counts.miss + game.counts.ok + game.counts.great, 0);
  assert.ok(game.objects.every(o => o.done));
}

// Opposite-side sliders, simultaneous spinners and dense taps share a time range.
const objects = [slider(100, 1100, 0), slider(100, 1100, 512), spin(100, 1100), spin(100, 1100),
  ...Array.from({ length: 1000 }, (_, i) => tap(100 + i / 2))].sort((a, b) => a.t - b.t);
for (const times of [[0, 1200], Array.from({ length: 121 }, (_, i) => i * 10)]) {
  const game = session(objects);
  let previous = 0;
  for (const t of times) { game.simulate(t, Math.min(250, t - previous)); previous = t; }
  perfect(game, objects.length);
  const score = game.score;
  game.simulate(1300, 100);
  assert.equal(game.score, score, 'completed objects must not score twice');
}
for (const object of [slider(100, 101, 0), spin(100, 101), slider(100, 100, 0), spin(100, 100)]) {
  const game = session([object]);
  game.simulate(200, 0);
  perfect(game, 1);
}
const early = session([tap(100), slider(100, 200, 0), spin(100, 200)]);
early.simulate(99, 10);
assert.equal(early.score, 0, 'future objects must not score early');
const manual = session([tap(100), slider(100, 200, 0), spin(100, 200)], false);
manual.simulate(1000, 250);
assert.equal(manual.counts.miss, 3, 'manual play still requires input');
const cursor = session([slider(0, 1000, 0), ...Array.from({ length: 20 }, () => tap(10)), slider(100, 1000, 512)]);
cursor.simulate(100, 100);
assert.equal(cursor.cursor.x, 512, 'cursor reaches heads beyond eight objects');
console.log('Autoplay regression checks passed.');
