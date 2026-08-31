/* BetterNotes — home screen: note grid, search, per-note menu. */
(function () {
  'use strict';
  const U = BN.util;
  const Home = {};
  let app = null;
  let el = {};
  let metas = [];
  let query = '';

  Home.init = function (appRef) {
    app = appRef;
    el = {
      screen: document.getElementById('screen-home'),
      grid: document.getElementById('note-grid'),
      empty: document.getElementById('home-empty'),
      search: document.getElementById('home-search'),
      newBtn: document.getElementById('home-new'),
      fab: document.getElementById('home-fab')
    };
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

  function renderGrid() {
    const list = query ? metas.filter((m) => (m.title || '').toLowerCase().includes(query)) : metas;
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
    const title = document.createElement('div');
    title.className = 'note-title';
    title.textContent = m.title || 'Untitled note';
    const sub = document.createElement('div');
    sub.className = 'note-sub';
    sub.textContent = U.relativeTime(m.modified);
    meta.appendChild(title);
    meta.appendChild(sub);

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
