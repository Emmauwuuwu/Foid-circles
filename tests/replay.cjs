const assert = require('node:assert/strict');
require('../js/game.js');
const P = globalThis.Pulsar;
P.sliderPos = o => [o.x, o.y];
globalThis.window = { innerWidth: 1024, innerHeight: 768 };

const map = {
  ar: 10, cs: 5, od: 10, hp: 5,
  objects: [
    { type: 'tap', t: 100, x: 200, y: 180, color: 0 },
    { type: 'slider', t: 200, endT: 300, x: 300, y: 210, color: 0 },
  ],
};
function createSession(options) {
  let t = 0;
  const game = new P.StandardGame({ getContext: () => ({}) }, {
    map, audioCtx: { suspend() {}, resume() {} }, ...options,
  });
  game.clockTime = () => t;
  game.frame = () => {};
  return { game, at: ms => { t = ms; } };
}
const original = createSession({ recordReplay: true });
const { game } = original;
game.step();
original.at(100);
game.input('move', 0, 0);
game.input('move', game.ox + 200 * game.s, game.oy + 180 * game.s);
game.input('press', 'KeyZ');
game.step();
game.pause();
game.input('clear');
game.resume();
original.at(200);
game.input('pointer', {
  clientX: game.ox + 300 * game.s, clientY: game.oy + 210 * game.s,
  button: 0, pointerType: 'mouse',
}, 'p1:0');
game.step();
original.at(250);
game.step();
original.at(310);
game.step();
game.input('release', 'p1:0');
assert.equal(game.counts.perfect, 2);
assert.equal(game.recording.filter(entry => entry?.[1] === 'move').length, 1);

window.innerWidth = 800;
window.innerHeight = 600;
const playback = createSession({ replay: { events: game.recording, failed: false } });
playback.at(100);
playback.game.step();
assert.equal(playback.game.counts.perfect, 1);
playback.game.input('press', 'KeyX');
playback.game.pause();
playback.game.resume();
playback.game.finish = failed => { playback.game.ended = true; assert.equal(failed, false); };
playback.at(350);
playback.game.step();
assert.equal(playback.game.ended, true);
assert.deepEqual(playback.game.counts, game.counts);
assert.equal(playback.game.score, game.score);
assert.equal(playback.game.maxCombo, game.maxCombo);
console.log('Replay regression checks passed.');
