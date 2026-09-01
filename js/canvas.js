/* BetterNotes — renderer. Two stacked canvases: a static layer with the note's
   settled content (re-rendered only on change) and a live layer for the stroke
   in progress, selection overlays and cursors. During pan/zoom gestures the
   static layer is blitted from a cached bitmap and re-rendered sharp on rest. */
(function () {
  'use strict';
  const U = BN.util;
  const Ink = BN.ink;

  function Renderer(container, inkCanvas, liveCanvas) {
    this.container = container;
    this.ink = inkCanvas;
    this.live = liveCanvas;
    this.ictx = inkCanvas.getContext('2d', { desynchronized: true });
    this.lctx = liveCanvas.getContext('2d', { desynchronized: true });
    this.t = { x: 0, y: 0, s: 1 };
    this.dpr = 1;
    this.w = 0; this.h = 0;
    this.cache = document.createElement('canvas');
    this.cacheT = null;
    this.images = new Map(); // item.id → ImageBitmap|HTMLImageElement
    this.resize();
  }

  Renderer.prototype.resize = function () {
    const r = this.container.getBoundingClientRect();
    this.dpr = U.clamp(window.devicePixelRatio || 1, 1, 3);
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    for (const c of [this.ink, this.live]) {
      c.width = Math.round(this.w * this.dpr);
      c.height = Math.round(this.h * this.dpr);
      c.style.width = this.w + 'px';
      c.style.height = this.h + 'px';
    }
  };

  /* ---------------- transform helpers ---------------- */

  Renderer.prototype.worldFromScreen = function (sx, sy) {
    return { x: (sx - this.t.x) / this.t.s, y: (sy - this.t.y) / this.t.s };
  };
  Renderer.prototype.screenFromWorld = function (wx, wy) {
    return { x: wx * this.t.s + this.t.x, y: wy * this.t.s + this.t.y };
  };
  Renderer.prototype.viewWorldRect = function (pad) {
    pad = pad || 0;
    const a = this.worldFromScreen(-pad, -pad);
    const b = this.worldFromScreen(this.w + pad, this.h + pad);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  };

  function applyWorldTransform(ctx, t, dpr) {
    ctx.setTransform(t.s * dpr, 0, 0, t.s * dpr, t.x * dpr, t.y * dpr);
  }

  /* ---------------- item helpers ---------------- */

  function strokeBBox(item) {
    if (!item._bb) {
      item._bb = U.bboxOfPoints(item.points, item.size);
    }
    return item._bb;
  }

  BN.itemBBox = function (item) {
    if (item.type === 'stroke') return strokeBBox(item);
    return { x: item.x, y: item.y, w: item.w, h: item.h || item.size * 1.5 };
  };

  function rectsIntersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  Renderer.prototype.ensureImage = function (item) {
    if (this.images.has(item.id)) return this.images.get(item.id);
    if (!item.blob) return null;
    const entry = { ready: false, bmp: null };
    this.images.set(item.id, entry);
    createImageBitmap(item.blob).then((bmp) => {
      entry.bmp = bmp; entry.ready = true;
      document.dispatchEvent(new CustomEvent('bn:image-ready'));
    }).catch(() => { });
    return entry;
  };

  /* ---------------- drawing ---------------- */

  Renderer.prototype.drawPaper = function (ctx, note, viewRect) {
    const styles = getComputedStyle(document.documentElement);
    const infinite = (note.paper.layout || 'page') === 'infinite';
    const paperColor = note.paper.color || '#ffffff';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = infinite ? paperColor : (styles.getPropertyValue('--canvas-outside').trim() || '#e6e6ec');
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();

    let bounds;
    if (infinite) {
      bounds = viewRect;
    } else {
      const page = { x: 0, y: 0, w: note.width, h: note.height };
      ctx.save();
      ctx.shadowColor = 'rgba(20,20,40,0.25)';
      ctx.shadowBlur = 14;
      ctx.fillStyle = paperColor;
      ctx.fillRect(page.x, page.y, page.w, page.h);
      ctx.restore();
      bounds = page;
    }

    const style = note.paper.style || 'blank';
    if (style === 'blank') return;
    const spacing = note.paper.spacing || 32;
    // Skip rules that would be sub-pixel mush (dots earlier: unbounded grids get big).
    if (spacing * this.t.s < (style === 'dots' ? 6 : 3)) return;
    // Rule color adapts to paper lightness.
    const rgb = [parseInt(paperColor.slice(1, 3), 16), parseInt(paperColor.slice(3, 5), 16), parseInt(paperColor.slice(5, 7), 16)];
    const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    const rule = lum > 0.5 ? 'rgba(64,105,180,0.20)' : 'rgba(255,255,255,0.16)';
    ctx.save();
    if (!infinite) {
      ctx.beginPath();
      ctx.rect(bounds.x, bounds.y, bounds.w, bounds.h);
      ctx.clip();
    }
    ctx.strokeStyle = rule;
    ctx.fillStyle = rule;
    ctx.lineWidth = 1 / this.t.s;

    const xa = Math.max(bounds.x, viewRect.x), xb = Math.min(bounds.x + bounds.w, viewRect.x + viewRect.w);
    const ya = Math.max(bounds.y, viewRect.y), yb = Math.min(bounds.y + bounds.h, viewRect.y + viewRect.h);
    let x0 = Math.floor(xa / spacing) * spacing;
    let y0 = Math.floor(ya / spacing) * spacing;
    if (!infinite) { x0 = Math.max(x0, spacing); y0 = Math.max(y0, spacing); }

    if (style === 'lines' || style === 'grid') {
      ctx.beginPath();
      for (let y = y0; y <= yb; y += spacing) { ctx.moveTo(xa, y); ctx.lineTo(xb, y); }
      ctx.stroke();
    }
    if (style === 'grid') {
      ctx.beginPath();
      for (let x = x0; x <= xb; x += spacing) { ctx.moveTo(x, ya); ctx.lineTo(x, yb); }
      ctx.stroke();
    }
    if (style === 'dots') {
      const r = 1.4;
      ctx.beginPath();
      for (let y = y0; y <= yb; y += spacing) {
        for (let x = x0; x <= xb; x += spacing) {
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
    ctx.restore();
  };

  Renderer.prototype.drawItem = function (ctx, item, opts) {
    opts = opts || {};
    if (item.type === 'stroke') {
      if (item.tool === 'high') {
        ctx.save();
        ctx.globalAlpha = item.opacity ?? 0.35;
        ctx.strokeStyle = item.color;
        ctx.lineWidth = item.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke(Ink.centerlinePath(item.points));
        ctx.restore();
      } else {
        ctx.fillStyle = item.color;
        const taper = BN.Settings && BN.Settings.get('input.taper') !== false && !item.snap;
        ctx.fill(Ink.outlinePath(item.points, item.size, item.pressure ?? 0.65, { taper }));
      }
    } else if (item.type === 'image') {
      const entry = this.ensureImage(item);
      if (entry && entry.ready) {
        if (item.crop) {
          const b = entry.bmp;
          const cx = U.clamp(item.crop.x, 0, b.width - 1);
          const cy = U.clamp(item.crop.y, 0, b.height - 1);
          const cw = U.clamp(item.crop.w, 1, b.width - cx);
          const ch = U.clamp(item.crop.h, 1, b.height - cy);
          ctx.drawImage(b, cx, cy, cw, ch, item.x, item.y, item.w, item.h);
        } else {
          ctx.drawImage(entry.bmp, item.x, item.y, item.w, item.h);
        }
      } else {
        ctx.save();
        ctx.fillStyle = 'rgba(128,128,128,0.15)';
        ctx.fillRect(item.x, item.y, item.w, item.h);
        ctx.restore();
      }
    } else if (item.type === 'text' && opts.drawText) {
      drawTextItem(ctx, item);
    }
  };

  function drawTextItem(ctx, item) {
    ctx.save();
    ctx.fillStyle = item.color || '#1d1d2e';
    ctx.font = `400 ${item.size}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = 'alphabetic';
    const lineH = item.size * 1.35;
    let y = item.y + item.size * 1.08;
    const paragraphs = String(item.text || '').split('\n');
    for (const para of paragraphs) {
      if (para === '') { y += lineH; continue; }
      const words = para.split(/(\s+)/);
      let lineTxt = '';
      for (const w of words) {
        const test = lineTxt + w;
        if (lineTxt && ctx.measureText(test).width > item.w) {
          ctx.fillText(lineTxt, item.x, y);
          y += lineH;
          lineTxt = w.trimStart();
        } else {
          lineTxt = test;
        }
      }
      if (lineTxt) { ctx.fillText(lineTxt, item.x, y); y += lineH; }
    }
    ctx.restore();
  }
  Renderer.drawTextItem = drawTextItem;

  // Full sharp render of the static layer. opts.skip: Set of item ids to omit
  // (used while dragging a selection, which is drawn on the live layer).
  Renderer.prototype.render = function (note, opts) {
    opts = opts || {};
    const ctx = this.ictx;
    applyWorldTransform(ctx, this.t, this.dpr);
    const view = this.viewWorldRect(40);
    this.drawPaper(ctx, note, view);
    for (const item of note.items) {
      if (opts.skip && opts.skip.has(item.id)) continue;
      if (item.type === 'text') continue; // text lives in the DOM layer
      if (!rectsIntersect(BN.itemBBox(item), view)) continue;
      this.drawItem(ctx, item);
    }
    if (!opts.noCache) {
      if (this.cache.width !== this.ink.width || this.cache.height !== this.ink.height) {
        this.cache.width = this.ink.width;
        this.cache.height = this.ink.height;
      }
      const cctx = this.cache.getContext('2d');
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.clearRect(0, 0, this.cache.width, this.cache.height);
      cctx.drawImage(this.ink, 0, 0);
      this.cacheT = { ...this.t };
    }
  };

  // Fast path during pan/zoom: reproject the cached bitmap.
  Renderer.prototype.blit = function () {
    if (!this.cacheT) return this.renderPending && this.renderPending();
    const ctx = this.ictx;
    const k = this.t.s / this.cacheT.s;
    const ox = this.t.x - this.cacheT.x * k;
    const oy = this.t.y - this.cacheT.y * k;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const styles = getComputedStyle(document.documentElement);
    ctx.fillStyle = styles.getPropertyValue('--canvas-outside').trim() || '#e6e6ec';
    ctx.fillRect(0, 0, this.ink.width, this.ink.height);
    ctx.setTransform(k, 0, 0, k, ox * this.dpr, oy * this.dpr);
    ctx.drawImage(this.cache, 0, 0);
  };

  // Live layer: clears, applies world transform, hands the ctx to a callback.
  Renderer.prototype.renderLive = function (fn) {
    const ctx = this.lctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    if (!fn) return;
    applyWorldTransform(ctx, this.t, this.dpr);
    fn(ctx, this);
  };

  /* ---------------- export & thumbnails ---------------- */

  // Renders a world-rect of the note (including text) into a new canvas.
  Renderer.prototype.exportCanvas = async function (note, rect, pixelWidth) {
    const scale = pixelWidth / rect.w;
    const cw = Math.round(rect.w * scale);
    const ch = Math.min(16384, Math.round(rect.h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, -rect.x * scale, -rect.y * scale);
    ctx.fillStyle = note.paper.color || '#ffffff';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    const savedT = this.t;
    this.t = { x: -rect.x * scale, y: -rect.y * scale, s: scale };
    this.drawPaper(ctx, note, rect);
    this.t = savedT;
    // drawPaper's outside fill covered the full canvas; repaint page area only.
    // (Outside area is only visible if rect extends past the page.)
    for (const item of note.items) {
      if (item.type === 'text') continue;
      if (!rectsIntersect(BN.itemBBox(item), rect)) continue;
      // Wait for images so exports aren't missing pictures.
      if (item.type === 'image') {
        const entry = this.ensureImage(item);
        if (entry && !entry.ready && item.blob) {
          try { entry.bmp = await createImageBitmap(item.blob); entry.ready = true; } catch (e) { }
        }
      }
      this.drawItem(ctx, item);
    }
    // Text floats above ink on screen (DOM layer), so it exports above too.
    for (const item of note.items) {
      if (item.type !== 'text' || !rectsIntersect(BN.itemBBox(item), rect)) continue;
      this.drawItem(ctx, item, { drawText: true });
    }
    return canvas;
  };

  Renderer.prototype.thumbnail = async function (note) {
    let rect;
    if ((note.paper.layout || 'page') === 'infinite') {
      let bb = null;
      for (const it of note.items) bb = U.unionBBox(bb, BN.itemBBox(it));
      if (bb) {
        const w = Math.max(bb.w + 48, 320);
        rect = { x: bb.x - 24, y: bb.y - 24, w, h: Math.max(160, Math.min(bb.h + 48, w * 1.3)) };
      } else {
        rect = { x: 0, y: 0, w: 800, h: 1000 };
      }
    } else {
      rect = { x: 0, y: 0, w: note.width, h: Math.min(note.height, note.width * 1.25) };
    }
    const canvas = await this.exportCanvas(note, rect, 260);
    try { return canvas.toDataURL('image/jpeg', 0.8); } catch (e) { return null; }
  };

  window.BN = window.BN || {};
  window.BN.Renderer = Renderer;
})();
