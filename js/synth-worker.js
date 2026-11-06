// Renders a built-in song away from the page's main thread.
importScripts('music.js');
onmessage = e => {
  const P = globalThis.Pulsar;
  const track = P.TRACKS.find(t => t.id === e.data);
  const { L, R, rate } = P.synthesize(P.buildScore(track), 44100);
  postMessage({ L, R, rate }, [L.buffer, R.buffer]);
};
