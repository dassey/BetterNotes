/* BetterNotes — Recall. Highlights become flashcards: while studying, every
   highlighter mark hides what it covers; tap to reveal, say whether you knew it,
   and a Leitner schedule brings the card back just before it would be forgotten.
   Pure data helpers — the editor draws the covers, the home screen shows what is due. */
(function () {
  'use strict';
  const U = BN.util;
  const R = {};

  // Days until the next review after each correct answer, by box (1 → 1 day … 7 → 120 days).
  R.INTERVALS = [1, 3, 7, 14, 30, 60, 120];
  R.AGAIN_MS = 10 * 60 * 1000; // a forgotten card comes back 10 minutes later
  const ROLLOVER_H = 3;        // a study "day" starts at 3 am, so late-night reviews count for that day

  const isMark = (it) => it.type === 'stroke' && it.tool === 'high' && it.points && it.points.length > 0;

  // Tight rect around a highlighter stroke (its cached bbox pads by the whole width).
  function markRect(it) {
    return U.bboxOfPoints(it.points, it.size / 2 + 2);
  }
  function touches(a, b, gap) {
    return a.x - gap < b.x + b.w && a.x + a.w + gap > b.x && a.y - gap < b.y + b.h && a.y + a.h + gap > b.y;
  }

  // Overlapping highlight strokes form one card, named after its earliest stroke, so a
  // card keeps its id (and schedule) when more highlighting is added to it later.
  // Returned in reading order: top to bottom, left to right within a line.
  R.cards = function (note, now) {
    now = now || Date.now();
    const marks = [];
    for (const it of note.items) if (isMark(it)) marks.push({ id: it.id, color: it.color, rect: markRect(it) });
    const parent = marks.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        if (!touches(marks[i].rect, marks[j].rect, 2)) continue;
        const a = find(i), b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
    const groups = new Map();
    marks.forEach((m, i) => {
      const root = find(i);
      const g = groups.get(root);
      if (g) { g.rect = U.unionBBox(g.rect, m.rect); g.marks.push(m.id); } else groups.set(root, { id: marks[root].id, color: marks[root].color, rect: m.rect, marks: [m.id] });
    });
    const states = note.recall || {};
    const cards = [...groups.values()].map((g) => {
      const st = states[g.id] || null;
      return { id: g.id, color: g.color, x: g.rect.x, y: g.rect.y, w: g.rect.w, h: g.rect.h, marks: g.marks, state: st, isNew: !st, due: !!st && st.due <= now };
    });
    return readingOrder(cards);
  };

  function readingOrder(cards) {
    const byMid = cards.slice().sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
    const lines = [];
    for (const c of byMid) {
      const line = lines[lines.length - 1];
      if (line && Math.abs((c.y + c.h / 2) - line.mid) < Math.max(10, line.h / 2)) line.cards.push(c);
      else lines.push({ mid: c.y + c.h / 2, h: c.h, cards: [c] });
    }
    return lines.flatMap((l) => l.cards.sort((a, b) => a.x - b.x));
  }

  // Start of the study day `days` after the current one.
  function dueAfter(now, days) {
    const d = new Date(now);
    d.setHours(ROLLOVER_H, 0, 0, 0);
    if (d.getTime() > now) d.setDate(d.getDate() - 1);
    d.setDate(d.getDate() + days);
    return d.getTime();
  }

  // What answering would schedule, without changing anything (for button hints).
  R.preview = function (state, knew, now) {
    now = now || Date.now();
    const box = state ? state.box || 0 : 0;
    if (!knew) return { box: 0, due: now + R.AGAIN_MS };
    const nb = Math.min(box + 1, R.INTERVALS.length);
    return { box: nb, due: dueAfter(now, R.INTERVALS[nb - 1]) };
  };

  R.grade = function (note, id, knew, now) {
    now = now || Date.now();
    note.recall = note.recall || {};
    const prev = note.recall[id] || {};
    const next = R.preview(prev.box != null ? prev : null, knew, now);
    const st = {
      box: next.box, due: next.due, last: now,
      reps: (prev.reps || 0) + 1, lapses: (prev.lapses || 0) + (knew ? 0 : 1)
    };
    note.recall[id] = st;
    return st;
  };

  // Drop schedules whose highlight is gone (erased, or merged into an older card).
  R.prune = function (note) {
    if (!note.recall) return;
    const live = new Set(R.cards(note).map((c) => c.id));
    for (const id of Object.keys(note.recall)) if (!live.has(id)) delete note.recall[id];
    if (!Object.keys(note.recall).length) delete note.recall;
  };

  // Compact summary kept in the note's home-screen metadata.
  R.summary = function (note) {
    const cards = R.cards(note);
    const dueAt = [];
    for (const c of cards) if (c.state) dueAt.push(c.state.due);
    return { cards: cards.length, dueAt };
  };

  // Label for an answer button: when the card would come back.
  R.hint = function (state, knew) {
    if (!knew) return R.formatWait(R.AGAIN_MS);
    const days = R.INTERVALS[R.preview(state, true).box - 1];
    return days === 1 ? 'tomorrow' : R.formatWait(days * 86400000);
  };

  // "in 10 min", "later today", "tomorrow", "in 3 days" — counted in study days.
  R.when = function (ts, now) {
    now = now || Date.now();
    const ms = ts - now;
    if (ms <= 0) return 'now';
    if (ms < 2 * 3600000) return 'in ' + R.formatWait(ms);
    const days = Math.round((dueAfter(ts, 0) - dueAfter(now, 0)) / 86400000);
    if (days <= 0) return 'later today';
    if (days === 1) return 'tomorrow';
    return 'in ' + R.formatWait(days * 86400000);
  };

  R.dueCount = (meta, now) => (meta && Array.isArray(meta.dueAt) ? meta.dueAt.filter((t) => t <= (now || Date.now())).length : 0);

  // "10 min", "1 day", "3 days", "2 mo"
  R.formatWait = function (ms) {
    const min = Math.max(1, Math.round(ms / 60000));
    if (min < 60) return min + ' min';
    const h = Math.round(min / 60);
    if (h < 20) return h + ' h';
    const d = Math.max(1, Math.round(ms / 86400000));
    if (d < 45) return d + (d === 1 ? ' day' : ' days');
    return Math.round(d / 30) + ' mo';
  };

  window.BN = window.BN || {};
  window.BN.Recall = R;
})();
