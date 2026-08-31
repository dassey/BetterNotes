/* BetterNotes — note editor. Owns pointer/Pencil input, tools, gestures,
   selection, undo/redo, the DOM text layer and autosave for the open note. */
(function () {
  'use strict';
  const U = BN.util;
  const Ink = BN.ink;
  const S = BN.Settings;

  const Editor = {};
  let app = null;
  let renderer = null;
  let note = null;
  let tool = 'pen';
  let action = null;            // current pointer interaction
  let selection = null;         // {ids:[], bbox}
  let undoStack = [], redoStack = [];
  const pointers = new Map();   // pointerId → {type, x, y, sx, sy, t}
  let wrapRect = null;
  let autosave = null;
  let lastThumbAt = 0;
  let touchTap = null;          // two-finger-tap undo candidate
  let el = {};                  // dom refs

  const MIN_S = 0.15, MAX_S = 6;
  const PRESETS = ['#1d1d2e', '#4f7cff', '#e5484d', '#2f9e44', '#f59f00', '#9c36b5', '#0ca678', '#846358', '#ffffff'];
  const HIGH_PRESETS = ['#ffd60a', '#7ae582', '#6ec3ff', '#ff8fa3', '#d0a5ff', '#ffb347'];

  /* =================== lifecycle =================== */

  Editor.init = function (appRef) {
    app = appRef;
    el = {
      screen: document.getElementById('screen-editor'),
      wrap: document.getElementById('canvasWrap'),
      inkC: document.getElementById('inkCanvas'),
      liveC: document.getElementById('liveCanvas'),
      textLayer: document.getElementById('textLayer'),
      title: document.getElementById('ed-title'),
      undo: document.getElementById('ed-undo'),
      redo: document.getElementById('ed-redo'),
      selActions: document.getElementById('selActions'),
      tools: document.getElementById('ed-tools'),
      imgInput: document.getElementById('imgInput')
    };
    renderer = new BN.Renderer(el.wrap, el.inkC, el.liveC);
    bindToolbar();
    bindPointerEvents();
    bindKeyboard();
    makeAutosave();
    document.addEventListener('bn:settings-changed', (e) => {
      if (e.detail.key === 'storage.autosaveMs') makeAutosave();
      if (e.detail.key.startsWith('appearance.') && note) renderAll();
      updateToolIndicators();
    });
    document.addEventListener('bn:image-ready', () => { if (note) renderAll(); });
    window.addEventListener('resize', () => { if (note) { renderer.resize(); wrapRect = null; clampT(renderer.t); renderAll(); } });
  };

  function makeAutosave() {
    const prev = autosave;
    autosave = U.debounce(doSave, S.get('storage.autosaveMs') || 900);
    if (prev) prev.cancel();
  }

  Editor.open = function (noteObj) {
    note = noteObj;
    undoStack = []; redoStack = [];
    selection = null; action = null;
    pointers.clear();
    el.title.value = note.title;
    el.screen.hidden = false;
    renderer.resize();
    wrapRect = null;
    if (note.view && note.view.s) {
      renderer.t = { ...note.view };
      clampT(renderer.t);
    } else {
      fitWidth();
    }
    rebuildTextLayer();
    renderAll();
    setTool(tool || 'pen');
    updateUndoButtons();
  };

  Editor.close = async function () {
    if (!note) return;
    closePopover();
    commitFocusedText();
    autosave.cancel();
    await doSave(true);
    el.screen.hidden = true;
    el.textLayer.innerHTML = '';
    note = null;
  };

  Editor.isOpen = () => !!note;
  Editor.flush = () => { if (note) { autosave.cancel(); return doSave(false); } };

  async function doSave(withThumb) {
    if (!note) return;
    note.view = { ...renderer.t };
    let thumb = null;
    const now = Date.now();
    if (withThumb === true || now - lastThumbAt > 6000) {
      try { thumb = await renderer.thumbnail(note); lastThumbAt = now; } catch (e) { /* ignore */ }
    }
    try {
      await BN.Store.saveNote(note, thumb);
    } catch (e) {
      app.toast('Could not save — storage may be full', true);
    }
  }

  function markDirty() {
    if (!note) return;
    autoExtendPage();
    autosave();
  }

  /* =================== view transform =================== */

  function fitWidth() {
    const m = 24;
    const s = U.clamp((renderer.w - m * 2) / note.width, MIN_S, MAX_S);
    renderer.t = { s, x: (renderer.w - note.width * s) / 2, y: 20 };
  }

  function clampT(t) {
    t.s = U.clamp(t.s, MIN_S, MAX_S);
    const pw = note.width * t.s, ph = note.height * t.s;
    const mx = 40;
    if (pw <= renderer.w - mx * 2) t.x = (renderer.w - pw) / 2;
    else t.x = U.clamp(t.x, renderer.w - pw - mx, mx);
    t.y = U.clamp(t.y, Math.min(60, renderer.h - ph - 260), 60);
  }

  const sharpRender = U.debounce(() => { if (note) renderAll(); }, 150);

  function renderAll() {
    renderer.render(note);
    renderer.renderLive(drawOverlays);
    updateTextLayerTransform();
    positionSelActions();
  }

  function updateTextLayerTransform() {
    const t = renderer.t;
    el.textLayer.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.s})`;
  }

  function autoExtendPage() {
    let bottom = 0;
    for (const it of note.items) {
      const bb = BN.itemBBox(it);
      bottom = Math.max(bottom, bb.y + bb.h);
    }
    if (bottom > note.height - 140) note.height = Math.round(bottom + 420);
  }

  /* =================== undo =================== */

  function pushOp(op) {
    undoStack.push(op);
    const depth = S.get('storage.undoDepth') || 60;
    while (undoStack.length > depth) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
    markDirty();
  }

  function doUndo() {
    const op = undoStack.pop();
    if (!op) return;
    op.undo();
    redoStack.push(op);
    afterHistoryChange();
  }
  function doRedo() {
    const op = redoStack.pop();
    if (!op) return;
    op.redo();
    undoStack.push(op);
    afterHistoryChange();
  }
  Editor.undo = doUndo;
  Editor.redo = doRedo;

  function afterHistoryChange() {
    if (selection) {
      const alive = new Set(note.items.map((i) => i.id));
      selection.ids = selection.ids.filter((id) => alive.has(id));
      if (!selection.ids.length) selection = null;
    }
    updateSelectionBBox();
    rebuildTextLayer();
    renderAll();
    updateUndoButtons();
    markDirty();
  }

  function updateUndoButtons() {
    el.undo.disabled = !undoStack.length;
    el.redo.disabled = !redoStack.length;
  }

  const byId = (id) => note.items.find((i) => i.id === id);
  const indexOfId = (id) => note.items.findIndex((i) => i.id === id);

  function opAdd(items) {
    const ids = items.map((i) => i.id);
    return {
      undo() { note.items = note.items.filter((i) => !ids.includes(i.id)); },
      redo() { note.items.push(...items); }
    };
  }
  function opRemove(entries) { // entries: [{item, index}] sorted by index asc
    entries = entries.slice().sort((a, b) => a.index - b.index);
    return {
      undo() { for (const e of entries) note.items.splice(Math.min(e.index, note.items.length), 0, e.item); },
      redo() {
        const ids = new Set(entries.map((e) => e.item.id));
        note.items = note.items.filter((i) => !ids.has(i.id));
      }
    };
  }
  function opMove(ids, dx, dy) {
    return {
      undo() { translateItems(ids, -dx, -dy); },
      redo() { translateItems(ids, dx, dy); }
    };
  }
  function opScale(ids, f, cx, cy) {
    return {
      undo() { scaleItems(ids, 1 / f, cx, cy); },
      redo() { scaleItems(ids, f, cx, cy); }
    };
  }
  function opFields(id, before, after) { // shallow field patches on one item
    return {
      undo() { const it = byId(id); if (it) { Object.assign(it, U.deepClone(before)); delete it._bb; } },
      redo() { const it = byId(id); if (it) { Object.assign(it, U.deepClone(after)); delete it._bb; } }
    };
  }
  function opGroup(ops) {
    return {
      undo() { for (let i = ops.length - 1; i >= 0; i--) ops[i].undo(); },
      redo() { for (const o of ops) o.redo(); }
    };
  }

  function translateItems(ids, dx, dy) {
    for (const id of ids) {
      const it = byId(id);
      if (!it) continue;
      if (it.type === 'stroke') {
        for (const p of it.points) { p.x += dx; p.y += dy; }
        delete it._bb;
      } else { it.x += dx; it.y += dy; }
    }
  }

  function scaleItems(ids, f, cx, cy) {
    for (const id of ids) {
      const it = byId(id);
      if (!it) continue;
      if (it.type === 'stroke') {
        for (const p of it.points) {
          p.x = cx + (p.x - cx) * f;
          p.y = cy + (p.y - cy) * f;
        }
        it.size *= f;
        delete it._bb;
      } else {
        it.x = cx + (it.x - cx) * f;
        it.y = cy + (it.y - cy) * f;
        it.w *= f;
        if (it.type === 'image') it.h *= f;
        if (it.type === 'text') { it.size *= f; it.h *= f; }
      }
    }
  }

  /* =================== selection =================== */

  function setSelection(ids) {
    selection = ids && ids.length ? { ids: ids.slice(), bbox: null } : null;
    updateSelectionBBox();
    renderer.renderLive(drawOverlays);
    positionSelActions();
  }

  function updateSelectionBBox() {
    if (!selection) return;
    let bb = null;
    for (const id of selection.ids) {
      const it = byId(id);
      if (it) bb = U.unionBBox(bb, BN.itemBBox(it));
    }
    selection.bbox = bb;
    if (!bb) selection = null;
  }

  function selectedItems() {
    return selection ? selection.ids.map(byId).filter(Boolean) : [];
  }

  function handlePositions(bb) {
    return [
      { x: bb.x, y: bb.y }, { x: bb.x + bb.w, y: bb.y },
      { x: bb.x + bb.w, y: bb.y + bb.h }, { x: bb.x, y: bb.y + bb.h }
    ];
  }

  function drawOverlays(ctx) {
    if (!selection || !selection.bbox) return;
    const t = renderer.t;
    const bb = selection.bbox;
    const off = action && action.kind === 'moveSel' ? { x: action.dx, y: action.dy } : { x: 0, y: 0 };
    ctx.save();
    ctx.translate(off.x, off.y);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4f7cff';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5 / t.s;
    ctx.setLineDash([6 / t.s, 5 / t.s]);
    ctx.strokeRect(bb.x, bb.y, bb.w, bb.h);
    ctx.setLineDash([]);
    const hs = 9 / t.s;
    for (const h of handlePositions(bb)) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(h.x, h.y, hs, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function positionSelActions() {
    if (!selection || !selection.bbox || (action && action.kind !== 'moveSel')) {
      el.selActions.hidden = true;
      return;
    }
    const bb = selection.bbox;
    const off = action && action.kind === 'moveSel' ? { x: action.dx, y: action.dy } : { x: 0, y: 0 };
    const p = renderer.screenFromWorld(bb.x + bb.w / 2 + off.x, bb.y + off.y);
    el.selActions.hidden = false;
    const bw = el.selActions.offsetWidth || 200;
    const x = U.clamp(p.x - bw / 2, 8, renderer.w - bw - 8);
    const y = U.clamp(p.y - 54, 8, renderer.h - 52);
    el.selActions.style.left = x + 'px';
    el.selActions.style.top = y + 'px';
  }

  function deleteSelection() {
    if (!selection) return;
    const entries = [];
    for (const id of selection.ids) {
      const idx = indexOfId(id);
      if (idx >= 0) entries.push({ item: note.items[idx], index: idx });
    }
    const op = opRemove(entries);
    op.redo();
    pushOp(op);
    setSelection(null);
    rebuildTextLayer();
    renderAll();
  }

  function duplicateSelection() {
    if (!selection) return;
    const clones = [];
    for (const it of selectedItems()) {
      const c = U.deepClone(it);
      c.id = U.uid();
      delete c._bb;
      if (c.type === 'stroke') for (const p of c.points) { p.x += 22; p.y += 22; }
      else { c.x += 22; c.y += 22; }
      clones.push(c);
    }
    note.items.push(...clones);
    pushOp(opAdd(clones));
    rebuildTextLayer();
    setSelection(clones.map((c) => c.id));
    renderAll();
  }

  function tidySelection() {
    if (!selection) return;
    const strength = S.get('hand.tidyStrength') || 0.55;
    const ops = [];
    let n = 0;
    for (const it of selectedItems()) {
      if (it.type !== 'stroke') continue;
      const before = { points: it.points };
      const after = { points: Ink.tidyPoints(it.points, strength) };
      it.points = after.points;
      delete it._bb;
      ops.push(opFields(it.id, before, after));
      n++;
    }
    if (!n) { app.toast('Select some ink to tidy'); return; }
    pushOp(opGroup(ops));
    updateSelectionBBox();
    renderAll();
    app.toast(`Tidied ${n} stroke${n > 1 ? 's' : ''}`);
  }

  function recolorSelection(color) {
    if (!selection) return;
    const ops = [];
    for (const it of selectedItems()) {
      if (it.type === 'image') continue;
      ops.push(opFields(it.id, { color: it.color }, { color }));
      it.color = color;
    }
    if (!ops.length) return;
    pushOp(opGroup(ops));
    rebuildTextLayer();
    renderAll();
  }

  function resizeSelectedText(size) {
    const items = selectedItems().filter((i) => i.type === 'text');
    for (const it of items) {
      it.size = size;
      const div = el.textLayer.querySelector(`[data-id="${it.id}"]`);
      if (div) { div.style.fontSize = size + 'px'; it.h = div.offsetHeight; }
    }
    updateSelectionBBox();
    renderer.renderLive(drawOverlays);
    markDirty();
  }

  /* =================== text layer =================== */

  function rebuildTextLayer() {
    commitFocusedText();
    el.textLayer.innerHTML = '';
    for (const it of note.items) {
      if (it.type === 'text') buildTextEl(it);
    }
    updateTextLayerTransform();
  }

  function buildTextEl(item) {
    const div = document.createElement('div');
    div.className = 'bn-text';
    div.dataset.id = item.id;
    div.contentEditable = 'true';
    div.spellcheck = false;
    div.style.left = item.x + 'px';
    div.style.top = item.y + 'px';
    div.style.width = item.w + 'px';
    div.style.fontSize = item.size + 'px';
    div.style.color = item.color;
    div.innerText = item.text || '';
    let beforeText = null;
    let committed = !!(item.text && item.text.length);
    div.addEventListener('focus', () => { beforeText = item.text || ''; div.classList.add('editing'); });
    div.addEventListener('input', () => {
      item.text = div.innerText.replace(/\n$/, '');
      item.h = div.offsetHeight;
      if (!committed && item.text.trim()) {
        committed = true;
        pushOp(opAdd([item]));
      }
      if (selection && selection.ids.includes(item.id)) {
        updateSelectionBBox();
        renderer.renderLive(drawOverlays);
      }
      markDirty();
    });
    div.addEventListener('blur', () => {
      div.classList.remove('editing');
      if (!item.text || !item.text.trim()) {
        // empty box: discard silently
        const idx = indexOfId(item.id);
        if (idx >= 0) note.items.splice(idx, 1);
        div.remove();
        if (selection) setSelection(selection.ids.filter((i) => i !== item.id));
        markDirty();
        return;
      }
      if (committed && beforeText !== null && beforeText !== item.text && beforeText !== '') {
        pushOp(opFields(item.id, { text: beforeText }, { text: item.text }));
      }
      item.h = div.offsetHeight;
      markDirty();
    });
    el.textLayer.appendChild(div);
    item.h = div.offsetHeight || item.size * 1.5;
    return div;
  }

  function commitFocusedText() {
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('bn-text')) active.blur();
  }

  function createTextAt(w) {
    const size = 18;
    const item = {
      id: U.uid(), type: 'text',
      x: U.clamp(w.x, 0, note.width - 140),
      y: Math.max(0, w.y - size * 0.75),
      w: U.clamp(note.width - w.x - 24, 140, 420),
      h: size * 1.5, size,
      color: S.get('ink.penColor'),
      text: ''
    };
    note.items.push(item); // op is pushed on first real input
    const div = buildTextEl(item);
    requestAnimationFrame(() => div.focus());
  }

  /* =================== images =================== */

  async function insertImageBlob(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const maxW = note.width * 0.62;
      const w = Math.min(maxW, bmp.width);
      const h = w * (bmp.height / bmp.width);
      const view = renderer.viewWorldRect(0);
      const item = {
        id: U.uid(), type: 'image',
        x: U.clamp(view.x + view.w / 2 - w / 2, 0, Math.max(0, note.width - w)),
        y: Math.max(12, view.y + view.h / 2 - h / 2),
        w, h, blob
      };
      renderer.images.set(item.id, { ready: true, bmp });
      note.items.push(item);
      pushOp(opAdd([item]));
      setTool('select');
      setSelection([item.id]);
      renderAll();
    } catch (e) {
      app.toast('Could not read that image', true);
    }
  }

  /* =================== pointer input =================== */

  function bindPointerEvents() {
    const w = el.wrap;
    w.addEventListener('pointerdown', onDown);
    w.addEventListener('pointermove', onMove);
    w.addEventListener('pointerup', onUp);
    w.addEventListener('pointercancel', onCancel);
    w.addEventListener('wheel', onWheel, { passive: false });
    // Block Safari's page pinch-zoom over the canvas.
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
      w.addEventListener(ev, (e) => e.preventDefault());
    }
    w.addEventListener('dragover', (e) => e.preventDefault());
    w.addEventListener('drop', (e) => {
      e.preventDefault();
      for (const f of e.dataTransfer.files) if (f.type.startsWith('image/')) insertImageBlob(f);
    });
    document.addEventListener('paste', (e) => {
      if (!note || document.activeElement?.isContentEditable || document.activeElement?.tagName === 'INPUT') return;
      for (const it of e.clipboardData.items) {
        if (it.type.startsWith('image/')) { insertImageBlob(it.getAsFile()); e.preventDefault(); }
      }
    });
  }

  function localXY(e) {
    if (!wrapRect) wrapRect = el.wrap.getBoundingClientRect();
    return { x: e.clientX - wrapRect.left, y: e.clientY - wrapRect.top };
  }

  const touchPointers = () => [...pointers.values()].filter((p) => p.type === 'touch');

  function onDown(e) {
    closePopover();
    // Let the browser handle taps into text boxes (focus/caret/Scribble).
    if (tool === 'text' && e.target.closest && e.target.closest('.bn-text')) return;
    if (e.target.closest && e.target.closest('#selActions')) return;
    commitFocusedText();
    e.preventDefault();
    try { el.wrap.setPointerCapture(e.pointerId); } catch (err) { }
    const s = localXY(e);
    pointers.set(e.pointerId, { type: e.pointerType, sx: s.x, sy: s.y, x: s.x, y: s.y, t: performance.now() });

    const isTouch = e.pointerType === 'touch';
    const pencilOnly = S.get('input.pencilOnly');

    if (isTouch) {
      const touches = touchPointers();
      if (touches.length === 2) {
        maybeStartPinch(e);
        return;
      }
      if (touches.length > 2) return;
      if (pencilOnly || tool === 'hand') { startPan(); return; }
      // else: finger draws with the current tool
    }
    if (e.pointerType === 'pen' && action && (action.kind === 'pan' || action.kind === 'pinch')) {
      action = null; // pen wins over a stray palm gesture
    }
    if (action) return;
    startToolAction(e, s);
  }

  function maybeStartPinch(e) {
    const touches = touchPointers();
    // Cancel a just-started finger stroke and turn it into a pinch.
    if (action && action.kind === 'draw' && action.byTouch) {
      const young = performance.now() - action.t0 < 320 && U.pathLength(action.item.points) * renderer.t.s < 24;
      if (young) action = null;
      else return; // committed stroke: ignore second touch (palm)
    } else if (action && action.kind !== 'pan' && action.kind !== 'pinch') {
      return;
    }
    const [a, b] = touches;
    touchTap = { t0: performance.now(), moved: 0 };
    action = {
      kind: 'pinch',
      ids: [touchKey(a), touchKey(b)],
      startDist: Math.max(12, U.dist(a.x, a.y, b.x, b.y)),
      startCenter: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      startT: { ...renderer.t }
    };
  }
  function touchKey(p) {
    for (const [id, v] of pointers) if (v === p) return id;
    return null;
  }

  function startPan() {
    action = { kind: 'pan', startT: { ...renderer.t } };
  }

  function startToolAction(e, s) {
    const w = renderer.worldFromScreen(s.x, s.y);
    if (e.pointerType === 'mouse' && (e.button === 1 || spaceHeld)) { startPan(); return; }
    switch (tool) {
      case 'pen':
      case 'high':
        startStroke(e, w); break;
      case 'eraser':
        action = { kind: 'erase', removed: [], cursor: w, pid: e.pointerId };
        eraseAt(w);
        startLiveLoop();
        break;
      case 'select':
        startSelect(e, w, s); break;
      case 'text':
        action = { kind: 'textTap', start: w, moved: false, pid: e.pointerId, startT: { ...renderer.t } };
        break;
      case 'hand':
        startPan(); break;
    }
  }

  function startStroke(e, w) {
    const isHigh = tool === 'high';
    const pressureOn = S.get('input.pressure');
    const item = {
      id: U.uid(), type: 'stroke', tool: isHigh ? 'high' : 'pen',
      color: isHigh ? S.get('ink.highColor') : S.get('ink.penColor'),
      size: isHigh ? S.get('ink.highSize') : S.get('ink.penSize'),
      pressure: (!isHigh && pressureOn) ? S.get('input.pressureAmount') : 0,
      points: []
    };
    if (isHigh) item.opacity = S.get('ink.highOpacity');
    const smoother = Ink.createSmoother(S.get('input.smoothing'));
    const first = smoother.push({ x: w.x, y: w.y, p: normPressure(e) });
    item.points.push(first);
    action = {
      kind: 'draw', item, smoother, pid: e.pointerId, byTouch: e.pointerType === 'touch',
      t0: performance.now(), lastMoveT: performance.now(), lastPt: first,
      predicted: [], snapped: null, snapCheckAt: 0
    };
    startLiveLoop();
  }

  function normPressure(e) {
    if (e.pointerType === 'pen' && e.pressure > 0) return e.pressure;
    return 0.5;
  }

  function startSelect(e, w, s) {
    if (selection && selection.bbox) {
      const hIdx = hitHandle(s);
      if (hIdx >= 0) {
        const bb = selection.bbox;
        const hp = handlePositions(bb);
        const anchor = hp[(hIdx + 2) % 4];
        action = {
          kind: 'scaleSel', anchor, startW: w, f: 1, pid: e.pointerId,
          startDist: Math.max(4, U.dist(w.x, w.y, anchor.x, anchor.y))
        };
        prepareSelectionDragRender();
        startLiveLoop();
        return;
      }
      if (U.bboxContains(selection.bbox, w.x, w.y)) {
        action = { kind: 'moveSel', start: w, dx: 0, dy: 0, pid: e.pointerId, started: false };
        return;
      }
    }
    // Anywhere else: drag = lasso; tap (resolved on pointerup) = pick the item under it.
    setSelection(null);
    action = { kind: 'lasso', poly: [w], pid: e.pointerId };
    startLiveLoop();
  }

  function hitHandle(s) {
    if (!selection || !selection.bbox) return -1;
    const hp = handlePositions(selection.bbox);
    for (let i = 0; i < 4; i++) {
      const p = renderer.screenFromWorld(hp[i].x, hp[i].y);
      if (U.dist(p.x, p.y, s.x, s.y) < 16) return i;
    }
    return -1;
  }

  function hitTestItem(w) {
    const t = renderer.t;
    for (let i = note.items.length - 1; i >= 0; i--) {
      const it = note.items[i];
      const bb = BN.itemBBox(it);
      if (it.type === 'text' || it.type === 'image') {
        if (U.bboxContains(bb, w.x, w.y)) return it;
        continue;
      }
      const pad = Math.max(8 / t.s, it.size);
      if (!U.bboxContains({ x: bb.x - pad, y: bb.y - pad, w: bb.w + pad * 2, h: bb.h + pad * 2 }, w.x, w.y)) continue;
      const hitR = Math.max(6 / t.s, it.size / 2 + 3 / t.s);
      const pts = it.points;
      if (pts.length === 1) {
        if (U.dist(pts[0].x, pts[0].y, w.x, w.y) < hitR) return it;
        continue;
      }
      for (let j = 1; j < pts.length; j++) {
        if (U.pointSegDist(w.x, w.y, pts[j - 1].x, pts[j - 1].y, pts[j].x, pts[j].y) < hitR) return it;
      }
    }
    return null;
  }

  function prepareSelectionDragRender() {
    // Static layer without the selection; selection is drawn on the live layer.
    renderer.render(note, { skip: new Set(selection.ids), noCache: true });
  }

  function onMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const s = localXY(e);
    const prev = { x: p.x, y: p.y };
    p.x = s.x; p.y = s.y;
    if (touchTap) touchTap.moved += U.dist(prev.x, prev.y, s.x, s.y);
    if (!action) return;
    e.preventDefault();

    switch (action.kind) {
      case 'draw': {
        if (e.pointerId !== action.pid) return;
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        const t = renderer.t;
        for (const ev of evs) {
          const l = localXY(ev);
          const w = renderer.worldFromScreen(l.x, l.y);
          const pt = action.smoother.push({ x: w.x, y: w.y, p: normPressure(ev) });
          const lp = action.lastPt;
          if (U.dist(pt.x, pt.y, lp.x, lp.y) * t.s >= 1.1) {
            action.item.points.push(pt);
            action.lastPt = pt;
            if (U.dist(pt.x, pt.y, lp.x, lp.y) * t.s > 2.5) {
              action.lastMoveT = performance.now();
              if (action.snapped) action.snapped = null; // resumed drawing
            }
          }
        }
        action.predicted = [];
        if (S.get('input.prediction') && e.getPredictedEvents) {
          for (const ev of e.getPredictedEvents().slice(0, 4)) {
            const l = localXY(ev);
            action.predicted.push(renderer.worldFromScreen(l.x, l.y));
          }
        }
        break;
      }
      case 'erase': {
        if (e.pointerId !== action.pid) return;
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of evs) {
          const l = localXY(ev);
          const w = renderer.worldFromScreen(l.x, l.y);
          action.cursor = w;
          eraseAt(w);
        }
        break;
      }
      case 'lasso': {
        if (e.pointerId !== action.pid) return;
        const w = renderer.worldFromScreen(s.x, s.y);
        const last = action.poly[action.poly.length - 1];
        if (U.dist(w.x, w.y, last.x, last.y) * renderer.t.s > 3) action.poly.push(w);
        break;
      }
      case 'moveSel': {
        if (e.pointerId !== action.pid) return;
        const w = renderer.worldFromScreen(s.x, s.y);
        action.dx = w.x - action.start.x;
        action.dy = w.y - action.start.y;
        if (!action.started && U.dist(0, 0, action.dx, action.dy) * renderer.t.s > 3) {
          action.started = true;
          prepareSelectionDragRender();
          setTextDragOffset(0, 0);
          startLiveLoop();
        }
        if (action.started) setTextDragOffset(action.dx, action.dy);
        break;
      }
      case 'scaleSel': {
        if (e.pointerId !== action.pid) return;
        const w = renderer.worldFromScreen(s.x, s.y);
        action.f = U.clamp(U.dist(w.x, w.y, action.anchor.x, action.anchor.y) / action.startDist, 0.05, 20);
        setTextScale(action.anchor, action.f);
        break;
      }
      case 'textTap': {
        const w = renderer.worldFromScreen(s.x, s.y);
        if (U.dist(w.x, w.y, action.start.x, action.start.y) * renderer.t.s > 8) {
          action = { kind: 'pan', startT: action.startT };
        }
        break;
      }
      case 'pan': {
        const t = renderer.t;
        t.x = action.startT.x + (p.x - p.sx);
        t.y = action.startT.y + (p.y - p.sy);
        clampT(t);
        gestureFrame();
        break;
      }
      case 'pinch': {
        const a = pointers.get(action.ids[0]), b = pointers.get(action.ids[1]);
        if (!a || !b) return;
        const dist = Math.max(12, U.dist(a.x, a.y, b.x, b.y));
        const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const s0 = action.startT;
        const ns = U.clamp(s0.s * (dist / action.startDist), MIN_S, MAX_S);
        const wc = { x: (action.startCenter.x - s0.x) / s0.s, y: (action.startCenter.y - s0.y) / s0.s };
        renderer.t = { s: ns, x: center.x - wc.x * ns, y: center.y - wc.y * ns };
        clampT(renderer.t);
        gestureFrame();
        break;
      }
    }
  }

  const gestureFrame = U.rafThrottle(() => {
    if (!note) return;
    renderer.blit();
    renderer.renderLive(drawOverlays);
    updateTextLayerTransform();
    positionSelActions();
    sharpRender();
  });

  function setTextDragOffset(dx, dy) {
    if (!selection) return;
    for (const id of selection.ids) {
      const div = el.textLayer.querySelector(`[data-id="${id}"]`);
      if (div) div.style.translate = `${dx}px ${dy}px`;
    }
  }
  function setTextScale(anchor, f) {
    if (!selection) return;
    for (const id of selection.ids) {
      const it = byId(id);
      const div = el.textLayer.querySelector(`[data-id="${id}"]`);
      if (div && it) {
        const nx = anchor.x + (it.x - anchor.x) * f;
        const ny = anchor.y + (it.y - anchor.y) * f;
        div.style.translate = `${nx - it.x}px ${ny - it.y}px`;
        div.style.transform = `scale(${f})`;
        div.style.transformOrigin = '0 0';
      }
    }
  }
  function clearTextTempTransforms() {
    for (const div of el.textLayer.querySelectorAll('.bn-text')) {
      div.style.translate = '';
      div.style.transform = '';
    }
  }

  function eraseAt(w) {
    const r = (S.get('ink.eraserSize') / 2) / renderer.t.s;
    let removedAny = false;
    for (let i = note.items.length - 1; i >= 0; i--) {
      const it = note.items[i];
      if (it.type !== 'stroke') continue;
      const bb = BN.itemBBox(it);
      if (!U.bboxContains({ x: bb.x - r, y: bb.y - r, w: bb.w + 2 * r, h: bb.h + 2 * r }, w.x, w.y)) continue;
      const hitR = r + it.size / 2;
      let hit = false;
      const pts = it.points;
      if (pts.length === 1) hit = U.dist(pts[0].x, pts[0].y, w.x, w.y) < hitR;
      for (let j = 1; !hit && j < pts.length; j++) {
        hit = U.pointSegDist(w.x, w.y, pts[j - 1].x, pts[j - 1].y, pts[j].x, pts[j].y) < hitR;
      }
      if (hit) {
        action.removed.push({ item: it, index: i });
        note.items.splice(i, 1);
        removedAny = true;
      }
    }
    if (removedAny) eraseRerender();
  }
  const eraseRerender = U.rafThrottle(() => { if (note) renderer.render(note); });

  function onUp(e) {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (!p) return;

    // Two-finger tap → undo.
    if (touchTap && p.type === 'touch') {
      const quick = performance.now() - touchTap.t0 < 300 && touchTap.moved < 14;
      if (touchPointers().length === 0) {
        const tapInfo = touchTap;
        touchTap = null;
        if (quick && tapInfo && S.get('input.twoFingerUndo') && action && action.kind === 'pinch') {
          action = null;
          doUndo();
          return;
        }
      } else if (!quick) {
        touchTap = null;
      }
    }

    if (!action) return;
    switch (action.kind) {
      case 'draw':
        if (e.pointerId !== action.pid) return;
        finishStroke();
        break;
      case 'erase': {
        if (e.pointerId !== action.pid) return;
        const a = action; action = null;
        if (a.removed.length) pushOp(opRemove(a.removed.slice().sort((x, y) => x.index - y.index)));
        renderAll();
        break;
      }
      case 'lasso': {
        if (e.pointerId !== action.pid) return;
        const a = action; action = null;
        finishLasso(a);
        break;
      }
      case 'moveSel': {
        if (e.pointerId !== action.pid) return;
        const a = action; action = null;
        clearTextTempTransforms();
        if (a.started && (a.dx || a.dy)) {
          translateItems(selection.ids, a.dx, a.dy);
          pushOp(opMove(selection.ids.slice(), a.dx, a.dy));
          updateSelectionBBox();
          rebuildTextLayer();
        }
        renderAll();
        break;
      }
      case 'scaleSel': {
        if (e.pointerId !== action.pid) return;
        const a = action; action = null;
        clearTextTempTransforms();
        if (Math.abs(a.f - 1) > 0.01) {
          scaleItems(selection.ids, a.f, a.anchor.x, a.anchor.y);
          pushOp(opScale(selection.ids.slice(), a.f, a.anchor.x, a.anchor.y));
          updateSelectionBBox();
          rebuildTextLayer();
        }
        renderAll();
        break;
      }
      case 'textTap': {
        const a = action; action = null;
        const hitText = hitTestItem(a.start);
        if (hitText && hitText.type === 'text') {
          const div = el.textLayer.querySelector(`[data-id="${hitText.id}"]`);
          if (div) div.focus();
        } else {
          createTextAt(a.start);
        }
        break;
      }
      case 'pan':
        action = null;
        note.view = { ...renderer.t };
        sharpRender();
        break;
      case 'pinch':
        if (touchPointers().length < 2) {
          action = null;
          note.view = { ...renderer.t };
          sharpRender();
        }
        break;
    }
  }

  function onCancel(e) {
    pointers.delete(e.pointerId);
    if (action && action.pid === e.pointerId) {
      if (action.kind === 'erase' && action.removed.length) {
        pushOp(opRemove(action.removed.slice().sort((x, y) => x.index - y.index)));
      }
      action = null;
      clearTextTempTransforms();
      renderAll();
    } else if (action && (action.kind === 'pinch' || action.kind === 'pan') && touchPointers().length === 0) {
      action = null;
      sharpRender();
    }
    touchTap = null;
  }

  function finishStroke() {
    const a = action;
    action = null;
    const item = a.item;
    if (a.snapped) {
      item.points = a.snapped;
    } else {
      item.points = Ink.finalizePoints(item.points, S.get('input.smoothing'));
    }
    delete item._bb;
    if (item.points.length === 0) { renderer.renderLive(drawOverlays); return; }
    note.items.push(item);
    pushOp(opAdd([item]));
    renderAll();
  }

  function finishLasso(a) {
    const t = renderer.t;
    if (U.pathLength(a.poly) * t.s < 12) {
      const hit = hitTestItem(a.poly[0]);
      setSelection(hit ? [hit.id] : null);
      renderer.renderLive(drawOverlays);
      return;
    }
    const poly = a.poly;
    const ids = [];
    for (const it of note.items) {
      if (it.type === 'stroke') {
        const step = Math.max(1, Math.floor(it.points.length / 40));
        for (let i = 0; i < it.points.length; i += step) {
          if (U.polygonContains(poly, it.points[i].x, it.points[i].y)) { ids.push(it.id); break; }
        }
      } else {
        const bb = BN.itemBBox(it);
        const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
        if (U.polygonContains(poly, cx, cy)) ids.push(it.id);
      }
    }
    setSelection(ids);
    if (!ids.length) app.toast('Nothing inside the lasso');
  }

  /* ---- live rAF loop (runs only while an action needs per-frame drawing) ---- */

  let liveRunning = false;
  function startLiveLoop() {
    if (liveRunning) return;
    liveRunning = true;
    requestAnimationFrame(liveFrame);
  }
  function liveFrame() {
    if (!note || !action || !['draw', 'erase', 'lasso', 'moveSel', 'scaleSel'].includes(action.kind)) {
      liveRunning = false;
      if (note) { renderer.renderLive(drawOverlays); positionSelActions(); }
      return;
    }
    checkShapeSnap();
    renderer.renderLive((ctx) => {
      const t = renderer.t;
      if (action.kind === 'draw') {
        const item = action.item;
        const pts = action.snapped || item.points;
        if (item.tool === 'high') {
          ctx.globalAlpha = item.opacity ?? 0.35;
          ctx.strokeStyle = item.color;
          ctx.lineWidth = item.size;
          ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.stroke(Ink.centerlinePath(pts));
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = item.color;
          ctx.fill(Ink.outlinePath(pts, item.size, item.pressure));
          if (!action.snapped && action.predicted.length) {
            const lp = item.points[item.points.length - 1];
            ctx.strokeStyle = item.color;
            ctx.lineWidth = Ink.widthAt(lp.p, item.size, item.pressure);
            ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(lp.x, lp.y);
            for (const q of action.predicted) ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
        }
      } else if (action.kind === 'erase') {
        ctx.strokeStyle = 'rgba(128,128,140,0.9)';
        ctx.lineWidth = 1.2 / t.s;
        ctx.beginPath();
        ctx.arc(action.cursor.x, action.cursor.y, (S.get('ink.eraserSize') / 2) / t.s, 0, Math.PI * 2);
        ctx.stroke();
      } else if (action.kind === 'lasso') {
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4f7cff';
        ctx.strokeStyle = accent;
        ctx.fillStyle = accent + '22';
        ctx.lineWidth = 1.5 / t.s;
        ctx.setLineDash([7 / t.s, 5 / t.s]);
        ctx.beginPath();
        ctx.moveTo(action.poly[0].x, action.poly[0].y);
        for (const q of action.poly) ctx.lineTo(q.x, q.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (action.kind === 'moveSel' && action.started) {
        ctx.save();
        ctx.translate(action.dx, action.dy);
        for (const it of selectedItems()) {
          if (it.type === 'text') continue; // DOM moves it live
          renderer.drawItem(ctx, it);
        }
        ctx.restore();
        drawOverlays(ctx);
      } else if (action.kind === 'scaleSel') {
        ctx.save();
        ctx.translate(action.anchor.x, action.anchor.y);
        ctx.scale(action.f, action.f);
        ctx.translate(-action.anchor.x, -action.anchor.y);
        for (const it of selectedItems()) {
          if (it.type === 'text') continue;
          renderer.drawItem(ctx, it);
        }
        if (selection && selection.bbox) {
          const bb = selection.bbox;
          const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4f7cff';
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.5 / (t.s * action.f);
          ctx.setLineDash([6 / (t.s * action.f), 5 / (t.s * action.f)]);
          ctx.strokeRect(bb.x, bb.y, bb.w, bb.h);
        }
        ctx.restore();
      }
      if (action.kind === 'moveSel') positionSelActions();
    });
    requestAnimationFrame(liveFrame);
  }

  function checkShapeSnap() {
    if (!action || action.kind !== 'draw' || action.snapped) return;
    if (!S.get('input.shapeSnap')) return;
    const now = performance.now();
    if (now - action.lastMoveT < S.get('input.shapeSnapDelay')) return;
    if (now - action.snapCheckAt < 180) return;
    action.snapCheckAt = now;
    if (U.pathLength(action.item.points) < 30) return;
    const snapped = Ink.detectShape(action.item.points);
    if (snapped) action.snapped = snapped;
  }

  /* =================== wheel & keyboard =================== */

  let spaceHeld = false;

  function onWheel(e) {
    if (!note) return;
    e.preventDefault();
    const t = renderer.t;
    if (e.ctrlKey || e.metaKey) {
      const s = localXY(e);
      const w = renderer.worldFromScreen(s.x, s.y);
      const ns = U.clamp(t.s * Math.exp(-e.deltaY * 0.01), MIN_S, MAX_S);
      renderer.t = { s: ns, x: s.x - w.x * ns, y: s.y - w.y * ns };
    } else {
      t.x -= e.deltaX;
      t.y -= e.deltaY;
    }
    clampT(renderer.t);
    gestureFrame();
  }

  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!note) return;
      const inField = document.activeElement && (document.activeElement.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName));
      if (e.key === ' ') { if (!inField) { spaceHeld = true; e.preventDefault(); } return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        if (inField) return;
        e.preventDefault();
        e.shiftKey ? doRedo() : doUndo();
        return;
      }
      if (inField) {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }
      if (e.key === 'Escape') { setSelection(null); closePopover(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection) { e.preventDefault(); deleteSelection(); return; }
      const map = { p: 'pen', h: 'high', e: 'eraser', s: 'select', t: 'text', g: 'hand' };
      if (map[e.key.toLowerCase()] && !e.metaKey && !e.ctrlKey) setTool(map[e.key.toLowerCase()]);
    });
    document.addEventListener('keyup', (e) => { if (e.key === ' ') spaceHeld = false; });
  }

  /* =================== toolbar & popovers =================== */

  function setTool(name) {
    tool = name;
    el.wrap.dataset.tool = name;
    for (const b of el.tools.querySelectorAll('[data-tool]')) {
      b.classList.toggle('active', b.dataset.tool === name);
    }
    if (name !== 'select') setSelection(null);
  }
  Editor.setTool = setTool;

  function bindToolbar() {
    document.getElementById('ed-back').addEventListener('click', () => app.showHome());
    el.title.addEventListener('change', () => {
      note.title = el.title.value.trim() || 'Untitled note';
      el.title.value = note.title;
      markDirty();
    });
    el.undo.addEventListener('click', doUndo);
    el.redo.addEventListener('click', doRedo);

    for (const b of el.tools.querySelectorAll('[data-tool]')) {
      b.addEventListener('click', () => {
        if (tool === b.dataset.tool && ['pen', 'high', 'eraser'].includes(tool)) {
          openToolOptions(b);
        } else {
          setTool(b.dataset.tool);
        }
      });
    }
    document.getElementById('ed-image').addEventListener('click', () => el.imgInput.click());
    el.imgInput.addEventListener('change', () => {
      for (const f of el.imgInput.files) insertImageBlob(f);
      el.imgInput.value = '';
    });
    document.getElementById('ed-paper').addEventListener('click', (e) => openPaperOptions(e.currentTarget));
    document.getElementById('ed-export').addEventListener('click', (e) => openExportMenu(e.currentTarget));
    document.getElementById('ed-settings').addEventListener('click', () => app.openSettings());

    // selection actions
    document.getElementById('sel-tidy').addEventListener('click', tidySelection);
    document.getElementById('sel-color').addEventListener('click', (e) => openSelectionColor(e.currentTarget));
    document.getElementById('sel-dup').addEventListener('click', duplicateSelection);
    document.getElementById('sel-del').addEventListener('click', deleteSelection);
    updateToolIndicators();
  }

  function updateToolIndicators() {
    const penDot = document.querySelector('[data-tool=pen] .dot');
    const highDot = document.querySelector('[data-tool=high] .dot');
    if (penDot) penDot.style.background = S.get('ink.penColor');
    if (highDot) highDot.style.background = S.get('ink.highColor');
  }

  /* ---- generic popover ---- */

  let popEl = null;
  function openPopover(anchor, build) {
    closePopover();
    popEl = document.createElement('div');
    popEl.className = 'popover';
    build(popEl);
    document.body.appendChild(popEl);
    const ar = anchor.getBoundingClientRect();
    const pw = popEl.offsetWidth, vh = window.innerHeight, vw = window.innerWidth;
    let x = U.clamp(ar.left + ar.width / 2 - pw / 2, 8, vw - pw - 8);
    let y = ar.bottom + 8;
    if (y + popEl.offsetHeight > vh - 8) y = Math.max(8, ar.top - popEl.offsetHeight - 8);
    popEl.style.left = x + 'px';
    popEl.style.top = y + 'px';
    setTimeout(() => {
      document.addEventListener('pointerdown', popoverOutside, { capture: true });
    }, 0);
  }
  function popoverOutside(e) {
    if (popEl && !popEl.contains(e.target)) closePopover();
  }
  function closePopover() {
    if (!popEl) return;
    popEl.remove();
    popEl = null;
    document.removeEventListener('pointerdown', popoverOutside, { capture: true });
  }
  Editor.closePopover = closePopover;

  function swatchRow(colors, current, onPick) {
    const row = document.createElement('div');
    row.className = 'swatches';
    for (const c of colors) {
      const b = document.createElement('button');
      b.className = 'swatch' + (c.toLowerCase() === (current || '').toLowerCase() ? ' active' : '');
      b.style.background = c;
      b.addEventListener('click', () => { onPick(c); for (const s of row.children) s.classList.toggle('active', s === b); });
      row.appendChild(b);
    }
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.value = /^#([0-9a-f]{6})$/i.test(current || '') ? current : '#333333';
    custom.className = 'swatch custom';
    custom.addEventListener('input', () => onPick(custom.value));
    row.appendChild(custom);
    return row;
  }

  function sliderRow(label, min, max, step, val, onInput) {
    const row = document.createElement('div');
    row.className = 'pop-slider';
    const l = document.createElement('span'); l.textContent = label;
    const input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = val;
    input.addEventListener('input', () => onInput(+input.value));
    row.appendChild(l); row.appendChild(input);
    return row;
  }

  function openToolOptions(anchor) {
    openPopover(anchor, (pop) => {
      if (tool === 'pen') {
        pop.appendChild(swatchRow(PRESETS, S.get('ink.penColor'), (c) => { S.set('ink.penColor', c); }));
        pop.appendChild(sliderRow('Size', 1, 14, 0.5, S.get('ink.penSize'), (v) => S.set('ink.penSize', v)));
      } else if (tool === 'high') {
        pop.appendChild(swatchRow(HIGH_PRESETS, S.get('ink.highColor'), (c) => S.set('ink.highColor', c)));
        pop.appendChild(sliderRow('Size', 6, 40, 1, S.get('ink.highSize'), (v) => S.set('ink.highSize', v)));
        pop.appendChild(sliderRow('Opacity', 0.15, 0.6, 0.05, S.get('ink.highOpacity'), (v) => S.set('ink.highOpacity', v)));
      } else if (tool === 'eraser') {
        pop.appendChild(sliderRow('Size', 6, 60, 1, S.get('ink.eraserSize'), (v) => S.set('ink.eraserSize', v)));
      }
    });
  }

  function openPaperOptions(anchor) {
    openPopover(anchor, (pop) => {
      const styles = [['lines', 'Lined'], ['grid', 'Grid'], ['dots', 'Dots'], ['blank', 'Blank']];
      const seg = document.createElement('div');
      seg.className = 'segmented';
      for (const [v, label] of styles) {
        const b = document.createElement('button');
        b.textContent = label;
        b.classList.toggle('active', note.paper.style === v);
        b.addEventListener('click', () => {
          note.paper.style = v;
          for (const s of seg.children) s.classList.toggle('active', s === b);
          paperChanged();
        });
        seg.appendChild(b);
      }
      pop.appendChild(seg);
      pop.appendChild(sliderRow('Spacing', 20, 64, 2, note.paper.spacing, (v) => { note.paper.spacing = v; paperChanged(); }));
      pop.appendChild(swatchRow(['#ffffff', '#faf3e3', '#eef4fb', '#2a2a31', '#17171c'], note.paper.color, (c) => {
        note.paper.color = c;
        paperChanged();
      }));
    });
  }
  function paperChanged() {
    renderAll();
    markDirty();
  }

  function openSelectionColor(anchor) {
    openPopover(anchor, (pop) => {
      pop.appendChild(swatchRow(PRESETS, null, (c) => recolorSelection(c)));
      const texts = selectedItems().filter((i) => i.type === 'text');
      if (texts.length) {
        pop.appendChild(sliderRow('Text size', 10, 64, 1, texts[0].size, (v) => resizeSelectedText(v)));
      }
    });
  }

  function openExportMenu(anchor) {
    openPopover(anchor, (pop) => {
      const menu = document.createElement('div');
      menu.className = 'menu';
      const add = (label, fn) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', () => { closePopover(); fn(); });
        menu.appendChild(b);
      };
      add('Share image — visible area', () => exportImage(false));
      add('Share image — whole note', () => exportImage(true));
      add('Back up this note (file)', async () => {
        await Editor.flush();
        const data = await BN.Store.exportBackup([note.id]);
        app.downloadJSON(data, sanitizeName(note.title) + '.betternotes.json');
      });
      pop.appendChild(menu);
    });
  }

  function sanitizeName(s) {
    return (s || 'note').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'note';
  }

  async function exportImage(whole) {
    try {
      commitFocusedText();
      const rect = whole
        ? { x: 0, y: 0, w: note.width, h: note.height }
        : renderer.viewWorldRect(0);
      const px = Math.min(2048, Math.max(1200, Math.round(rect.w * 2)));
      const canvas = await renderer.exportCanvas(note, rect, px);
      canvas.toBlob(async (blob) => {
        if (!blob) { app.toast('Export failed', true); return; }
        const file = new File([blob], sanitizeName(note.title) + '.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
        }
        app.downloadBlob(blob, file.name);
      }, 'image/png');
    } catch (e) {
      app.toast('Export failed', true);
    }
  }

  // Introspection for tests/console; not used by the app itself.
  Editor._debug = () => ({ note, tool, selection, actionKind: action && action.kind, actionInfo: action ? { started: action.started, dx: action.dx, dy: action.dy } : null, undoLen: undoStack.length, redoLen: redoStack.length, t: renderer && renderer.t });

  window.BN = window.BN || {};
  window.BN.Editor = Editor;
})();
