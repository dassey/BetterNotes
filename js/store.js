/* BetterNotes — storage. Notes live in IndexedDB on the device; nothing is ever
   sent anywhere. Settings live in localStorage (schema in settings.js). */
(function () {
  'use strict';
  const U = BN.util;
  const DB_NAME = 'betternotes';
  const DB_VERSION = 1;
  let db = null;

  const Store = {};

  Store.init = function () {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
      };
      req.onsuccess = () => { db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  };

  function tx(store, mode) {
    return db.transaction(store, mode).objectStore(store);
  }
  function reqP(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  }

  Store.newNote = function (defaults) {
    const now = Date.now();
    return {
      id: U.uid(),
      title: 'Untitled note',
      created: now,
      modified: now,
      width: defaults.width || 800,
      height: Math.round((defaults.width || 800) * 1.4),
      paper: {
        style: defaults.style || 'lines',
        spacing: defaults.spacing || 32,
        color: defaults.color || '#ffffff',
        layout: defaults.layout || 'page'
      },
      view: null,          // saved {x,y,s} viewport
      items: []            // strokes / text / images, in z-order
    };
  };

  Store.getNote = (id) => reqP(tx('notes', 'readonly').get(id));

  Store.saveNote = async function (note, thumbDataURL) {
    note.modified = Date.now();
    const clone = U.deepClone(note);
    await reqP(tx('notes', 'readwrite').put(clone));
    const meta = {
      id: note.id, title: note.title, created: note.created, modified: note.modified,
      items: note.items.length, thumb: thumbDataURL || (await Store.getMeta(note.id))?.thumb || null
    };
    await reqP(tx('meta', 'readwrite').put(meta));
    return meta;
  };

  Store.getMeta = (id) => reqP(tx('meta', 'readonly').get(id));

  Store.listMeta = async function () {
    const all = await reqP(tx('meta', 'readonly').getAll());
    return all.sort((a, b) => b.modified - a.modified);
  };

  Store.deleteNote = async function (id) {
    await reqP(tx('notes', 'readwrite').delete(id));
    await reqP(tx('meta', 'readwrite').delete(id));
  };

  Store.duplicateNote = async function (id) {
    const note = await Store.getNote(id);
    if (!note) return null;
    const copy = U.deepClone(note);
    copy.id = U.uid();
    copy.title = note.title + ' copy';
    copy.created = copy.modified = Date.now();
    for (const it of copy.items) it.id = U.uid();
    const meta = await Store.getMeta(id);
    await Store.saveNote(copy, meta?.thumb || null);
    return copy.id;
  };

  /* ---------------- backup / restore (JSON with images as data URLs) ------- */

  Store.exportBackup = async function (noteIds) {
    const notes = [];
    const ids = noteIds || (await Store.listMeta()).map((m) => m.id);
    for (const id of ids) {
      const note = await Store.getNote(id);
      if (!note) continue;
      const n = U.deepClone(note);
      for (const it of n.items) {
        if (it.type === 'image' && it.blob) {
          it.dataURL = await U.blobToDataURL(it.blob);
          delete it.blob;
        }
      }
      notes.push(n);
    }
    return { app: 'BetterNotes', format: 1, exported: Date.now(), notes };
  };

  Store.importBackup = async function (data) {
    if (!data || data.app !== 'BetterNotes' || !Array.isArray(data.notes)) {
      throw new Error('Not a BetterNotes backup file');
    }
    let count = 0;
    for (const n of data.notes) {
      const note = U.deepClone(n);
      note.id = U.uid(); // always import as new notes; never overwrite
      for (const it of note.items) {
        it.id = it.id || U.uid();
        if (it.type === 'image' && it.dataURL) {
          it.blob = await U.dataURLToBlob(it.dataURL);
          delete it.dataURL;
        }
      }
      await Store.saveNote(note, null);
      count++;
    }
    return count;
  };

  Store.wipeAll = async function () {
    await reqP(tx('notes', 'readwrite').clear());
    await reqP(tx('meta', 'readwrite').clear());
  };

  Store.usage = async function () {
    if (navigator.storage?.estimate) {
      try { return await navigator.storage.estimate(); } catch (e) { /* ignore */ }
    }
    return null;
  };

  Store.requestPersistence = async function () {
    if (navigator.storage?.persist) {
      try { return await navigator.storage.persist(); } catch (e) { return false; }
    }
    return false;
  };

  window.BN = window.BN || {};
  window.BN.Store = Store;
})();
