/* BetterNotes — on-device speech-to-text. Moonshine Voice (MIT) runs in multithreaded
   WebAssembly inside a worker: streaming models that return finished sentences with
   timestamps while the lecturer is still talking. Audio never leaves the device; the
   runtime and the chosen model are fetched once from public CDNs and cached offline.
   Threads need a cross-origin-isolated page, so the service worker adds the two headers
   GitHub Pages cannot send, and the first use reloads the page once to pick them up. */
(function () {
  'use strict';
  const T = {};
  const AC = window.AudioContext || window.webkitAudioContext;
  const SR = 16000;
  const RUNTIME_MB = 14;

  T.SUPPORTED = typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && !!AC &&
    typeof OfflineAudioContext !== 'undefined' && !!(AC.prototype && 'audioWorklet' in AC.prototype) &&
    (!!window.crossOriginIsolated || 'serviceWorker' in navigator);
  T.isolated = () => !!window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
  // The page must reload once after the service worker starts adding the isolation headers.
  T.needsReload = () => T.SUPPORTED && !T.isolated();

  // Moonshine v2 streaming models. Download sizes measured from the Moonshine CDN (2026-10).
  T.MODELS = {
    tiny: { arch: 'TinyStreaming', mb: 51 },
    small: { arch: 'SmallStreaming', mb: 166 },
    medium: { arch: 'MediumStreaming', mb: 305 }
  };
  // Sizes published per language (English has all three).
  T.LANGUAGES = {
    en: ['tiny', 'small', 'medium'], es: ['tiny', 'small'], de: ['tiny', 'small'], ja: ['tiny', 'small'],
    zh: ['tiny'], ar: ['tiny'], vi: ['tiny'], tl: ['tiny']
  };
  const cfg = { libUrl: 'https://cdn.jsdelivr.net/npm/@moonshine-ai/moonshine-wasm@0.1.5/dist/index.js' };
  T.configure = (o) => Object.assign(cfg, o || {});

  function settings() {
    let lang = BN.Settings.get('audio.language') || 'en';
    if (!T.LANGUAGES[lang]) lang = 'en';
    const sizes = T.LANGUAGES[lang];
    let model = BN.Settings.get('audio.model') || 'small';
    if (!sizes.includes(model)) model = sizes[sizes.length - 1];
    return { lang, model };
  }
  T.choice = settings;
  T.estimateMB = () => RUNTIME_MB + T.MODELS[settings().model].mb;

  /* ---------------- engine: the library, one worker, one loaded model ---------------- */

  let engine = null;
  let lastStatus = { state: 'idle' };
  let lastFailure = 0;
  const statusListeners = new Set();

  T.status = () => lastStatus;
  T.isReady = () => !!(engine && engine.loaded);
  T.onStatus = (fn) => { statusListeners.add(fn); return () => statusListeners.delete(fn); };
  function setStatus(st) {
    lastStatus = st;
    for (const fn of statusListeners) { try { fn(st); } catch (e) { /* listener error */ } }
  }
  function friendly(err) {
    const m = String((err && err.message) || err || '');
    if (/fetch|network|download|load failed|Failed to/i.test(m)) return 'Could not download the speech model — check the connection';
    return m || 'Speech recognition failed';
  }

  T.ensureEngine = function () {
    if (engine) return engine.ready;
    if (!T.isolated()) return Promise.reject(new Error('Speech recognition needs a one-time reload'));
    if (Date.now() - lastFailure < 30000) return Promise.reject(new Error(lastStatus.message || 'Speech recognition is unavailable'));
    const s = settings();
    const e = engine = { host: null, lib: null, loaded: false };
    setStatus({ state: 'loading', pct: 0 });
    e.ready = (async () => {
      const lib = await import(cfg.libUrl);
      if (engine !== e) throw new Error('speech engine stopped');
      e.lib = lib;
      const host = new lib.SttWorkerHost();
      e.host = host;
      host.onProgress = (id, loaded, total) => {
        const pct = total ? Math.min(99, Math.round((100 * loaded) / total)) : 0;
        setStatus({ state: 'loading', pct, loaded, total });
      };
      await host.loadTranscriber({
        transcriberId: 'bn',
        modelArch: lib.ModelArch[T.MODELS[s.model].arch],
        source: { kind: 'catalog', language: s.lang }
      });
      if (engine !== e) throw new Error('speech engine stopped');
      e.loaded = true;
      setStatus({ state: 'ready', model: s.model, language: s.lang });
      return { model: s.model, language: s.lang };
    })();
    e.ready.catch((err) => {
      if (engine !== e) return;
      engine = null;
      lastFailure = Date.now();
      try { if (e.host) e.host.close(); } catch (x) { /* ignore */ }
      setStatus({ state: 'error', message: friendly(err) });
    });
    return e.ready;
  };

  T.dispose = function () {
    if (!engine) return;
    const e = engine;
    engine = null;
    try { if (e.host) e.host.close(); } catch (x) { /* ignore */ }
    setStatus({ state: 'idle' });
  };

  document.addEventListener('bn:settings-changed', (ev) => {
    if (['audio.model', 'audio.language'].includes(ev.detail.key) && engine) T.dispose();
  });

  function clean(t) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    return /[\p{L}\p{N}]/u.test(t) ? t : '';
  }

  // A worker-side stream. Finished lines arrive with their own timestamps (seconds from
  // the start of the stream); partial text arrives while a line is still being spoken.
  let streamSeq = 0;
  async function openStream(onLine, onPartial) {
    await T.ensureEngine();
    const e = engine;
    if (!e) throw new Error('speech engine stopped');
    const id = 'bn-' + (++streamSeq);
    const lines = new Map();
    e.host.setListener(id, {
      onLineUpdated: (ev) => { if (onPartial && ev.line && !ev.line.isComplete) onPartial(clean(ev.line.text)); },
      onLineCompleted: (ev) => {
        const l = ev.line;
        const text = clean(l.text);
        if (!text) return;
        const seg = { t0: Math.round(l.startTime * 1000), t1: Math.round((l.startTime + l.duration) * 1000), text };
        lines.set(l.id, seg);
        if (onLine) onLine(seg);
      },
      onError: (ev) => setStatus({ state: 'error', message: friendly(ev.error) })
    });
    await e.host.createStream('bn', id, { updateInterval: 0.5 });
    await e.host.start(id);
    return {
      push(pcm) { if (engine === e && pcm && pcm.length) e.host.addAudio(id, pcm, SR); },
      queued() { return engine === e ? e.host.queuedSeconds(id) : 0; },
      async stop() {
        if (engine !== e) return [...lines.values()];
        try { await e.host.stop(id); } catch (x) { /* ignore */ }
        try { await e.host.closeStream(id); } catch (x) { /* ignore */ }
        return [...lines.values()].sort((a, b) => a.t0 - b.t0);
      }
    };
  }

  /* ---------------- microphone tap (shared with the recorder) ---------------- */

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
    const startedAt = h.startedAt || Date.now();
    const segs = [];
    const early = []; // audio captured while the model is still loading
    let node = null, src = null, offset = null, stopped = false, s = null;

    const ready = (async () => {
      if (!ctx) throw new Error('Audio is not available');
      node = await captureNode(ctx);
      src = ctx.createMediaStreamSource(stream);
      src.connect(node);
      node.connect(ctx.destination); // the worklet outputs silence; connecting keeps it running
      node.port.onmessage = (ev) => {
        const pcm = ev.data;
        if (!pcm || !pcm.length) return;
        if (offset == null) offset = Math.max(0, Date.now() - startedAt - (pcm.length / SR) * 1000);
        if (s) s.push(pcm);
        else if (!stopped && early.length < 30 * 60 * (SR / 1024)) early.push(pcm);
      };
      s = await openStream((seg) => {
        const out = { t0: seg.t0 + (offset || 0), t1: seg.t1 + (offset || 0), text: seg.text };
        segs.push(out);
        if (h.onSegment) h.onSegment(out);
      }, (text) => { if (h.onPartial) h.onPartial(text); });
      for (const b of early) s.push(b);
      early.length = 0;
    })();
    ready.catch(() => { early.length = 0; });

    return {
      ready,
      segments: segs,
      async stop() {
        stopped = true;
        try { if (node) node.port.postMessage('stop'); } catch (e) { /* ignore */ }
        await new Promise((r) => setTimeout(r, 80));
        try { if (src) src.disconnect(); if (node) node.disconnect(); } catch (e) { /* ignore */ }
        if (stream.getAudioTracks().every((t) => t.readyState === 'ended') && ctx && ctx.state === 'running') ctx.suspend().catch(() => { });
        try { await ready; } catch (e) { return segs; }
        if (s) await Promise.race([s.stop(), new Promise((r) => setTimeout(r, 60000))]);
        return segs.slice().sort((a, b) => a.t0 - b.t0);
      }
    };
  };

  /* ---------------- after the fact: transcribe a saved recording ---------------- */

  T.transcribeClip = async function (clip, h) {
    h = h || {};
    const report = (f) => { if (h.onProgress) h.onProgress(Math.max(0, Math.min(1, f))); };
    const segs = [];
    const s = await openStream((seg) => { segs.push(seg); if (h.onSegment) h.onSegment(seg); }, null);
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
        const step = SR * 2;
        for (let i = 0; i < n; i += step) {
          s.push(mono.slice(i, Math.min(n, i + step))); // a copy: the buffer is handed to the worker
          while (s.queued() > 20) await new Promise((r) => setTimeout(r, 100));
          report((0.9 * i) / n);
        }
        decoded = true;
      } catch (e) { decoded = false; }
    }
    if (!decoded) await playThrough(clip, (pcm) => s.push(pcm), (f) => report(0.9 * f));
    await s.stop();
    report(1);
    return segs.sort((a, b) => a.t0 - b.t0);
  };

  // Long recordings: play silently through the capture graph at normal speed.
  function playThrough(clip, onPcm, onProgress) {
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
        if (err) reject(err); else setTimeout(resolve, 150);
      };
      try {
        node = await captureNode(ctx);
        src = ctx.createMediaElementSource(audio);
        src.connect(node);
        node.connect(ctx.destination);
        node.port.onmessage = (e) => { if (e.data && e.data.length) onPcm(e.data); };
        audio.addEventListener('timeupdate', () => { if (audio.duration) onProgress(audio.currentTime / audio.duration); });
        audio.addEventListener('ended', () => finish(null));
        audio.addEventListener('error', () => finish(new Error('Could not read this recording')));
        await audio.play();
      } catch (e) { finish(e); }
    });
  }

  /* ---------------- storage used by the runtime + models ---------------- */

  const isOurCache = (name) => name === 'moonshine-models-v1' || name === 'transformers-cache' || name.startsWith('bn-vendor');

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
