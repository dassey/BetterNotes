/* BetterNotes — app shell: boot, hash routing, modals/dialogs, toasts. */
(function () {
  'use strict';
  const U = BN.util;
  const App = {};
  BN.VERSION = '0.1.0';

  let toastTimer = null;

  App.boot = async function () {
    BN.Settings.load();
    BN.Settings.applyAppearance();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => BN.Settings.applyAppearance());
    await BN.Store.init();
    BN.Home.init(App);
    BN.Editor.init(App);
    bindShell();
    wireSettingsActions();
    await firstRun();
    window.addEventListener('hashchange', route);
    await route();
    // Ask the browser to protect our storage from eviction (silent if denied).
    BN.Store.requestPersistence();
    registerSW();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') BN.Editor.flush();
    });
  };

  /* ---------------- routing ---------------- */

  async function route() {
    const h = location.hash || '#/';
    const m = h.match(/^#\/note\/(.+)$/);
    if (m) {
      const note = await BN.Store.getNote(m[1]);
      if (!note) { location.hash = '#/'; return; }
      BN.Home.hide();
      BN.Editor.open(note);
    } else {
      await BN.Editor.close();
      await BN.Home.show();
    }
  }

  App.openNote = (id) => { location.hash = '#/note/' + id; };
  App.showHome = () => { location.hash = '#/'; };

  App.createNote = async function () {
    const note = BN.Store.newNote({
      width: parseInt(BN.Settings.get('paper.width'), 10) || 800,
      style: BN.Settings.get('paper.style'),
      spacing: BN.Settings.get('paper.spacing'),
      color: BN.Settings.get('paper.color')
    });
    await BN.Store.saveNote(note, null);
    App.openNote(note.id);
  };

  /* ---------------- first run welcome note ---------------- */

  async function firstRun() {
    if (localStorage.getItem('bn.welcomed')) return;
    try { localStorage.setItem('bn.welcomed', '1'); } catch (e) { }
    const metas = await BN.Store.listMeta();
    if (metas.length) return;
    const note = BN.Store.newNote({ width: 800, style: 'lines', spacing: 32, color: '#ffffff' });
    note.title = 'Welcome to BetterNotes';
    const mk = (y, text, size, color) => ({
      id: U.uid(), type: 'text', x: 56, y, w: 690, h: size * 1.5, size, color: color || '#1d1d2e', text
    });
    note.items.push(
      mk(48, 'Welcome to BetterNotes ✍️', 30, '#4f7cff'),
      mk(112, 'Everything stays on this device — no accounts, nothing uploaded, works offline.', 18),
      mk(176, '• Pen & highlighter with Apple Pencil pressure\n• Hold the pen still after drawing a shape to snap it perfect\n• Lasso-select ink, then move, resize, recolor or Tidy it\n• Add text boxes (write into them with the Pencil — Scribble types it for you)\n• Insert photos and move them around\n• Pinch to zoom, two-finger tap to undo', 17),
      mk(430, 'Open ⚙ Settings to tune everything: palm rejection, pressure, smoothing, paper, themes and backups.', 17),
      mk(500, 'Tip: tap the active pen tool again to pick colors and sizes.', 17, '#4f7cff')
    );
    await BN.Store.saveNote(note, null);
  }

  /* ---------------- shell bindings ---------------- */

  function bindShell() {
    document.getElementById('settings-close').addEventListener('click', App.closeSettings);
    document.getElementById('help-close').addEventListener('click', () => toggleModal('help-modal', false));
    for (const id of ['settings-modal', 'help-modal']) {
      document.getElementById(id).addEventListener('pointerdown', (e) => {
        if (e.target === e.currentTarget) toggleModal(id, false);
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        toggleModal('settings-modal', false);
        toggleModal('help-modal', false);
      }
    });
  }

  function toggleModal(id, show) {
    const m = document.getElementById(id);
    m.classList.toggle('open', !!show);
  }

  App.openSettings = function () {
    BN.Settings.render(document.getElementById('settings-body'), BN.VERSION);
    toggleModal('settings-modal', true);
  };
  App.closeSettings = function () { toggleModal('settings-modal', false); };
  App.openHelp = function () { toggleModal('help-modal', true); };

  /* ---------------- settings actions ---------------- */

  function wireSettingsActions() {
    BN.Settings.actions.backup = async function () {
      try {
        await BN.Editor.flush();
        const data = await BN.Store.exportBackup(null);
        App.downloadJSON(data, 'betternotes-backup.json');
      } catch (e) { App.toast('Backup failed', true); }
    };
    BN.Settings.actions.import = function () {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('change', async () => {
        const f = input.files[0];
        if (!f) return;
        try {
          const data = JSON.parse(await f.text());
          const n = await BN.Store.importBackup(data);
          App.toast(`Imported ${n} note${n === 1 ? '' : 's'}`);
          BN.Home.refresh();
          BN.Settings.refreshUsage();
        } catch (e) {
          App.toast('Import failed: ' + (e.message || 'invalid file'), true);
        }
      });
      input.click();
    };
    BN.Settings.actions.persist = async function () {
      const ok = await BN.Store.requestPersistence();
      App.toast(ok ? 'Storage is protected' : 'Browser did not grant persistent storage');
      BN.Settings.refreshUsage();
    };
    BN.Settings.actions.wipe = async function () {
      const ok = await App.confirm('Erase all data?', 'Every note on this device will be deleted. This cannot be undone.');
      if (!ok) return;
      await BN.Store.wipeAll();
      App.toast('All notes erased');
      BN.Home.refresh();
      BN.Settings.refreshUsage();
    };
  }

  /* ---------------- dialogs ---------------- */

  function buildDialog(title, msg, controls) {
    const overlay = document.createElement('div');
    overlay.className = 'modal open dialog';
    const box = document.createElement('div');
    box.className = 'modal-box small';
    const h = document.createElement('h2');
    h.textContent = title;
    box.appendChild(h);
    if (msg) {
      const p = document.createElement('p');
      p.className = 'dialog-msg';
      p.textContent = msg;
      box.appendChild(p);
    }
    box.appendChild(controls);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return overlay;
  }

  App.confirm = function (title, msg) {
    return new Promise((resolve) => {
      const row = document.createElement('div');
      row.className = 'dialog-row';
      const no = document.createElement('button');
      no.className = 'btn';
      no.textContent = 'Cancel';
      const yes = document.createElement('button');
      yes.className = 'btn btn-danger';
      yes.textContent = 'Delete';
      row.appendChild(no); row.appendChild(yes);
      const overlay = buildDialog(title, msg, row);
      no.addEventListener('click', () => { overlay.remove(); resolve(false); });
      yes.addEventListener('click', () => { overlay.remove(); resolve(true); });
    });
  };

  App.prompt = function (title, value) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'text-input';
      input.value = value || '';
      const row = document.createElement('div');
      row.className = 'dialog-row';
      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = 'Cancel';
      const ok = document.createElement('button');
      ok.className = 'btn btn-primary';
      ok.textContent = 'Save';
      row.appendChild(cancel); row.appendChild(ok);
      wrap.appendChild(input); wrap.appendChild(row);
      const overlay = buildDialog(title, null, wrap);
      input.focus();
      input.select();
      const done = (v) => { overlay.remove(); resolve(v); };
      cancel.addEventListener('click', () => done(null));
      ok.addEventListener('click', () => done(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(input.value);
        if (e.key === 'Escape') done(null);
      });
    });
  };

  App.openMenuAt = function (anchor, entries) {
    const pop = document.createElement('div');
    pop.className = 'popover';
    const menu = document.createElement('div');
    menu.className = 'menu';
    for (const [label, fn, danger] of entries) {
      const b = document.createElement('button');
      b.textContent = label;
      if (danger) b.classList.add('danger');
      b.addEventListener('click', () => { close(); fn(); });
      menu.appendChild(b);
    }
    pop.appendChild(menu);
    document.body.appendChild(pop);
    const ar = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = U.clamp(ar.right - pw, 8, window.innerWidth - pw - 8) + 'px';
    pop.style.top = (ar.bottom + 6 + ph > window.innerHeight - 8 ? ar.top - ph - 6 : ar.bottom + 6) + 'px';
    function outside(e) { if (!pop.contains(e.target)) close(); }
    function close() {
      pop.remove();
      document.removeEventListener('pointerdown', outside, { capture: true });
    }
    setTimeout(() => document.addEventListener('pointerdown', outside, { capture: true }), 0);
  };

  /* ---------------- toasts & downloads ---------------- */

  App.toast = function (msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  };

  App.downloadBlob = async function (blob, name) {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    App.toast('Saved ' + name);
  };

  App.downloadJSON = function (data, name) {
    return App.downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), name);
  };

  /* ---------------- service worker ---------------- */

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) return; // file:// — offline cache not needed
    navigator.serviceWorker.register('./sw.js').catch(() => { });
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) App.toast('BetterNotes updated — reopen to use the new version');
      hadController = true;
    });
  }

  window.BN = window.BN || {};
  window.BN.App = App;
  window.addEventListener('DOMContentLoaded', () => App.boot());
})();
