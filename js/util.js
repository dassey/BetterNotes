/* BetterNotes — small shared utilities. Everything lives under the BN namespace
   (classic scripts, so the app also runs from file:// with no build step). */
(function () {
  'use strict';
  const U = {};

  U.uid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);

  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  U.dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

  // Distance from point (px,py) to segment (ax,ay)-(bx,by).
  U.pointSegDist = function (px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = U.clamp(t, 0, 1);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  U.pathLength = function (pts) {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += U.dist(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
    return l;
  };

  // Ramer–Douglas–Peucker simplification on {x,y,...} points (keeps extra fields).
  U.rdp = function (pts, eps) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = 0, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = U.pointSegDist(pts[i].x, pts[i].y, pts[a].x, pts[a].y, pts[b].x, pts[b].y);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
    return out;
  };

  // One pass of Chaikin corner cutting; preserves endpoints and pressure.
  U.chaikin = function (pts) {
    if (pts.length < 3) return pts.slice();
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push(
        { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, p: (a.p ?? 0.5) * 0.75 + (b.p ?? 0.5) * 0.25 },
        { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75, p: (a.p ?? 0.5) * 0.25 + (b.p ?? 0.5) * 0.75 }
      );
    }
    out.push(pts[pts.length - 1]);
    return out;
  };

  // Resample a polyline at roughly equal arc-length steps.
  U.resample = function (pts, step) {
    if (pts.length < 2) return pts.slice();
    const out = [pts[0]];
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      let a = out[out.length - 1].x === undefined ? pts[i - 1] : pts[i - 1];
      let prev = pts[i - 1], cur = pts[i];
      let segLen = U.dist(prev.x, prev.y, cur.x, cur.y);
      let d = carry;
      while (d + step <= segLen + carry) {
        d += step;
        const t = U.clamp((d - carry) / (segLen || 1), 0, 1);
        out.push({
          x: prev.x + (cur.x - prev.x) * t,
          y: prev.y + (cur.y - prev.y) * t,
          p: (prev.p ?? 0.5) + ((cur.p ?? 0.5) - (prev.p ?? 0.5)) * t
        });
      }
      carry = segLen + carry - d;
    }
    const last = pts[pts.length - 1];
    const tail = out[out.length - 1];
    if (U.dist(tail.x, tail.y, last.x, last.y) > step * 0.25) out.push({ ...last });
    return out;
  };

  U.polygonContains = function (poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  U.bboxOfPoints = function (pts, pad) {
    pad = pad || 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
    }
    return { x: x0 - pad, y: y0 - pad, w: (x1 - x0) + pad * 2, h: (y1 - y0) + pad * 2 };
  };

  U.unionBBox = function (a, b) {
    if (!a) return b; if (!b) return a;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  };

  U.bboxContains = (bb, x, y) => x >= bb.x && x <= bb.x + bb.w && y >= bb.y && y <= bb.y + bb.h;

  U.debounce = function (fn, ms) {
    let t = null;
    const wrapped = function (...args) {
      clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
    };
    wrapped.flush = function (...args) { clearTimeout(t); t = null; fn.apply(this, args); };
    wrapped.cancel = function () { clearTimeout(t); t = null; };
    return wrapped;
  };

  U.rafThrottle = function (fn) {
    let scheduled = false;
    return function (...args) {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; fn.apply(this, args); });
    };
  };

  U.deepClone = (obj) => (typeof structuredClone === 'function' ? structuredClone(obj) : JSON.parse(JSON.stringify(obj)));

  U.relativeTime = function (ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 7 * 86400) return Math.floor(s / 86400) + ' d ago';
    return new Date(ts).toLocaleDateString();
  };

  U.blobToDataURL = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });

  U.dataURLToBlob = async function (url) {
    const res = await fetch(url);
    return res.blob();
  };

  U.formatBytes = function (n) {
    if (!Number.isFinite(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i];
  };

  U.escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  window.BN = window.BN || {};
  window.BN.util = U;
})();
