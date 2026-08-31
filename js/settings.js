/* BetterNotes — settings. Every setting is declared in this schema and rendered
   into the in-app Settings panel; nothing is hidden in code. Values persist in
   localStorage on the device. */
(function () {
  'use strict';
  const U = BN.util;
  const LS_KEY = 'bn.settings.v1';

  const SCHEMA = [
    { section: 'Pencil & input' },
    {
      key: 'input.pencilOnly', label: 'Draw with Pencil only', type: 'toggle', def: false,
      desc: 'Palm rejection: only Apple Pencil draws. One finger scrolls, pinch zooms. Turn off to draw with a finger (then use two fingers to scroll/zoom).'
    },
    {
      key: 'input.pressure', label: 'Pressure sensitivity', type: 'toggle', def: true,
      desc: 'Vary ink width with Pencil pressure.'
    },
    {
      key: 'input.pressureAmount', label: 'Pressure effect', type: 'range', min: 0.1, max: 1, step: 0.05, def: 0.65,
      desc: 'How strongly pressure changes the line width.'
    },
    {
      key: 'input.smoothing', label: 'Ink smoothing', type: 'range', min: 0, max: 1, step: 0.05, def: 0.5,
      desc: 'Steadies shaky lines as you write. Higher = smoother, slightly lazier ink.'
    },
    {
      key: 'input.prediction', label: 'Stroke prediction', type: 'toggle', def: true,
      desc: 'Uses predicted pen positions to cut visible lag while drawing.'
    },
    {
      key: 'input.shapeSnap', label: 'Hold to snap shapes', type: 'toggle', def: true,
      desc: 'Draw a line, rectangle, ellipse or triangle and hold the pen still — it snaps to a perfect shape.'
    },
    {
      key: 'input.shapeSnapDelay', label: 'Snap hold time', type: 'range', min: 300, max: 1200, step: 50, def: 600, unit: 'ms',
      desc: 'How long to hold still before a shape snaps.'
    },
    {
      key: 'input.twoFingerUndo', label: 'Two-finger tap to undo', type: 'toggle', def: true,
      desc: 'Quick two-finger tap on the page undoes the last action.'
    },

    { section: 'Ink defaults' },
    { key: 'ink.penColor', label: 'Pen color', type: 'color', def: '#1d1d2e' },
    { key: 'ink.penSize', label: 'Pen size', type: 'range', min: 1, max: 14, step: 0.5, def: 3 },
    { key: 'ink.highColor', label: 'Highlighter color', type: 'color', def: '#ffd60a' },
    { key: 'ink.highSize', label: 'Highlighter size', type: 'range', min: 6, max: 40, step: 1, def: 16 },
    { key: 'ink.highOpacity', label: 'Highlighter opacity', type: 'range', min: 0.15, max: 0.6, step: 0.05, def: 0.35 },
    { key: 'ink.eraserSize', label: 'Eraser size', type: 'range', min: 6, max: 60, step: 1, def: 22 },

    { section: 'Handwriting' },
    {
      key: 'hand.tidyStrength', label: 'Tidy strength', type: 'range', min: 0.1, max: 1, step: 0.05, def: 0.55,
      desc: 'How aggressively “Tidy” cleans up selected handwriting (smooths wobble, evens stroke width).'
    },
    {
      info: 'Tip: on iPad, write with the Pencil into any text box — iPadOS Scribble turns your handwriting into typed text, entirely on-device.'
    },

    { section: 'Paper (new notes)' },
    {
      key: 'paper.style', label: 'Paper style', type: 'select', def: 'lines',
      options: [['lines', 'Lined'], ['grid', 'Grid'], ['dots', 'Dots'], ['blank', 'Blank']]
    },
    { key: 'paper.spacing', label: 'Line spacing', type: 'range', min: 20, max: 64, step: 2, def: 32 },
    { key: 'paper.color', label: 'Paper color', type: 'color', def: '#ffffff' },
    {
      key: 'paper.width', label: 'Page width', type: 'select', def: '800',
      options: [['600', 'Narrow'], ['800', 'Standard'], ['1000', 'Wide']],
      desc: 'Logical page width for new notes. Existing notes keep theirs.'
    },

    { section: 'Appearance' },
    {
      key: 'appearance.theme', label: 'Theme', type: 'select', def: 'system',
      options: [['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']]
    },
    { key: 'appearance.accent', label: 'Accent color', type: 'color', def: '#4f7cff' },

    { section: 'Saving & privacy' },
    {
      key: 'storage.autosaveMs', label: 'Autosave delay', type: 'range', min: 300, max: 3000, step: 100, def: 900, unit: 'ms',
      desc: 'Notes save automatically this soon after you stop editing (and always when you leave a note).'
    },
    { key: 'storage.undoDepth', label: 'Undo history', type: 'range', min: 10, max: 200, step: 10, def: 60, unit: ' steps' },
    { key: 'storage.confirmDelete', label: 'Confirm before deleting notes', type: 'toggle', def: true },
    {
      info: 'Everything stays on this device. BetterNotes has no accounts, no analytics and makes no network requests after loading. Use “Back up” below to save your notes as a file you control.'
    },
    { action: 'backup', label: 'Back up all notes…', desc: 'Saves every note (including images) to a single file.' },
    { action: 'import', label: 'Import backup…', desc: 'Adds notes from a backup file. Never overwrites existing notes.' },
    { action: 'persist', label: 'Protect storage', desc: 'Asks the device not to evict this app’s data when space runs low.' },
    { action: 'wipe', label: 'Erase all data…', desc: 'Deletes every note on this device.', danger: true },
    { section: 'About' },
    { info: 'BetterNotes __VERSION__ — free, open, offline. Ink · Pencil · text · images.' },
    { infoId: 'bn-storage-usage', info: 'Storage used: …' }
  ];

  const Settings = {
    schema: SCHEMA,
    values: {},
    actions: {} // filled by app.js: {backup, import, persist, wipe}
  };

  Settings.load = function () {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { stored = {}; }
    for (const item of SCHEMA) {
      if (!item.key) continue;
      Settings.values[item.key] = (item.key in stored) ? stored[item.key] : item.def;
    }
  };

  function persistValues() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(Settings.values)); } catch (e) { /* storage full/blocked */ }
  }

  Settings.get = (key) => Settings.values[key];

  Settings.set = function (key, val) {
    Settings.values[key] = val;
    persistValues();
    if (key.startsWith('appearance.')) Settings.applyAppearance();
    document.dispatchEvent(new CustomEvent('bn:settings-changed', { detail: { key, val } }));
  };

  Settings.applyAppearance = function () {
    const theme = Settings.get('appearance.theme') || 'system';
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    root.style.setProperty('--accent', Settings.get('appearance.accent') || '#4f7cff');
    // Keep the iOS status bar area matching the app chrome.
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = dark ? '#101014' : '#f4f4f7';
  };

  /* ---------------- UI ---------------- */

  Settings.render = function (container, version) {
    container.innerHTML = '';
    for (const item of SCHEMA) {
      if (item.section) {
        const h = document.createElement('h3');
        h.className = 'set-section';
        h.textContent = item.section;
        container.appendChild(h);
        continue;
      }
      if (item.info !== undefined && !item.key && !item.action) {
        const p = document.createElement('p');
        p.className = 'set-info';
        if (item.infoId) p.id = item.infoId;
        p.textContent = item.info.replace('__VERSION__', version || '');
        container.appendChild(p);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'set-row' + (item.danger ? ' danger' : '');
      const main = document.createElement('div');
      main.className = 'set-main';
      const label = document.createElement('label');
      label.className = 'set-label';
      label.textContent = item.label;
      main.appendChild(label);
      if (item.desc) {
        const d = document.createElement('div');
        d.className = 'set-desc';
        d.textContent = item.desc;
        main.appendChild(d);
      }
      row.appendChild(main);
      row.appendChild(buildControl(item));
      container.appendChild(row);
    }
    Settings.refreshUsage();
  };

  function buildControl(item) {
    const wrap = document.createElement('div');
    wrap.className = 'set-control';
    if (item.action) {
      const btn = document.createElement('button');
      btn.className = 'btn' + (item.danger ? ' btn-danger' : '');
      btn.textContent = item.label.replace(/…$/, '');
      btn.addEventListener('click', () => Settings.actions[item.action]?.());
      wrap.appendChild(btn);
      return wrap;
    }
    const val = Settings.get(item.key);
    if (item.type === 'toggle') {
      const btn = document.createElement('button');
      btn.className = 'toggle';
      btn.setAttribute('role', 'switch');
      btn.setAttribute('aria-checked', String(!!val));
      btn.addEventListener('click', () => {
        const nv = btn.getAttribute('aria-checked') !== 'true';
        btn.setAttribute('aria-checked', String(nv));
        Settings.set(item.key, nv);
      });
      wrap.appendChild(btn);
    } else if (item.type === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = item.min; input.max = item.max; input.step = item.step;
      input.value = val;
      const out = document.createElement('span');
      out.className = 'set-value';
      const fmt = (v) => (item.step >= 1 ? Math.round(v) : (+v).toFixed(2).replace(/\.?0+$/, '')) + (item.unit || '');
      out.textContent = fmt(val);
      input.addEventListener('input', () => {
        out.textContent = fmt(+input.value);
        Settings.set(item.key, +input.value);
      });
      wrap.appendChild(input);
      wrap.appendChild(out);
    } else if (item.type === 'select') {
      const sel = document.createElement('select');
      for (const [v, label] of item.options) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        if (String(val) === v) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => Settings.set(item.key, sel.value));
      wrap.appendChild(sel);
    } else if (item.type === 'color') {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = val;
      input.addEventListener('input', () => Settings.set(item.key, input.value));
      wrap.appendChild(input);
    }
    return wrap;
  }

  Settings.refreshUsage = async function () {
    const el = document.getElementById('bn-storage-usage');
    if (!el) return;
    const est = await BN.Store.usage();
    if (est) {
      let persisted = '';
      try {
        if (navigator.storage?.persisted) persisted = (await navigator.storage.persisted()) ? ' · storage protected' : '';
      } catch (e) { /* ignore */ }
      el.textContent = `Storage used: ${U.formatBytes(est.usage)} of ${U.formatBytes(est.quota)} available${persisted}`;
    } else {
      el.textContent = 'Storage used: not reported by this browser';
    }
  };

  window.BN = window.BN || {};
  window.BN.Settings = Settings;
})();
