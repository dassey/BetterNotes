/* BetterNotes — speech-to-text worker. Loads a small open speech model with the
   Transformers.js runtime (fetched once from a public CDN and cached offline) and turns
   16 kHz PCM chunks into text. Nothing is uploaded: inference runs here, on the device. */

let asr = null;
let cfg = null;
let queue = Promise.resolve();

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') init(m.cfg);
  else if (m.type === 'transcribe') queue = queue.then(() => run(m));
  else if (m.type === 'dispose') dispose();
};

function post(msg) { self.postMessage(msg); }

async function init(c) {
  cfg = c;
  let lib;
  try {
    lib = await import(c.libUrl);
  } catch (err) {
    post({ type: 'error', message: 'Could not load the speech runtime (offline?): ' + String((err && err.message) || err) });
    return;
  }
  const { pipeline, env } = lib;
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  if (c.hubHost) env.remoteHost = c.hubHost;
  if (c.hubPathTemplate) env.remotePathTemplate = c.hubPathTemplate;
  if (c.wasmPaths && env.backends && env.backends.onnx && env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = c.wasmPaths;

  const files = {};
  const onProgress = (p) => {
    if (!p || !p.file) return;
    if (p.status === 'initiate') files[p.file] = { loaded: 0, total: p.total || 0 };
    else if (p.status === 'progress') files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
    else if (p.status === 'done') { const f = files[p.file] || { total: 0 }; files[p.file] = { loaded: f.total || p.total || 0, total: f.total || p.total || 0 }; }
    else return;
    let loaded = 0, total = 0;
    for (const k in files) { loaded += files[k].loaded; total += files[k].total; }
    post({ type: 'progress', loaded, total, file: p.file, status: p.status });
  };

  const device = c.device === 'webgpu' ? 'webgpu' : 'wasm';
  try {
    const dtype = device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';
    asr = await pipeline('automatic-speech-recognition', c.modelId, { device, dtype, progress_callback: onProgress });
    await asr(new Float32Array(16000), genOpts(16000)); // warm-up; also proves the device works
    post({ type: 'ready', device });
  } catch (err) {
    asr = null;
    post({ type: 'error', device, message: String((err && err.message) || err || 'speech model failed to load') });
  }
}

function genOpts(samples) {
  const o = { max_new_tokens: Math.min(440, Math.ceil((samples / 16000) * 8) + 8) };
  if (cfg && cfg.multilingual) {
    o.task = 'transcribe';
    if (cfg.language && cfg.language !== 'auto') o.language = cfg.language;
  }
  return o;
}

async function run(m) {
  if (!asr) { post({ type: 'result', id: m.id, text: '', error: 'not ready' }); return; }
  try {
    const out = await asr(m.pcm, genOpts(m.pcm.length));
    post({ type: 'result', id: m.id, text: String((out && out.text) || '').trim() });
  } catch (err) {
    post({ type: 'result', id: m.id, text: '', error: String((err && err.message) || err) });
  }
}

async function dispose() {
  const a = asr;
  asr = null;
  try { if (a && a.dispose) await a.dispose(); } catch (err) { /* ignore */ }
}
