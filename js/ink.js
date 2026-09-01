/* BetterNotes — ink engine: input smoothing, variable-width (pressure) stroke
   outlines, "tidy" beautification, and hold-to-snap shape detection.
   All geometry is in world units. */
(function () {
  'use strict';
  const U = BN.util;
  const Ink = {};

  /* ---------------- input smoothing (incremental EMA) ---------------- */

  // Creates a stateful stabilizer; amount 0..1 (0 = raw, 1 = very steady).
  // Two layers: a pull-string dead zone (`ropeWorld` radius, world units) — the pen
  // tip only moves once the pointer leaves it, so hand tremor inside it vanishes —
  // plus an exponential smoothing pass for rounding.
  Ink.createSmoother = function (amount, ropeWorld) {
    const alpha = 1 - 0.8 * U.clamp(amount, 0, 1);
    const rope = Math.max(0, ropeWorld || 0);
    let last = null;
    return {
      push(pt) {
        if (!last) { last = { x: pt.x, y: pt.y, p: pt.p }; return { ...last }; }
        let tx = pt.x, ty = pt.y;
        if (rope > 0) {
          const dx = pt.x - last.x, dy = pt.y - last.y;
          const d = Math.hypot(dx, dy);
          if (d <= rope) {
            tx = last.x; ty = last.y;
          } else {
            const k = (d - rope) / d;
            tx = last.x + dx * k;
            ty = last.y + dy * k;
          }
        }
        last = {
          x: last.x + (tx - last.x) * alpha,
          y: last.y + (ty - last.y) * alpha,
          p: last.p + (pt.p - last.p) * Math.min(1, alpha + 0.25)
        };
        return { ...last };
      },
      reset() { last = null; }
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
    // Neutral width at pressure 0.5; pressureAmount scales how much pressure matters.
    const f = 1 + (pr - 0.5) * 2 * U.clamp(pressureAmount, 0, 1);
    return Math.max(0.3, size * f);
  };

  /* ---------------- stroke rendering paths ---------------- */

  // Centerline path through midpoints (smooth quadratic) — used for
  // highlighter (constant width) and hit previews.
  Ink.centerlinePath = function (pts) {
    const path = new Path2D();
    if (!pts.length) return path;
    path.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 1) { path.lineTo(pts[0].x + 0.01, pts[0].y); return path; }
    if (pts.length === 2) { path.lineTo(pts[1].x, pts[1].y); return path; }
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      path.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    path.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    return path;
  };

  // Variable-width outline polygon for pressure ink. Returns a closed Path2D.
  // opts.taper thins the stroke toward both ends for a natural pen lift.
  Ink.outlinePath = function (pts, size, pressureAmount, opts) {
    const path = new Path2D();
    if (!pts.length) return path;
    if (pts.length === 1) {
      const r = Ink.widthAt(pts[0].p, size, pressureAmount) / 2;
      path.arc(pts[0].x, pts[0].y, Math.max(r, 0.3), 0, Math.PI * 2);
      return path;
    }
    const n = pts.length;
    const arc = new Array(n);
    arc[0] = 0;
    for (let i = 1; i < n; i++) {
      arc[i] = arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    const total = arc[n - 1];
    let taperLen = 0;
    if (opts && opts.taper && total > size * 1.5) {
      taperLen = U.clamp(total * 0.22, size * 0.8, size * 3.2);
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
    const startR = radii[0];
    const endR = radii[n - 1];
    path.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < n; i++) {
      const mx = (left[i - 1].x + left[i].x) / 2, my = (left[i - 1].y + left[i].y) / 2;
      path.quadraticCurveTo(left[i - 1].x, left[i - 1].y, mx, my);
    }
    path.lineTo(left[n - 1].x, left[n - 1].y);
    // end cap
    capArc(path, pts[n - 1], left[n - 1], right[n - 1], endR);
    for (let i = n - 2; i >= 0; i--) {
      const mx = (right[i + 1].x + right[i].x) / 2, my = (right[i + 1].y + right[i].y) / 2;
      path.quadraticCurveTo(right[i + 1].x, right[i + 1].y, mx, my);
    }
    path.lineTo(right[0].x, right[0].y);
    capArc(path, pts[0], right[0], left[0], startR);
    path.closePath();
    return path;
  };

  function capArc(path, center, from, to, r) {
    const a0 = Math.atan2(from.y - center.y, from.x - center.x);
    const a1 = Math.atan2(to.y - center.y, to.x - center.x);
    path.arc(center.x, center.y, Math.max(r, 0.2), a0, a1, false);
  }

  /* ---------------- tidy (beautify messy ink) ---------------- */

  Ink.tidyPoints = function (pts, strength) {
    if (pts.length < 3) return pts.slice();
    const s = U.clamp(strength, 0, 1);
    const len = U.pathLength(pts);
    let out = U.resample(pts, Math.max(1.5, len / 220));
    const passes = s < 0.34 ? 1 : s < 0.67 ? 2 : 3;
    for (let i = 0; i < passes; i++) out = U.chaikin(out);
    // Even out pressure so width variation calms down.
    let mean = 0;
    for (const p of out) mean += (p.p ?? 0.5);
    mean /= out.length;
    const k = 0.35 + 0.5 * s;
    for (const p of out) p.p = (p.p ?? 0.5) + (mean - (p.p ?? 0.5)) * k;
    return U.rdp(out, 0.3);
  };

  /* ---------------- shape detection (hold to snap) ---------------- */

  // Returns replacement centerline points (constant pressure) or null.
  Ink.detectShape = function (ptsIn) {
    if (ptsIn.length < 8) return null;
    const pts = U.resample(ptsIn, Math.max(2, U.pathLength(ptsIn) / 96));
    if (pts.length < 6) return null;
    const len = U.pathLength(pts);
    if (len < 24) return null;
    const first = pts[0], last = pts[pts.length - 1];
    const gap = U.dist(first.x, first.y, last.x, last.y);
    const closed = gap < Math.max(18, len * 0.16);

    if (!closed) {
      // Straight line? max deviation from the chord.
      let maxD = 0;
      for (const p of pts) maxD = Math.max(maxD, U.pointSegDist(p.x, p.y, first.x, first.y, last.x, last.y));
      if (maxD < Math.max(5, len * 0.045)) {
        return snapLine(first, last);
      }
      return null;
    }

    const bb = U.bboxOfPoints(pts, 0);
    if (bb.w < 12 || bb.h < 12) return null;
    const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;

    // Ellipse fit: radial distance (normalized by bbox radii) should be ~1.
    const rx = bb.w / 2, ry = bb.h / 2;
    let devSum = 0;
    for (const p of pts) {
      const d = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
      devSum += Math.abs(d - 1);
    }
    const ellipseErr = devSum / pts.length;

    // Polygon fit via aggressive simplification.
    const simplified = U.rdp(pts, Math.max(6, len * 0.035));
    const corners = dedupeClosePoints(simplified, Math.max(10, len * 0.05));

    if (ellipseErr < 0.16 && corners.length > 5) return snapEllipse(cx, cy, rx, ry);
    if (corners.length === 4 || corners.length === 5) {
      const quad = corners.slice(0, 4);
      if (isRectangular(quad)) return snapRect(bb);
      return snapPolygon(quad);
    }
    if (corners.length === 3) return snapPolygon(corners.slice(0, 3));
    if (ellipseErr < 0.22) return snapEllipse(cx, cy, rx, ry);
    return null;
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
      if (Math.abs(dot) > 0.42) return false; // > ~65° off right angle
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

  function snapLine(a, b) {
    // Snap near-horizontal / near-vertical to exact.
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const deg = (ang * 180) / Math.PI;
    let bx = b.x, by = b.y;
    const near = (v, t) => Math.abs(((v % 180) + 180) % 180 - t) < 6 || Math.abs(((v % 180) + 180) % 180 - (t + 180)) < 6;
    if (near(deg, 0) || near(deg, 180)) by = a.y;
    else if (near(deg, 90)) bx = a.x;
    return line(a, { x: bx, y: by }, 24);
  }

  function snapRect(bb) {
    const a = { x: bb.x, y: bb.y }, b = { x: bb.x + bb.w, y: bb.y },
      c = { x: bb.x + bb.w, y: bb.y + bb.h }, d = { x: bb.x, y: bb.y + bb.h };
    return [...line(a, b, 12), ...line(b, c, 12), ...line(c, d, 12), ...line(d, a, 12)];
  }

  function snapPolygon(corners) {
    const out = [];
    for (let i = 0; i < corners.length; i++) {
      out.push(...line(corners[i], corners[(i + 1) % corners.length], 14));
    }
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
