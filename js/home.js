/* BetterNotes — home screen: note grid, search, per-note menu. */
(function () {
  'use strict';
  const U = BN.util;
  const Home = {};
  let app = null;
  let el = {};
  let metas = [];
  let query = '';
  let folder = '';            // '' = all notes
  const FOLDERS_KEY = 'bn.folders';
  const FOLDER_SEL_KEY = 'bn.home.folder';

  function storedFolders() {
    try { return JSON.parse(localStorage.getItem(FOLDERS_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveFolders(list) {
    try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }
  function allFolders() {
    const set = new Set(storedFolders());
    for (const m of metas) if (m.folder) set.add(m.folder);
    return [...set].sort((a, b) => a.localeCompare(b));
  }
  Home.currentFolder = () => folder;

  Home.init = function (appRef) {
    app = appRef;
    el = {
      screen: document.getElementById('screen-home'),
      grid: document.getElementById('note-grid'),
      empty: document.getElementById('home-empty'),
      search: document.getElementById('home-search'),
      newBtn: document.getElementById('home-new'),
      fab: document.getElementById('home-fab'),
      folders: document.getElementById('home-folders')
    };
    try { folder = localStorage.getItem(FOLDER_SEL_KEY) || ''; } catch (e) { folder = ''; }
    el.newBtn.addEventListener('click', () => app.createNote());
    el.fab.addEventListener('click', () => app.createNote());
    el.search.addEventListener('input', () => { query = el.search.value.toLowerCase(); renderGrid(); });
    document.getElementById('home-settings').addEventListener('click', () => app.openSettings());
    document.getElementById('home-help').addEventListener('click', () => app.openHelp());
  };

  Home.show = async function () {
    el.screen.hidden = false;
    await Home.refresh();
  };
  Home.hide = function () { el.screen.hidden = true; };

  Home.refresh = async function () {
    metas = await BN.Store.listMeta();
    renderGrid();
  };

  function renderFolders() {
    const bar = el.folders;
    bar.innerHTML = '';
    const names = allFolders();
    if (folder && !names.includes(folder)) folder = '';
    const chip = (label, value, extra) => {
      const b = document.createElement('button');
      b.className = 'folder-chip' + (value === folder ? ' active' : '') + (extra ? ' ' + extra : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        if (value === folder && value) { openFolderMenu(b, value); return; }
        folder = value;
        try { localStorage.setItem(FOLDER_SEL_KEY, folder); } catch (e) { /* ignore */ }
        renderFolders();
        renderGrid();
      });
      return b;
    };
    bar.appendChild(chip('All notes', ''));
    for (const n of names) bar.appendChild(chip(n, n));
    const add = chip('+ Folder', null, 'add');
    add.onclick = async () => {
      const name = await app.prompt('New folder', '');
      if (name === null) return;
      const clean = name.trim().slice(0, 40);
      if (!clean) return;
      const list = storedFolders();
      if (!list.includes(clean)) { list.push(clean); saveFolders(list); }
      folder = clean;
      try { localStorage.setItem(FOLDER_SEL_KEY, folder); } catch (e) { /* ignore */ }
      renderFolders();
      renderGrid();
    };
    bar.appendChild(add);
  }

  function openFolderMenu(anchor, name) {
    app.openMenuAt(anchor, [
      ['Rename folder', async () => {
        const nn = await app.prompt('Rename folder', name);
        if (nn === null) return;
        const clean = nn.trim().slice(0, 40);
        if (!clean || clean === name) return;
        for (const m of metas) {
          if (m.folder === name) { const n = await BN.Store.getNote(m.id); n.folder = clean; await BN.Store.saveNote(n, m.thumb); }
        }
        saveFolders(storedFolders().map((f) => (f === name ? clean : f)));
        folder = clean;
        try { localStorage.setItem(FOLDER_SEL_KEY, folder); } catch (e) { /* ignore */ }
        Home.refresh();
      }],
      ['Delete folder (keep notes)', async () => {
        for (const m of metas) {
          if (m.folder === name) { const n = await BN.Store.getNote(m.id); n.folder = ''; await BN.Store.saveNote(n, m.thumb); }
        }
        saveFolders(storedFolders().filter((f) => f !== name));
        folder = '';
        try { localStorage.setItem(FOLDER_SEL_KEY, ''); } catch (e) { /* ignore */ }
        Home.refresh();
      }, true]
    ]);
  }

  async function moveToFolder(m, target) {
    const n = await BN.Store.getNote(m.id);
    if (!n) return;
    n.folder = target || '';
    await BN.Store.saveNote(n, m.thumb);
    if (target && !storedFolders().includes(target)) saveFolders([...storedFolders(), target]);
    Home.refresh();
  }

  function renderGrid() {
    renderFolders();
    let list = folder ? metas.filter((m) => m.folder === folder) : metas;
    list = query ? list.filter((m) => (m.title || '').toLowerCase().includes(query)) : list;
    el.grid.innerHTML = '';
    el.empty.hidden = list.length > 0;
    for (const m of list) el.grid.appendChild(card(m));
  }

  function card(m) {
    const div = document.createElement('div');
    div.className = 'note-card';
    div.setAttribute('role', 'button');
    div.tabIndex = 0;

    const thumb = document.createElement('div');
    thumb.className = 'note-thumb';
    if (m.thumb) {
      const img = document.createElement('img');
      img.src = m.thumb;
      img.alt = '';
      img.draggable = false;
      thumb.appendChild(img);
    } else {
      thumb.classList.add('blank');
    }
    div.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'note-meta';
    const text = document.createElement('div');
    text.className = 'note-text';
    const title = document.createElement('div');
    title.className = 'note-title';
    title.textContent = m.title || 'Untitled note';
    const sub = document.createElement('div');
    sub.className = 'note-sub';
    sub.textContent = 'Edited ' + U.relativeTime(m.modified);
    text.appendChild(title);
    text.appendChild(sub);
    meta.appendChild(text);

    const menuBtn = document.createElement('button');
    menuBtn.className = 'icon-btn note-menu';
    menuBtn.setAttribute('aria-label', 'Note options');
    menuBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>';
    menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openMenu(menuBtn, m); });
    meta.appendChild(menuBtn);
    div.appendChild(meta);

    div.addEventListener('click', () => app.openNote(m.id));
    div.addEventListener('keydown', (e) => { if (e.key === 'Enter') app.openNote(m.id); });
    return div;
  }

  function openMenu(anchor, m) {
    app.openMenuAt(anchor, [
      ['Rename', async () => {
        const name = await app.prompt('Rename note', m.title);
        if (name === null) return;
        const note = await BN.Store.getNote(m.id);
        note.title = name.trim() || 'Untitled note';
        await BN.Store.saveNote(note, m.thumb);
        Home.refresh();
      }],
      ['Duplicate', async () => { await BN.Store.duplicateNote(m.id); Home.refresh(); }],
      ['Move to folder…', () => {
        const entries = allFolders().filter((f) => f !== m.folder).map((f) => [f, () => moveToFolder(m, f)]);
        entries.push(['New folder…', async () => {
          const name = await app.prompt('New folder', '');
          if (name === null) return;
          const clean = name.trim().slice(0, 40);
          if (clean) moveToFolder(m, clean);
        }]);
        if (m.folder) entries.push(['Remove from "' + m.folder + '"', () => moveToFolder(m, '')]);
        app.openMenuAt(anchor, entries);
      }],
      ['Back up (file)', async () => {
        const data = await BN.Store.exportBackup([m.id]);
        app.downloadJSON(data, (m.title || 'note').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) + '.betternotes.json');
      }],
      ['Delete', async () => {
        if (BN.Settings.get('storage.confirmDelete')) {
          const ok = await app.confirm(`Delete “${m.title}”?`, 'This removes it from this device. It cannot be undone.');
          if (!ok) return;
        }
        await BN.Store.deleteNote(m.id);
        Home.refresh();
      }, true]
    ]);
  }

  window.BN = window.BN || {};
  window.BN.Home = Home;
})();
