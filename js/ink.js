/* BetterNotes — ink engine: stroke stabilization, variable-width (pressure)
   stroke outlines, "tidy" beautification, and hold-to-snap shape detection.
   All geometry is in world units. */
(function () {
  'use strict';
  const U = BN.util;
  const Ink = {};

  /* ---------------- stabilizer ----------------
     Two stages. 1) A dead zone: the tip only moves once the pointer leaves a small
     radius, so hand tremor inside it never reaches the page; a sharp reversal of
     direction is treated as a deliberate cusp and drawn out fully instead of being
     rounded off. 2) Velocity-weighted averaging: recent samples are averaged with
     weights that fall off with the distance travelled since them, so slow careful
     writing is smoothed hard while fast confident strokes stay responsive.
     amount 0..1; ropeWorld = dead-zone radius (world units); pxPerWorld = zoom. */
  Ink.createSmoother = function (amount, ropeWorld, pxPerWorld) {
    const a = U.clamp(amount, 0, 1);
    const rope = Math.max(0, ropeWorld || 0);
    const k = pxPerWorld || 1;
    const sigma = a <= 0.02 ? 0 : 0.35 + 1.9 * a; // screen px per ms
    const twoSigma2 = 2 * sigma * sigma;
    const buf = [];                               // newest first {x,y,p,v}
    let lastPainted = null, lastLive = null, liveDir = null, lastT = 0;

    function average() {
      let sx = 0, sy = 0, sp = 0, sw = 0, sv = 0, i = 0;
      for (; i < buf.length; i++) {
        const w = Math.exp(-(sv * sv) / twoSigma2);
        if (w < 0.01) break;
        sx += w * buf[i].x; sy += w * buf[i].y; sp += w * buf[i].p; sw += w;
        sv += buf[i].v;
      }
      buf.length = Math.max(1, Math.min(buf.length, i));
      return { x: sx / sw, y: sy / sw, p: sp / sw };
    }
    function reset(ev, t) { buf.length = 0; buf.push({ x: ev.x, y: ev.y, p: ev.p, v: 0 }); lastT = t; }
    function emit(ev, t) {
      if (sigma === 0) { lastPainted = { x: ev.x, y: ev.y, p: ev.p }; lastT = t; return [{ ...lastPainted }]; }
      const prev = buf[0];
      const v = prev ? (Math.hypot(ev.x - prev.x, ev.y - prev.y) * k) / Math.max(1, t - lastT) : 0;
      buf.unshift({ x: ev.x, y: ev.y, p: ev.p, v });
      lastT = t;
      lastPainted = average();
      return [{ ...lastPainted }];
    }

    return {
      // Feeds one raw input point; returns 0, 1 or 2 output points.
      push(pt) {
        const t = pt.t != null ? pt.t : performance.now();
        const p = pt.p == null ? 0.5 : pt.p;
        if (!lastPainted) {
          lastPainted = { x: pt.x, y: pt.y, p };
          lastLive = { x: pt.x, y: pt.y, p };
          reset(lastPainted, t);
          return [{ ...lastPainted }];
        }
        const mx = pt.x - lastPainted.x, my = pt.y - lastPainted.y;
        const d = Math.hypot(mx, my);
        if (rope > 0 && d <= rope) {
          lastLive = { x: pt.x, y: pt.y, p };
          reset(lastPainted, t);
          return [];
        }
        if (rope > 0 && liveDir && (mx * liveDir.x + my * liveDir.y) < 0) {
          // Direction reversed by more than 90°: a cusp. Draw out to its tip, then back.
          const tip = { x: lastLive.x, y: lastLive.y, p: lastLive.p };
          const dx = pt.x - tip.x, dy = pt.y - tip.y;
          const dn = Math.hypot(dx, dy) || 1;
          const c = Math.min(1, rope / dn);
          liveDir = { x: dx * c, y: dy * c };
          const back = { x: pt.x - liveDir.x, y: pt.y - liveDir.y, p: c * tip.p + (1 - c) * p };
          lastPainted = back;
          lastLive = { x: pt.x, y: pt.y, p };
          reset(back, t);
          return [tip, { ...back }];
        }
        lastLive = { x: pt.x, y: pt.y, p };
        liveDir = { x: mx, y: my };
        const ratio = rope > 0 ? rope / d : 0;
        return emit({ x: pt.x - ratio * mx, y: pt.y - ratio * my, p }, t);
      },
      live() { return lastLive ? { ...lastLive } : null; },
      last() { return lastPainted ? { ...lastPainted } : null; }
    };
  };

  // Final pass when a stroke ends: drop redundant points, optionally round corners.
  Ink.finalizePoints = function (pts, smoothing) {
    if (pts.length < 3) return pts.slice();
    let out = U.rdp(pts, 0.35);
    if (smoothing > 0.55 && out.length > 3) out = U.chaikin(out);
    if (smoothing >= 0.8 && out.length > 3) out = U.chaikin(out);
    return out;
  };

  /* ---------------- pressure → width ---------------- */

  Ink.widthAt = function (p, size, pressureAmount) {
    const pr = (p == null || p === 0) ? 0.5 : p;
    const f = 1 + (pr - 0.5) * 2 * U.clamp(pressureAmount, 0, 1);
    return Math.max(0.3, size * f);
  };

  /* ---------------- stroke geometry ---------------- */

  // Centerline path through midpoints (smooth quadratic) — highlighter & previews.
  Ink.centerlinePath = function (pts) {
    const path = new Path2D();
    if (!pts.length) return path;
    path.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 1) { path.lineTo(pts[0].x + 0.01, pts[0].y); return path; }
    if (pts.length === 2) { path.lineTo(pts[1].x, pts[1].y); return path; }
    for (let i = 1; i < pts.length - 1; i++) {
      path.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
    }
    path.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    return path;
  };

  // The variable-width outline as drawing commands, shared by the canvas renderer
  // and the PDF writer: {t:'M'|'L'} with x,y; {t:'Q'} with cx,cy,x,y; {t:'A'} arc with
  // cx,cy,r,a0,a1 (clockwise in screen coords); {t:'C'} full circle cx,cy,r; {t:'Z'}.
  Ink.outlineCommands = function (ptsIn, size, pressureAmount, opts) {
    let pts = ptsIn;
    if (!pts.length) return [];
    if (pts.length === 1) {
      const r = Math.max(Ink.widthAt(pts[0].p, size, pressureAmount) / 2, 0.3);
      return [{ t: 'C', cx: pts[0].x, cy: pts[0].y, r }];
    }
    let n = pts.length;
    let arc = new Array(n);
    arc[0] = 0;
    let maxSeg = 0;
    for (let i = 1; i < n; i++) {
      const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      arc[i] = arc[i - 1] + seg;
      if (seg > maxSeg) maxSeg = seg;
    }
    let total = arc[n - 1];
    let taperLen = 0;
    if (opts && opts.taper && total > size * 1.5) {
      taperLen = U.clamp(total * 0.22, size * 0.8, size * 3.2);
      // Taper is evaluated per vertex: sparse strokes need interior points or the
      // whole segment inherits the tip width.
      if (maxSeg > taperLen / 2) {
        pts = U.resample(pts, Math.max(1.5, taperLen / 3));
        n = pts.length;
        arc = new Array(n);
        arc[0] = 0;
        for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        total = arc[n - 1];
      }
    }
    const radii = new Array(n);
    for (let i = 0; i < n; i++) {
      let r = Ink.widthAt(pts[i].p, size, pressureAmount) / 2;
      if (taperLen) {
        const a = Math.min(1, arc[i] / taperLen);
        const b = Math.min(1, (total - arc[i]) / taperLen);
        const f = Math.min(a * (2 - a), 1 - Math.pow(1 - b, 3));
        r *= 0.12 + 0.88 * f;
      }
      radii[i] = Math.max(r, 0.15);
    }
    const left = [], right = [];
    let prevA = null;
    for (let i = 0; i < n; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(n - 1, i + 1)];
      let dx = p1.x - p0.x, dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) {
        if (prevA == null) { dx = 1; dy = 0; } else { dx = Math.cos(prevA); dy = Math.sin(prevA); }
      } else { dx /= len; dy /= len; }
      prevA = Math.atan2(dy, dx);
      const r = radii[i];
      left.push({ x: pts[i].x - dy * r, y: pts[i].y + dx * r });
      right.push({ x: pts[i].x + dy * r, y: pts[i].y - dx * r });
    }
    const cmds = [{ t: 'M', x: left[0].x, y: left[0].y }];
    for (let i = 1; i < n; i++) {
      cmds.push({ t: 'Q', cx: left[i - 1].x, cy: left[i - 1].y, x: (left[i - 1].x + left[i].x) / 2, y: (left[i - 1].y + left[i].y) / 2 });
    }
    cmds.push({ t: 'L', x: left[n - 1].x, y: left[n - 1].y });
    cmds.push(capArc(pts[n - 1], left[n - 1], right[n - 1], radii[n - 1]));
    for (let i = n - 2; i >= 0; i--) {
      cmds.push({ t: 'Q', cx: right[i + 1].x, cy: right[i + 1].y, x: (right[i + 1].x + right[i].x) / 2, y: (right[i + 1].y + right[i].y) / 2 });
    }
    cmds.push({ t: 'L', x: right[0].x, y: right[0].y });
    cmds.push(capArc(pts[0], right[0], left[0], radii[0]));
    cmds.push({ t: 'Z' });
    return cmds;
  };

  function capArc(center, from, to, r) {
    return {
      t: 'A', cx: center.x, cy: center.y, r: Math.max(r, 0.2),
      a0: Math.atan2(from.y - center.y, from.x - center.x),
      a1: Math.atan2(to.y - center.y, to.x - center.x)
    };
  }

  // Variable-width outline polygon for pressure ink. Returns a closed Path2D.
  Ink.outlinePath = function (pts, size, pressureAmount, opts) {
    const path = new Path2D();
    for (const c of Ink.outlineCommands(pts, size, pressureAmount, opts)) {
      if (c.t === 'M') path.moveTo(c.x, c.y);
      else if (c.t === 'L') path.lineTo(c.x, c.y);
      else if (c.t === 'Q') path.quadraticCurveTo(c.cx, c.cy, c.x, c.y);
      else if (c.t === 'A') path.arc(c.cx, c.cy, c.r, c.a0, c.a1, false);
      else if (c.t === 'C') path.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
      else if (c.t === 'Z') path.closePath();
    }
    return path;
  };

  /* ---------------- tidy (beautify messy ink) ---------------- */

  Ink.tidyPoints = function (pts, strength) {
    if (pts.length < 3) return pts.slice();
    const s = U.clamp(strength, 0, 1);
    const len = U.pathLength(pts);
    let out = U.resample(pts, Math.max(1.5, len / 220));
    const passes = s < 0.34 ? 1 : s < 0.67 ? 2 : 3;
    for (let i = 0; i < passes; i++) out = U.chaikin(out);
    let mean = 0;
    for (const p of out) mean += (p.p ?? 0.5);
    mean /= out.length;
    const kk = 0.35 + 0.5 * s;
    for (const p of out) p.p = (p.p ?? 0.5) + (mean - (p.p ?? 0.5)) * kk;
    return U.rdp(out, 0.3);
  };

  /* ---------------- shape detection (hold to snap) ---------------- */

  // Returns replacement centerline points (constant pressure) or null.
  Ink.detectShape = function (ptsIn) {
    if (ptsIn.length < 3) return null;
    const pts = U.resample(ptsIn, Math.max(2, U.pathLength(ptsIn) / 96));
    if (pts.length < 6) return null;
    const len = U.pathLength(pts);
    if (len < 24) return null;
    const first = pts[0], last = pts[pts.length - 1];
    const gap = U.dist(first.x, first.y, last.x, last.y);
    const closed = gap < Math.max(18, len * 0.16);

    if (!closed) {
      let maxD = 0;
      for (const p of pts) maxD = Math.max(maxD, U.pointSegDist(p.x, p.y, first.x, first.y, last.x, last.y));
      if (maxD < Math.max(6, len * 0.05)) return snapLine(first, last);
      return null;
    }

    const bb = U.bboxOfPoints(pts, 0);
    if (bb.w < 12 || bb.h < 12) return null;
    const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
    const rx = bb.w / 2, ry = bb.h / 2;
    let devSum = 0;
    for (const p of pts) devSum += Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1);
    const ellipseErr = devSum / pts.length;

    const simplified = U.rdp(pts, Math.max(6, len * 0.035));
    const corners = dedupeClosePoints(simplified, Math.max(10, len * 0.05));

    if (ellipseErr < 0.18 && corners.length > 5) return snapEllipse(cx, cy, rx, ry);
    if (corners.length === 4 || corners.length === 5) {
      const quad = corners.slice(0, 4);
      if (isRectangular(quad)) return snapRect(bb);
      return snapPolygon(quad);
    }
    if (corners.length === 3) return snapPolygon(corners.slice(0, 3));
    if (ellipseErr < 0.24) return snapEllipse(cx, cy, rx, ry);
    return null;
  };

  // A deliberately straight-looking stroke (long, barely bowed) → perfect line,
  // without any hold. Returns points or null.
  Ink.autoStraighten = function (pts, size) {
    if (pts.length < 2) return null;
    const first = pts[0], last = pts[pts.length - 1];
    const chord = U.dist(first.x, first.y, last.x, last.y);
    if (chord < Math.max(40, size * 8)) return null;
    const len = U.pathLength(pts);
    if (len > chord * 1.06) return null; // wandering path, not a line
    let maxD = 0;
    for (const p of pts) maxD = Math.max(maxD, U.pointSegDist(p.x, p.y, first.x, first.y, last.x, last.y));
    if (maxD > Math.max(2, chord * 0.02)) return null;
    return snapLine(first, last);
  };

  function dedupeClosePoints(pts, minGap) {
    const out = [];
    for (const p of pts) {
      if (!out.length || U.dist(out[out.length - 1].x, out[out.length - 1].y, p.x, p.y) > minGap) out.push(p);
    }
    if (out.length > 2 && U.dist(out[0].x, out[0].y, out[out.length - 1].x, out[out.length - 1].y) <= minGap) out.pop();
    return out;
  }

  function isRectangular(quad) {
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
      const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
      const dot = (v1x * v2x + v1y * v2y) / ((Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y)) || 1);
      if (Math.abs(dot) > 0.5) return false;
    }
    return true;
  }

  function line(a, b, stepCount) {
    const out = [];
    for (let i = 0; i <= stepCount; i++) {
      const t = i / stepCount;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: 0.5 });
    }
    return out;
  }

  // Lines snap to the nearest 15° when within 5° of it (so hand-drawn axes,
  // diagonals and isometric lines come out exact).
  function snapLine(a, b) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const step = Math.PI / 12;
    const snapped = Math.round(ang / step) * step;
    let bx = b.x, by = b.y;
    if (Math.abs(snapped - ang) < (5 * Math.PI) / 180) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      bx = a.x + Math.cos(snapped) * len;
      by = a.y + Math.sin(snapped) * len;
      if (Math.abs(Math.sin(snapped)) < 1e-9) by = a.y;
      if (Math.abs(Math.cos(snapped)) < 1e-9) bx = a.x;
    }
    return line(a, { x: bx, y: by }, 24);
  }

  function snapRect(bb) {
    const a = { x: bb.x, y: bb.y }, b = { x: bb.x + bb.w, y: bb.y },
      c = { x: bb.x + bb.w, y: bb.y + bb.h }, d = { x: bb.x, y: bb.y + bb.h };
    return [...line(a, b, 12), ...line(b, c, 12), ...line(c, d, 12), ...line(d, a, 12)];
  }

  function snapPolygon(corners) {
    const out = [];
    for (let i = 0; i < corners.length; i++) out.push(...line(corners[i], corners[(i + 1) % corners.length], 14));
    return out;
  }

  function snapEllipse(cx, cy, rx, ry) {
    const out = [];
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2 - Math.PI / 2;
      out.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry, p: 0.5 });
    }
    return out;
  }

  window.BN = window.BN || {};
  window.BN.ink = Ink;
})();
