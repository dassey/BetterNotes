/* BetterNotes — on-device speech-to-text. A small open speech model runs inside a Web
   Worker (GPU when the browser offers it, WebAssembly otherwise). Audio never leaves the
   device; the model is fetched once from a public model library and cached for offline use.
   This file owns the microphone tap, the pause-based chunker that gives every passage its
   timestamp, and the after-the-fact transcription of saved recordings. */
(function () {
  'use strict';
  const T = {};
  const AC = window.AudioContext || window.webkitAudioContext;
  const SR = 16000;
  const FRAME = 320; // 20 ms at 16 kHz
  const RUNTIME_MB = 20;

  T.SUPPORTED = typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && !!AC &&
    typeof OfflineAudioContext !== 'undefined' && !!(AC.prototype && 'audioWorklet' in AC.prototype);

  T.MODELS = {
    'moonshine-tiny': { id: 'onnx-community/moonshine-tiny-ONNX', mb: 32, gpuMb: 80, multilingual: false },
    'moonshine-base': { id: 'onnx-community/moonshine-base-ONNX', mb: 67, gpuMb: 158, multilingual: false },
    'whisper-base': { id: 'onnx-community/whisper-base', mb: 81, gpuMb: 210, multilingual: true }
  };

  const cfg = {
    libUrl: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js',
    hubHost: null,
    hubPathTemplate: null,
    wasmPaths: null
  };
  T.configure = (o) => Object.assign(cfg, o || {});

  const settings = () => ({
    model: BN.Settings.get('audio.model') || 'moonshine-tiny',
    language: BN.Settings.get('audio.language') || 'auto',
    compute: BN.Settings.get('audio.compute') || 'auto'
  });
  T.modelInfo = () => T.MODELS[settings().model] || T.MODELS['moonshine-tiny'];
  let gpuOK = false;
  T.usesGPU = () => settings().compute !== 'cpu' && gpuOK;
  T.estimateMB = () => RUNTIME_MB + (T.usesGPU() ? T.modelInfo().gpuMb : T.modelInfo().mb);

  /* ---------------- engine: one worker, one loaded model ---------------- */

  let engine = null;
  const statusListeners = new Set();
  let lastStatus = { state: 'idle' };

  T.status = () => lastStatus;
  T.isReady = () => !!(engine && engine.device);
  T.onStatus = (fn) => { statusListeners.add(fn); return () => statusListeners.delete(fn); };
  function setStatus(st) {
    lastStatus = st;
    for (const fn of statusListeners) { try { fn(st); } catch (e) { /* listener error */ } }
  }

  // GPU is used only when the browser can actually hand us an adapter; a GPU load that
  // fails is remembered for this app version so the device does not retry it every launch.
  const GPU_FLAG = 'bn.speechGpuBroken';
  const gpuBroken = () => { try { return localStorage.getItem(GPU_FLAG) === BN.VERSION; } catch (e) { return false; } };
  const markGpuBroken = () => { try { localStorage.setItem(GPU_FLAG, BN.VERSION); } catch (e) { /* ignore */ } };
  async function probeGPU() {
    if (!navigator.gpu) return false;
    try { return !!(await navigator.gpu.requestAdapter()); } catch (e) { return false; }
  }
  let lastFailure = 0;
  probeGPU().then((ok) => { gpuOK = ok && !gpuBroken(); });

  T.ensureEngine = function () {
    if (engine) return engine.ready;
    if (Date.now() - lastFailure < 30000) return Promise.reject(new Error(lastStatus.message || 'speech engine unavailable'));
    const s = settings();
    const info = T.MODELS[s.model] || T.MODELS['moonshine-tiny'];
    const e = engine = { worker: null, device: null, pending: new Map(), nextId: 1 };
    e.ready = (async () => {
      const wantGPU = s.compute !== 'cpu' && !gpuBroken() && (await probeGPU());
      const devices = wantGPU ? ['webgpu', 'wasm'] : ['wasm'];
      let lastErr = null;
      for (const device of devices) {
        if (engine !== e) throw new Error('speech engine stopped');
        try {
          await startWorker(e, device, info, s);
          return { device };
        } catch (err) {
          lastErr = err;
          if (device === 'webgpu') markGpuBroken();
        }
      }
      if (engine === e) engine = null;
      lastFailure = Date.now();
      setStatus({ state: 'error', message: (lastErr && lastErr.message) || 'speech model failed to load' });
      throw lastErr || new Error('speech model failed to load');
    })();
    e.ready.catch(() => { });
    return e.ready;
  };

  function startWorker(e, device, info, s) {
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker('./js/transcribe-worker.js', { type: 'module' }); }
      catch (err) { reject(new Error('Speech recognition is not supported in this browser')); return; }
      if (e.worker) { try { e.worker.terminate(); } catch (err) { /* ignore */ } }
      e.worker = worker;
      e.device = null;
      setStatus({ state: 'loading', pct: 0, device });
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'progress') {
          const pct = m.total ? Math.min(99, Math.round((100 * m.loaded) / m.total)) : 0;
          setStatus({ state: 'loading', pct, loaded: m.loaded, total: m.total, device });
        } else if (m.type === 'ready') {
          e.device = m.device;
          setStatus({ state: 'ready', device: m.device });
          resolve();
        } else if (m.type === 'error') {
          try { worker.terminate(); } catch (err) { /* ignore */ }
          if (e.worker === worker) e.worker = null;
          reject(new Error(m.message));
        } else if (m.type === 'result') {
          const p = e.pending.get(m.id);
          if (p) { e.pending.delete(m.id); p.resolve(m); }
        }
      };
      worker.onerror = (err) => {
        try { worker.terminate(); } catch (e2) { /* ignore */ }
        if (e.worker === worker) e.worker = null;
        reject(new Error((err && err.message) || 'speech worker failed'));
      };
      worker.postMessage({
        type: 'init',
        cfg: {
          libUrl: cfg.libUrl, hubHost: cfg.hubHost, hubPathTemplate: cfg.hubPathTemplate, wasmPaths: cfg.wasmPaths,
          modelId: info.id, multilingual: info.multilingual, language: s.language, device
        }
      });
    });
  }

  T.dispose = function () {
    if (!engine) return;
    const e = engine;
    engine = null;
    const w = e.worker;
    e.worker = null;
    if (w) {
      try { w.postMessage({ type: 'dispose' }); } catch (err) { /* ignore */ }
      setTimeout(() => { try { w.terminate(); } catch (err) { /* ignore */ } }, 300);
    }
    for (const p of e.pending.values()) p.resolve({ text: '', error: 'disposed' });
    e.pending.clear();
    setStatus({ state: 'idle' });
  };

  document.addEventListener('bn:settings-changed', (ev) => {
    if (['audio.model', 'audio.language', 'audio.compute'].includes(ev.detail.key) && engine) T.dispose();
  });

  async function transcribePCM(pcm) {
    await T.ensureEngine();
    const e = engine;
    if (!e || !e.worker) throw new Error('speech engine stopped');
    const id = e.nextId++;
    return new Promise((resolve) => {
      e.pending.set(id, { resolve });
      e.worker.postMessage({ type: 'transcribe', id, pcm }, [pcm.buffer]);
    });
  }

  const JUNK = /^(thank you\.?|thanks for watching\.?|you\.?|bye\.?|[.…\-–— ]+)$/i;
  function clean(t) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    if (!t || !/[\p{L}\p{N}]/u.test(t) || JUNK.test(t)) return '';
    return t;
  }

  /* ---------------- pause-based chunker (gives passages their timestamps) ---------------- */

  function createChunker(onChunk, opts) {
    const o = Object.assign({ preRollMs: 300, minSpeechMs: 350, endSilenceMs: 450, maxChunkMs: 10000, trimTailMs: 250 }, opts || {});
    let floor = 0.012;
    let frameBuf = new Float32Array(FRAME), fb = 0;
    const pre = [];
    let chunk = [], chunkStart = 0, speechMs = 0, silenceMs = 0, inSpeech = false, sampleIndex = 0;
    let lowest = { rms: Infinity, idx: -1 };

    function rmsOf(f) { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / f.length); }
    function emit(frames, startIdx, trimFrames) {
      const n = frames.length - trimFrames;
      if (n <= 0) return;
      const pcm = new Float32Array(n * FRAME);
      for (let i = 0; i < n; i++) pcm.set(frames[i], i * FRAME);
      onChunk({ pcm, t0: (startIdx / SR) * 1000, t1: ((startIdx + n * FRAME) / SR) * 1000 });
    }
    function frame(f, idx) {
      const rms = rmsOf(f);
      if (rms < floor) floor = Math.max(0.002, floor * 0.9 + rms * 0.1); else floor = Math.min(0.05, floor * 1.004);
      const speech = rms > Math.max(floor * 3, 0.008);
      if (!inSpeech) {
        pre.push(f);
        if (pre.length > o.preRollMs / 20) pre.shift();
        if (speech) {
          inSpeech = true;
          chunk = pre.slice();
          chunkStart = idx - (chunk.length - 1) * FRAME;
          speechMs = 20; silenceMs = 0;
          pre.length = 0;
          lowest = { rms: Infinity, idx: -1 };
        }
        return;
      }
      chunk.push(f);
      if (speech) { speechMs += 20; silenceMs = 0; } else silenceMs += 20;
      const chunkMs = chunk.length * 20;
      if (chunkMs > o.maxChunkMs - 1500 && rms < lowest.rms) lowest = { rms, idx: chunk.length - 1 };
      if (silenceMs >= o.endSilenceMs) {
        if (speechMs >= o.minSpeechMs) emit(chunk, chunkStart, Math.max(0, Math.floor((silenceMs - o.trimTailMs) / 20)));
        inSpeech = false; chunk = [];
        return;
      }
      if (chunkMs >= o.maxChunkMs) {
        const cut = lowest.idx > 0 ? lowest.idx : chunk.length - 1;
        emit(chunk.slice(0, cut), chunkStart, 0);
        const rest = chunk.slice(cut);
        chunkStart += cut * FRAME;
        chunk = rest; speechMs = rest.length * 20; silenceMs = 0;
        lowest = { rms: Infinity, idx: -1 };
      }
    }
    return {
      push(samples) {
        let i = 0;
        while (i < samples.length) {
          const take = Math.min(samples.length - i, FRAME - fb);
          frameBuf.set(samples.subarray(i, i + take), fb);
          fb += take; i += take;
          if (fb === FRAME) { frame(frameBuf, sampleIndex); sampleIndex += FRAME; frameBuf = new Float32Array(FRAME); fb = 0; }
        }
      },
      flush() {
        if (inSpeech && speechMs >= 400) emit(chunk, chunkStart, 0);
        inSpeech = false; chunk = [];
      },
      samples() { return sampleIndex; }
    };
  }

  // Chunks split by a mere breath are joined into one passage (easier to read and tap).
  function mergePassages(segs) {
    const out = [];
    for (const s of segs) {
      const prev = out[out.length - 1];
      if (prev && s.t0 - prev.t1 < 500 && s.t1 - prev.t0 <= 25000) {
        prev.text = (prev.text + ' ' + s.text).replace(/\s+/g, ' ');
        prev.t1 = Math.max(prev.t1, s.t1);
      } else out.push({ t0: s.t0, t1: s.t1, text: s.text });
    }
    return out;
  }

  // Sends chunks to the model and collects passages in order.
  function createCollector(offsetMs, onSegment) {
    const segs = [], promises = [];
    let lastText = '';
    const col = {
      segs, promises, error: null,
      take(c) {
        const p = transcribePCM(c.pcm).then((r) => {
          const text = clean(r.text);
          if (!text || text === lastText) return;
          lastText = text;
          const off = typeof offsetMs === 'function' ? offsetMs() : offsetMs;
        const seg = { t0: Math.round(c.t0 + off), t1: Math.round(c.t1 + off), text };
          segs.push(seg);
          if (onSegment) onSegment(seg);
        }).catch((err) => { col.error = err; });
        promises.push(p);
        return p;
      },
      async settle() { await Promise.allSettled(promises); return mergePassages(segs.sort((a, b) => a.t0 - b.t0)); }
    };
    return col;
  }

  /* ---------------- live: tap the microphone while recording ---------------- */

  let sharedCtx = null;
  // Call synchronously inside a tap: browsers only let audio start from a user gesture.
  T.touchAudio = function () {
    if (!T.SUPPORTED) return null;
    try {
      if (!sharedCtx || sharedCtx.state === 'closed') {
        try { sharedCtx = new AC({ sampleRate: SR }); } catch (e) { sharedCtx = new AC(); }
      }
      if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => { });
    } catch (e) { sharedCtx = null; }
    return sharedCtx;
  };

  async function captureNode(ctx) {
    if (!ctx.bnWorkletReady) {
      await ctx.audioWorklet.addModule('./js/capture-worklet.js');
      ctx.bnWorkletReady = true;
    }
    return new AudioWorkletNode(ctx, 'bn-capture');
  }

  T.createLiveSession = function (stream, h) {
    h = h || {};
    const ctx = T.touchAudio();
    let node = null, src = null, offset = null, stopped = false;
    let dead = false;
    const chunker = createChunker((c) => { if (!dead && !collector.error) collector.take(c); });
    const collector = createCollector(() => offset || 0, (seg) => { if (h.onSegment) h.onSegment(seg); });
    const startedAt = h.startedAt || Date.now();

    const ready = (async () => {
      if (!ctx) throw new Error('Audio is not available');
      T.ensureEngine().catch(() => { });
      node = await captureNode(ctx);
      src = ctx.createMediaStreamSource(stream);
      src.connect(node);
      node.connect(ctx.destination); // the worklet outputs silence; connecting keeps it running
      node.port.onmessage = (e) => {
        if (stopped && !(e.data && e.data.length)) return;
        if (offset == null) offset = Math.max(0, Date.now() - startedAt - (e.data.length / SR) * 1000);
        chunker.push(e.data);
      };
      await T.ensureEngine();
    })();
    ready.catch(() => { dead = true; });

    return {
      ready,
      segments: collector.segs,
      async stop() {
        stopped = true;
        try { if (node) node.port.postMessage('stop'); } catch (e) { /* ignore */ }
        await new Promise((r) => setTimeout(r, 80));
        chunker.flush();
        try { if (src) src.disconnect(); if (node) node.disconnect(); } catch (e) { /* ignore */ }
        if (stream.getAudioTracks().every((t) => t.readyState === 'ended') && ctx && ctx.state === 'running') ctx.suspend().catch(() => { });
        const segs = await Promise.race([collector.settle(), new Promise((r) => setTimeout(() => r(mergePassages(collector.segs.slice().sort((a, b) => a.t0 - b.t0))), 120000))]);
        return segs.map((s) => ({ t0: s.t0, t1: s.t1, text: s.text }));
      }
    };
  };

  /* ---------------- after the fact: transcribe a saved recording ---------------- */

  T.transcribeClip = async function (clip, h) {
    h = h || {};
    const collector = createCollector(0, h.onSegment);
    const chunker = createChunker((c) => collector.take(c));
    const report = (f) => { if (h.onProgress) h.onProgress(Math.max(0, Math.min(1, f))); };
    T.ensureEngine().catch(() => { });
    const duration = clip.duration || 0;
    let decoded = false;
    if (duration <= 30 * 60 * 1000) {
      try {
        const ab = await clip.blob.arrayBuffer();
        const off = new OfflineAudioContext(1, SR, SR);
        const buf = await off.decodeAudioData(ab);
        const n = buf.length, ch = buf.numberOfChannels;
        const mono = new Float32Array(n);
        for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
        const step = SR * 5;
        for (let i = 0; i < n; i += step) {
          chunker.push(mono.subarray(i, Math.min(n, i + step)));
          report((0.3 * i) / n);
          await new Promise((r) => setTimeout(r, 0));
        }
        chunker.flush();
        decoded = true;
      } catch (e) { decoded = false; }
    }
    if (!decoded) await playThrough(clip, chunker, (f) => report(0.3 * f));
    await T.ensureEngine();
    const total = collector.promises.length;
    let done = 0;
    for (const p of collector.promises) p.then(() => { done++; report(0.3 + (0.7 * done) / Math.max(1, total)); });
    const segs = await collector.settle();
    if (collector.error && !segs.length) throw collector.error;
    report(1);
    return segs.map((s) => ({ t0: s.t0, t1: s.t1, text: s.text }));
  };

  // Long recordings: play silently through the capture graph at normal speed.
  function playThrough(clip, chunker, onProgress) {
    return new Promise(async (resolve, reject) => {
      const ctx = T.touchAudio();
      if (!ctx) { reject(new Error('Audio is not available')); return; }
      const url = URL.createObjectURL(clip.blob);
      const audio = new Audio(url);
      audio.preload = 'auto';
      let node, src;
      const finish = (err) => {
        try { if (src) src.disconnect(); if (node) { node.port.postMessage('stop'); node.disconnect(); } } catch (e) { /* ignore */ }
        URL.revokeObjectURL(url);
        if (err) reject(err); else { setTimeout(() => { chunker.flush(); resolve(); }, 100); }
      };
      try {
        node = await captureNode(ctx);
        src = ctx.createMediaElementSource(audio);
        src.connect(node);
        node.connect(ctx.destination);
        node.port.onmessage = (e) => { if (e.data && e.data.length) chunker.push(e.data); };
        audio.addEventListener('timeupdate', () => { if (audio.duration) onProgress(audio.currentTime / audio.duration); });
        audio.addEventListener('ended', () => finish(null));
        audio.addEventListener('error', () => finish(new Error('Could not read this recording')));
        await audio.play();
      } catch (e) { finish(e); }
    });
  }

  /* ---------------- storage used by the downloaded runtime + model ---------------- */

  const isOurCache = (name) => name === 'transformers-cache' || name.startsWith('bn-vendor');

  T.cachedBytes = async function () {
    if (!('caches' in window)) return 0;
    let total = 0;
    for (const name of await caches.keys()) {
      if (!isOurCache(name)) continue;
      const c = await caches.open(name);
      for (const req of await c.keys()) {
        const r = await c.match(req);
        if (!r) continue;
        const len = r.headers.get('content-length');
        if (len) total += +len; else total += (await r.clone().arrayBuffer()).byteLength;
      }
    }
    return total;
  };

  T.deleteModels = async function () {
    T.dispose();
    if (!('caches' in window)) return 0;
    const bytes = await T.cachedBytes();
    for (const name of await caches.keys()) if (isOurCache(name)) await caches.delete(name);
    return bytes;
  };

  window.BN = window.BN || {};
  window.BN.Transcribe = T;
})();
