/* BetterNotes — vector PDF export, written by hand (no library). Strokes become
   filled outline paths, the highlighter a translucent blended stroke, images are
   embedded as JPEG, text is set in Helvetica. Pages are A4-proportioned slices of
   the note. Content streams are deflate-compressed when the browser can. */
(function () {
  'use strict';
  const U = BN.util;
  const Ink = BN.ink;
  const PDF = {};
  const A4 = { w: 595.28, h: 841.89 };
  const K = 0.5522847498; // Bézier circle constant

  const num = (n) => {
    const r = Math.round(n * 100) / 100;
    return Object.is(r, -0) ? '0' : String(r);
  };
  function latin1(str) {
    const b = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xff;
    return b;
  }
  // Unicode → WinAnsi (cp1252) bytes for the punctuation Helvetica can show.
  const CP1252 = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88,
    0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93,
    0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
    0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F, 0x00A0: 0x20, 0x2010: 0x2D, 0x2011: 0x2D, 0x2212: 0x2D
  };
  // Unicode → Adobe Symbol font bytes: Greek letters and maths, for lecture notes.
  const SYMBOL = (() => {
    const m = {};
    const lo = 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ', up = 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ';
    for (let i = 0; i < 26; i++) { m[lo.codePointAt(i)] = 0x61 + i; m[up.codePointAt(i)] = 0x41 + i; }
    Object.assign(m, {
      0x03F5: 0x65, 0x2206: 0x44, 0x2126: 0x57,
      0x2200: 0x22, 0x2203: 0x24, 0x220B: 0x27, 0x2217: 0x2A, 0x2245: 0x40, 0x2234: 0x5C, 0x22A5: 0x5E, 0x223C: 0x7E,
      0x2032: 0xA2, 0x2264: 0xA3, 0x2044: 0xA4, 0x221E: 0xA5, 0x2663: 0xA7, 0x2666: 0xA8, 0x2665: 0xA9, 0x2660: 0xAA,
      0x2194: 0xAB, 0x2190: 0xAC, 0x2191: 0xAD, 0x2192: 0xAE, 0x2193: 0xAF, 0x2033: 0xB2, 0x2265: 0xB3, 0x221D: 0xB5,
      0x2202: 0xB6, 0x2260: 0xB9, 0x2261: 0xBA, 0x2248: 0xBB, 0x21B5: 0xBF, 0x2135: 0xC0, 0x2111: 0xC1, 0x211C: 0xC2,
      0x2118: 0xC3, 0x2297: 0xC4, 0x2295: 0xC5, 0x2205: 0xC6, 0x2229: 0xC7, 0x222A: 0xC8, 0x2283: 0xC9, 0x2287: 0xCA,
      0x2284: 0xCB, 0x2282: 0xCC, 0x2286: 0xCD, 0x2208: 0xCE, 0x2209: 0xCF, 0x2220: 0xD0, 0x2207: 0xD1, 0x220F: 0xD5,
      0x221A: 0xD6, 0x22C5: 0xD7, 0x2227: 0xD9, 0x2228: 0xDA, 0x21D4: 0xDB, 0x21D0: 0xDC, 0x21D1: 0xDD, 0x21D2: 0xDE,
      0x21D3: 0xDF, 0x25CA: 0xE0, 0x2329: 0xE1, 0x27E8: 0xE1, 0x2211: 0xE5, 0x222B: 0xF2, 0x232A: 0xF1, 0x27E9: 0xF1
    });
    return m;
  })();
  function escapeByte(c) {
    if (c === 40 || c === 41 || c === 92) return '\\' + String.fromCharCode(c);
    if (c < 32 || c > 126) return '\\' + c.toString(8).padStart(3, '0');
    return String.fromCharCode(c);
  }
  // Splits a line into (font, literal) runs: F1 = Helvetica/WinAnsi, F2 = Symbol.
  // Characters neither base-14 font has (emoji…) are skipped — there is no font to embed.
  function textRuns(str) {
    const runs = [];
    let f = null, cur = '';
    const push = (font, c) => {
      if (font !== f) { if (cur) runs.push({ f, s: '(' + cur + ')' }); f = font; cur = ''; }
      cur += escapeByte(c);
    };
    for (const ch of String(str)) {
      let cp = ch.codePointAt(0);
      if (cp === 9) cp = 32;
      if (cp < 32) continue;
      if (cp < 0x80 || (cp >= 0xA0 && cp <= 0xFF)) push('F1', cp);
      else if (CP1252[cp] != null) push('F1', CP1252[cp]);
      else if (SYMBOL[cp] != null) push('F2', SYMBOL[cp]);
    }
    if (cur) runs.push({ f, s: '(' + cur + ')' });
    return runs;
  }
  function pdfString(str) {
    return '(' + textRuns(str).filter((r) => r.f === 'F1').map((r) => r.s.slice(1, -1)).join('') + ')';
  }
  function hexRGB(hex) {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex || '')) hex = '#000000';
    return [1, 3, 5].map((i) => num(parseInt(hex.slice(i, i + 2), 16) / 255)).join(' ');
  }
  function mixHex(a, b, t) {
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
    const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }
  function hexLum(c) {
    if (!/^#[0-9a-fA-F]{6}$/.test(c || '')) return 1;
    return (0.299 * parseInt(c.slice(1, 3), 16) + 0.587 * parseInt(c.slice(3, 5), 16) + 0.114 * parseInt(c.slice(5, 7), 16)) / 255;
  }

  async function deflate(str) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) { return null; }
  }

  // Emits path commands from Ink.outlineCommands in PDF operators, converting
  // quadratics and arcs to cubics. (x,y) are already in PDF points.
  function emitCommands(cmds, tx) {
    let out = '';
    let cur = null;
    const cubic = (c1, c2, p) => `${num(c1.x)} ${num(c1.y)} ${num(c2.x)} ${num(c2.y)} ${num(p.x)} ${num(p.y)} c\n`;
    const arcTo = (cx, cy, r, a0, a1) => {
      // Sweep clockwise in screen space (y down) == increasing angle, as canvas arc() does.
      let sweep = ((a1 - a0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      if (sweep < 1e-6) sweep = Math.PI * 2;
      const steps = Math.max(1, Math.ceil(sweep / (Math.PI / 2)));
      const da = sweep / steps;
      let a = a0;
      for (let i = 0; i < steps; i++) {
        const b = a + da;
        const kk = (4 / 3) * Math.tan(da / 4);
        const p0 = tx({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        const p3 = tx({ x: cx + r * Math.cos(b), y: cy + r * Math.sin(b) });
        const c1 = tx({ x: cx + r * (Math.cos(a) - kk * Math.sin(a)), y: cy + r * (Math.sin(a) + kk * Math.cos(a)) });
        const c2 = tx({ x: cx + r * (Math.cos(b) + kk * Math.sin(b)), y: cy + r * (Math.sin(b) - kk * Math.cos(b)) });
        if (!cur) out += `${num(p0.x)} ${num(p0.y)} m\n`;
        out += cubic(c1, c2, p3);
        cur = p3;
        a = b;
      }
    };
    for (const c of cmds) {
      if (c.t === 'M') { cur = tx(c); out += `${num(cur.x)} ${num(cur.y)} m\n`; }
      else if (c.t === 'L') { cur = tx(c); out += `${num(cur.x)} ${num(cur.y)} l\n`; }
      else if (c.t === 'Q') {
        const q = tx({ x: c.cx, y: c.cy }), p = tx(c);
        const c1 = { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) };
        const c2 = { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) };
        out += cubic(c1, c2, p);
        cur = p;
      } else if (c.t === 'A') { arcTo(c.cx, c.cy, c.r, c.a0, c.a1); }
      else if (c.t === 'C') { cur = null; arcTo(c.cx, c.cy, c.r, 0, Math.PI * 2); out += 'h\n'; }
      else if (c.t === 'Z') { out += 'h\n'; }
    }
    return out;
  }

  function centerlineOps(pts, tx) {
    if (!pts.length) return '';
    let cur = tx(pts[0]);
    let out = `${num(cur.x)} ${num(cur.y)} m\n`;
    if (pts.length === 1) return out + `${num(cur.x + 0.01)} ${num(cur.y)} l\n`;
    if (pts.length === 2) { const p = tx(pts[1]); return out + `${num(p.x)} ${num(p.y)} l\n`; }
    for (let i = 1; i < pts.length - 1; i++) {
      const q = tx(pts[i]);
      const p = tx({ x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 });
      const c1 = { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) };
      const c2 = { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) };
      out += `${num(c1.x)} ${num(c1.y)} ${num(c2.x)} ${num(c2.y)} ${num(p.x)} ${num(p.y)} c\n`;
      cur = p;
    }
    const e = tx(pts[pts.length - 1]);
    return out + `${num(e.x)} ${num(e.y)} l\n`;
  }

  function rectsIntersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // Word-wraps like the on-screen text box (Arial metrics ≈ Helvetica's).
  function wrapText(item) {
    const c = document.createElement('canvas').getContext('2d');
    c.font = `${item.size}px Helvetica, Arial, sans-serif`;
    const lines = [];
    for (const para of String(item.text || '').split('\n')) {
      if (para === '') { lines.push(''); continue; }
      let cur = '';
      for (const w of para.split(/(\s+)/)) {
        const test = cur + w;
        if (cur && c.measureText(test).width > item.w) { lines.push(cur); cur = w.trimStart(); }
        else cur = test;
      }
      if (cur) lines.push(cur);
    }
    return lines;
  }

  function paperOps(note, rect, X, Y, k, infinite) {
    const paper = note.paper.color || '#ffffff';
    let out = `${hexRGB(paper)} rg 0 0 ${num(A4.w)} ${num(A4.h)} re f\n`;
    const style = note.paper.style || 'blank';
    if (style === 'blank') return out;
    const lum = hexLum(paper);
    const rule = mixHex(paper, lum > 0.5 ? '#4069b4' : '#ffffff', lum > 0.5 ? 0.22 : 0.18);
    const strong = mixHex(paper, lum > 0.5 ? '#4069b4' : '#ffffff', lum > 0.5 ? 0.45 : 0.4);
    const spacing = style === 'music' ? 9 : (note.paper.spacing || 32);
    const xa = rect.x, xb = rect.x + rect.w, ya = rect.y, yb = rect.y + rect.h;
    let x0 = Math.floor(xa / spacing) * spacing, y0 = Math.floor(ya / spacing) * spacing;
    if (!infinite) { x0 = Math.max(x0, spacing); y0 = Math.max(y0, spacing); }
    out += `${hexRGB(rule)} RG ${num(0.75)} w\n`;
    const hline = (y) => `${num(X(xa))} ${num(Y(y))} m ${num(X(xb))} ${num(Y(y))} l S\n`;
    const vline = (x) => `${num(X(x))} ${num(Y(ya))} m ${num(X(x))} ${num(Y(yb))} l S\n`;
    if (['lines', 'grid', 'cornell', 'college'].includes(style)) {
      for (let y = y0; y <= yb; y += spacing) out += hline(y);
    }
    if (style === 'grid') for (let x = x0; x <= xb; x += spacing) out += vline(x);
    if (style === 'dots') {
      out += `${hexRGB(rule)} rg\n`;
      const r = 1.4 * k;
      for (let y = y0; y <= yb; y += spacing) {
        for (let x = x0; x <= xb; x += spacing) {
          const px = X(x), py = Y(y);
          out += `${num(px - r)} ${num(py)} m ${num(px - r)} ${num(py + K * r)} ${num(px - K * r)} ${num(py + r)} ${num(px)} ${num(py + r)} c ` +
            `${num(px + K * r)} ${num(py + r)} ${num(px + r)} ${num(py + K * r)} ${num(px + r)} ${num(py)} c ` +
            `${num(px + r)} ${num(py - K * r)} ${num(px + K * r)} ${num(py - r)} ${num(px)} ${num(py - r)} c ` +
            `${num(px - K * r)} ${num(py - r)} ${num(px - r)} ${num(py - K * r)} ${num(px - r)} ${num(py)} c f\n`;
        }
      }
    }
    if (style === 'music') {
      for (let g = Math.floor(ya / 90) * 90; g <= yb; g += 90) for (let i = 0; i < 5; i++) out += hline(g + i * 9);
    }
    if (style === 'cornell') {
      const cueX = (infinite ? 800 : note.width) * 0.3;
      out += `${hexRGB(strong)} RG ${num(1.5 * k)} w ${vline(cueX)}`;
      if (!infinite) out += hline(note.height * 0.8);
    }
    if (style === 'college') {
      const mx = infinite ? 120 : note.width * 0.12;
      out += `${hexRGB(mixHex(paper, '#dc5050', 0.5))} RG ${num(1.2 * k)} w ${vline(mx)}`;
    }
    return out;
  }

  async function imageJPEG(item, renderer) {
    let entry = renderer.ensureImage(item);
    if (!entry || !entry.ready) {
      if (!item.blob) return null;
      try { const bmp = await createImageBitmap(item.blob); entry = { ready: true, bmp }; } catch (e) { return null; }
    }
    const b = entry.bmp;
    const crop = item.crop || { x: 0, y: 0, w: b.width, h: b.height };
    const scale = Math.min(1, 1600 / Math.max(crop.w, crop.h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(crop.w * scale));
    c.height = Math.max(1, Math.round(crop.h * scale));
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(b, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
    const dataURL = c.toDataURL('image/jpeg', 0.85);
    const bin = atob(dataURL.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, w: c.width, h: c.height };
  }

  // Builds the PDF. Returns a Blob.
  PDF.exportNote = async function (note, renderer, opts) {
    opts = opts || {};
    const infinite = (note.paper.layout || 'page') === 'infinite';
    let area;
    if (infinite) {
      let bb = null;
      for (const it of note.items) bb = U.unionBBox(bb, BN.itemBBox(it));
      bb = bb || { x: 0, y: 0, w: 800, h: 1100 };
      area = { x: bb.x - 40, y: bb.y - 40, w: Math.max(bb.w + 80, 800), h: bb.h + 80 };
    } else {
      area = { x: 0, y: 0, w: note.width, h: note.height };
    }
    const k = A4.w / area.w;
    const pageH = A4.h / k;
    const pageCount = Math.max(1, Math.min(60, Math.ceil(area.h / pageH)));
    const paperLum = hexLum(note.paper.color || '#ffffff');
    const inkColor = (c) => (BN.inkColorFor ? BN.inkColorFor(c, paperLum) : c);
    const taper = !BN.Settings || BN.Settings.get('input.taper') !== false;
    const hiBlend = paperLum > 0.5 ? 'Multiply' : 'Lighten';

    const objs = [null, null, null, null]; // 1 catalog, 2 pages, 3+4 fonts — filled at the end
    const add = (parts) => { objs.push(parts); return objs.length; };
    const gsObjs = new Map(); // opacity → object number
    const gsFor = (alpha) => {
      const key = num(alpha);
      if (!gsObjs.has(key)) gsObjs.set(key, add([`<< /Type /ExtGState /ca ${key} /CA ${key} /BM /${hiBlend} >>`]));
      return gsObjs.get(key);
    };
    const pageObjNums = [];

    for (let pi = 0; pi < pageCount; pi++) {
      const rect = { x: area.x, y: area.y + pi * pageH, w: area.w, h: pageH };
      const X = (x) => (x - rect.x) * k;
      const Y = (y) => A4.h - (y - rect.y) * k;
      const tx = (p) => ({ x: X(p.x), y: Y(p.y) });
      let content = paperOps(note, rect, X, Y, k, infinite);
      const xobjects = [];
      const gsUsed = new Set();

      for (const item of note.items) {
        if (!rectsIntersect(BN.itemBBox(item), rect)) continue;
        if (item.type === 'image') {
          const img = await imageJPEG(item, renderer);
          if (!img) continue;
          const n = add([
            `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`,
            img.bytes, '\nendstream'
          ]);
          xobjects.push(n);
          content += `q ${num(item.w * k)} 0 0 ${num(item.h * k)} ${num(X(item.x))} ${num(Y(item.y + item.h))} cm /Im${n} Do Q\n`;
        } else if (item.type === 'stroke') {
          if (item.tool === 'high') {
            const alpha = item.opacity == null ? 0.35 : item.opacity;
            const gs = gsFor(alpha);
            gsUsed.add(gs);
            content += `q /GS${gs} gs ${hexRGB(item.color)} RG ${num(item.size * k)} w 1 J 1 j\n${centerlineOps(item.points, tx)}S Q\n`;
          } else {
            const cmds = Ink.outlineCommands(item.points, item.size, item.pressure == null ? 0.65 : item.pressure, { taper: taper && !item.snap });
            content += `${hexRGB(inkColor(item.color))} rg\n${emitCommands(cmds, tx)}f\n`;
          }
        }
      }
      for (const item of note.items) {
        if (item.type !== 'text' || !rectsIntersect(BN.itemBBox(item), rect)) continue;
        const lines = wrapText(item);
        const fs = item.size * k;
        const lineH = item.size * 1.35;
        content += `BT ${hexRGB(inkColor(item.color || '#1d1d2e'))} rg\n`;
        lines.forEach((ln, i) => {
          const runs = textRuns(ln);
          if (!runs.length) return;
          content += `1 0 0 1 ${num(X(item.x))} ${num(Y(item.y + item.size * 1.08 + i * lineH))} Tm`;
          for (const r of runs) content += ` /${r.f} ${num(fs)} Tf ${r.s} Tj`;
          content += '\n';
        });
        content += 'ET\n';
      }

      const packed = await deflate(content);
      const streamObj = packed
        ? add([`<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`, packed, '\nendstream'])
        : add([`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
      const res = `/Font << /F1 3 0 R /F2 4 0 R >>` +
        (gsUsed.size ? ` /ExtGState << ${[...gsUsed].map((n) => `/GS${n} ${n} 0 R`).join(' ')} >>` : '') +
        (xobjects.length ? ` /XObject << ${xobjects.map((n) => `/Im${n} ${n} 0 R`).join(' ')} >>` : '');
      pageObjNums.push(add([`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(A4.w)} ${num(A4.h)}] /Resources << ${res} >> /Contents ${streamObj} 0 R >>`]));
    }

    objs[0] = ['<< /Type /Catalog /Pages 2 0 R >>'];
    objs[1] = [`<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageObjNums.length} >>`];
    objs[2] = ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
    objs[3] = ['<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>'];
    const infoObj = add([`<< /Title ${pdfString(note.title || 'Note')} /Producer (BetterNotes) >>`]);

    // Serialize with a byte-accurate cross-reference table.
    const chunks = [];
    let pos = 0;
    const write = (part) => {
      const bytes = typeof part === 'string' ? latin1(part) : part;
      chunks.push(bytes);
      pos += bytes.length;
    };
    write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const offsets = [];
    objs.forEach((parts, i) => {
      offsets.push(pos);
      write(`${i + 1} 0 obj\n`);
      for (const p of parts) write(p);
      write('\nendobj\n');
    });
    const xref = pos;
    write(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`);
    for (const o of offsets) write(String(o).padStart(10, '0') + ' 00000 n \n');
    write(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return { blob: new Blob(chunks, { type: 'application/pdf' }), pages: pageCount };
  };

  window.BN = window.BN || {};
  window.BN.PDF = PDF;
})();
