let n = 0;
self.onmessage = (e) => {
  // compute something heavy-ish and reply
  let sum = 0;
  for (let i = 0; i < e.data; i++) sum += Math.sqrt(i);
  self.postMessage({ input: e.data, sum: Math.round(sum), tick: ++n });
};
