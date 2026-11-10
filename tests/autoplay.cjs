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

const spam = session([tap(1000), tap(2000)], false);
let time = 0;
spam.time = () => time;
spam.press('Z'); spam.release('Z');
assert.equal(spam.health, 1, 'presses in a rest do not cost health');
time = 1000;
spam.cursor = { x: 20, y: 20 };
spam.press('Z'); spam.release('Z');
assert.equal(spam.combo, 1);
spam.press('X'); spam.release('X');
assert.equal(spam.combo, 0, 'mashing after a hit breaks combo');
assert.ok(spam.health < 1);
time = 2000;
spam.cursor = { x: 300, y: 300 };
const previousHealth = spam.health;
spam.press('Z'); spam.release('Z');
assert.ok(spam.health < previousHealth, 'a stray press inside a hit window costs health');
assert.equal(spam.counts.perfect, 1, 'extra presses do not earn credit');
assert.equal(spam.counts.miss, 2, 'stray presses count against accuracy');

const dense = session([tap(1000), tap(1400), tap(3000)], false);
dense.time = () => time;
dense.cursor = { x: 20, y: 20 };
time = 1000;
dense.press('Z'); dense.release('Z');
dense.first = 1;
time = 1200;
dense.press('X'); dense.release('X');
assert.equal(dense.counts.miss, 1, 'spamming in a short gap counts as a miss');
time = 2200;
dense.press('X'); dense.release('X');
assert.equal(dense.counts.miss, 1, 'spamming in a rest is ignored');

const hold = session([slider(1000, 1600, 20)], false);
hold.time = () => time;
hold.cursor = { x: 20, y: 20 };
time = 1000;
hold.press('Z');
time = 1300;
hold.press('X'); hold.release('X');
assert.equal(hold.counts.miss, 1, 'mashing a second key during a hold counts as a miss');
hold.release('Z');
hold.press('X');
assert.equal(hold.counts.miss, 1, 'regrabbing the slider ball is allowed');

const overload = session([slider(100, 10000, 0), ...Array.from({ length: 10000 }, () => tap(100))]);
overload.autoLowDetail = true;
overload.simulate(200, 100);
assert.equal(overload.counts.perfect, 10000, 'all stacked taps score even when effects are limited');
assert.ok(overload.fx.length <= 16, 'autoplay effects stay bounded during overload');
assert.ok(overload.errors.length <= 24, 'perfect autoplay timing history stays bounded');
assert.equal(overload.autoActive.length, 1, 'only the unfinished slider remains active');
overload.simulate(10001, 250);
perfect(overload, 10001);
assert.equal(overload.autoActive.length, 0, 'completed sliders leave the active list');

const shortSlider = session([slider(100, 120, 20)], false);
shortSlider.time = () => 100;
shortSlider.cursor = { x: 20, y: 20 };
shortSlider.press('Z');
shortSlider.simulate(105, 10);
shortSlider.simulate(123, 18);
assert.equal(shortSlider.objects[0].tracked, 20, 'slider tracking is clipped to both endpoints');
perfect(shortSlider, 1);

const spins = session([spin(100, 1000), spin(450, 1000)], false);
spins.held.add('Z');
for (let i = 0; i <= 12; i++) {
  const angle = i * Math.PI / 6;
  spins.cursor = { x: 256 + 70 * Math.cos(angle), y: 192 + 70 * Math.sin(angle) };
  spins.simulate(100 + i * 20, 20);
}
assert.ok(Math.abs(spins.objects[0].rot - 1) < 1e-6, 'an upcoming spinner does not reset the active spinner');
