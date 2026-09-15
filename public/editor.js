(function () {
  'use strict';
  // Editor page (/<site>/_edit/…). The note editor itself is CodeMirror 6
  // (/_static/cm/editor.js, loaded through the import map); if it cannot load,
  // the page falls back to the plain textarea. Everything here — load, save,
  // conflicts, preview, quick switcher, command palette, status bar — works
  // with either engine through the small `ed` adapter.
  var E = window.MD2HTML_EDIT; if (!E) return;
  var S = E.settings || {};
  var root = document.documentElement;
  var api = E.base + '_api/';
  var ta = document.getElementById('edText'), cmHost = document.getElementById('edCm');
  var preview = document.getElementById('edPreview'), previewPane = document.querySelector('.ed-preview'), status = document.getElementById('edStatus');
  var saveBtn = document.getElementById('edSave'), delBtn = document.getElementById('edDelete'), viewLink = document.getElementById('edView');
  var conflict = document.getElementById('edConflict'), complete = document.getElementById('edComplete');
  var sbWords = document.getElementById('sbWords'), sbChars = document.getElementById('sbChars'), sbMode = document.getElementById('sbMode'), sbEngine = document.getElementById('sbEngine'), sbBacklinks = document.getElementById('sbBacklinks');
  var stamp = null, exists = E.exists, dirty = false, saving = false, lastPreviewed = null, notesP = null, cmModule = null;
  var ed = null;

  function whenReady(check, fn, tries) { if (check()) fn(); else if (tries > 0) setTimeout(function () { whenReady(check, fn, tries - 1); }, 100); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function setStatus(text, kind) { status.textContent = text; status.className = 'ed-status ' + (kind === 'dirty' ? 'is-dirty' : kind === 'error' ? 'is-error' : 'muted'); }
  function req(method, path, body) {
    return fetch(api + path, { method: method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'md2html' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (j) { if (j && typeof j === 'object') j._status = r.status; return j; }, function () { return { _status: r.status, error: 'HTTP ' + r.status }; }); });
  }
  function getJson(path) { return req('GET', path).then(function (j) { if (j && j._status && j._status !== 200) throw new Error(j.error || 'HTTP ' + j._status); return j; }); }
  function notes() { return notesP || (notesP = getJson('notes').catch(function () { notesP = null; return []; })); }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  function editUrl(rel) { return E.base + '_edit/' + rel.replace(/\.md$/i, '').split('/').map(encodeURIComponent).join('/'); }

  // ---- theme (same preference as the viewer) ----
  try { var saved = localStorage.getItem('md2html-theme'); if (saved) root.setAttribute('data-theme', saved); } catch (e) {}
  var isDark = function () { return root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches); };
  function syncThemeClass() { document.body.classList.toggle('theme-dark', isDark()); document.body.classList.toggle('theme-light', !isDark()); }
  syncThemeClass();
  function toggleTheme() {
    var next = isDark() ? 'light' : 'dark'; root.setAttribute('data-theme', next);
    try { localStorage.setItem('md2html-theme', next); } catch (e) {}
    syncThemeClass(); lastPreviewed = null; renderPreview(); if (ed && ed.refresh) ed.refresh();
  }
  document.getElementById('themeBtn').addEventListener('click', toggleTheme);

  // ---- layout modes: edit (editor only), split (editor + rendered page), preview (reading view) ----
  var modes = document.querySelectorAll('.ed-modes button'), mode = 'split', lastEditMode = 'edit';
  function setMode(m, persist) {
    mode = m;
    document.body.className = document.body.className.replace(/\bmode-\w+/g, '') + ' mode-' + m;
    modes.forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-mode') === m); });
    if (m !== 'preview') lastEditMode = m;
    if (persist !== false) store('md2html-edit-mode', m);
    renderPreview();
    if (m !== 'preview' && ed) setTimeout(function () { ed.focus(); }, 0);
  }
  function toggleReading() { setMode(mode === 'preview' ? lastEditMode || 'edit' : 'preview'); }
  modes.forEach(function (b) { b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); }); });

  // ---- sidebar ----
  var sidebar = document.getElementById('sidebar'), menuBtn = document.getElementById('menuBtn');
  function toggleSidebar() { if (matchMedia('(max-width: 860px)').matches) sidebar.classList.toggle('is-open'); else document.body.classList.toggle('sidebar-collapsed'); }
  if (menuBtn) menuBtn.addEventListener('click', toggleSidebar);
  var cur = sidebar.querySelector('.is-current'); if (cur) cur.scrollIntoView({ block: 'center' });
  document.getElementById('edFilter').addEventListener('input', function () {
    var q = this.value.trim().toLowerCase();
    sidebar.querySelectorAll('.nav-note').forEach(function (a) { a.classList.toggle('is-filtered-out', !!q && a.textContent.toLowerCase().indexOf(q) < 0 && a.getAttribute('data-rel').toLowerCase().indexOf(q) < 0); });
    sidebar.querySelectorAll('.nav-folder').forEach(function (f) { var any = f.querySelector('.nav-note:not(.is-filtered-out)'); f.classList.toggle('is-filtered-out', !!q && !any); if (q && any) f.open = true; });
  });
  sidebar.addEventListener('click', function (e) { var a = e.target.closest('a.nav-note'); if (a && dirty && !confirm('Discard unsaved changes?')) e.preventDefault(); });

  // ---- status bar (Obsidian's: backlinks, words, characters, editing mode) ----
  if (E.backlinks) { sbBacklinks.hidden = false; sbBacklinks.textContent = E.backlinks + (E.backlinks === 1 ? ' backlink' : ' backlinks'); }
  function counts(text) {
    if (cmModule && cmModule.countText) return cmModule.countText(text);
    var body = text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '');
    return { words: (body.match(/[^\s]+/g) || []).length, chars: body.length };
  }
  var countTimer = null;
  function updateCounts() {
    clearTimeout(countTimer);
    countTimer = setTimeout(function () {
      if (!ed) return;
      var c = counts(ed.get()), sel = ed.selectedText ? ed.selectedText() : '';
      if (sel) { var s = counts(sel); sbWords.textContent = s.words + ' of ' + c.words + ' words'; sbChars.textContent = s.chars + ' of ' + c.chars + ' characters'; }
      else { sbWords.textContent = c.words.toLocaleString() + (c.words === 1 ? ' word' : ' words'); sbChars.textContent = c.chars.toLocaleString() + (c.chars === 1 ? ' character' : ' characters'); }
    }, 150);
  }
  function updateModeButton() {
    if (!ed || !ed.setLivePreview) { sbMode.hidden = true; return; }
    sbMode.hidden = false;
    var lp = ed.isLivePreview();
    sbMode.textContent = lp ? '👁 Live Preview' : '</> Source mode';
    sbMode.title = 'Currently in ' + (lp ? 'Live Preview' : 'Source mode') + '. Click to switch.';
  }
  function toggleLivePreview() { if (!ed || !ed.setLivePreview) return; ed.setLivePreview(!ed.isLivePreview()); store('ws-live-preview', ed.isLivePreview()); updateModeButton(); }
  sbMode.addEventListener('click', toggleLivePreview);

  // ---- editor engines ----
  function textareaAdapter() {
    return {
      kind: 'textarea',
      get: function () { return ta.value; },
      set: function (t) { ta.value = t; },
      focus: function () { ta.focus(); },
      selectedText: function () { return ta.value.slice(ta.selectionStart, ta.selectionEnd); },
      commands: [],
    };
  }

  // CodeMirror loads in parallel with the note; any failure keeps the textarea.
  var wantCm = !/[?&]textarea=1\b/.test(location.search) && !!document.querySelector('script[type="importmap"]')
    && (!window.HTMLScriptElement || !HTMLScriptElement.supports || HTMLScriptElement.supports('importmap'));
  var cmP = wantCm ? import('ws/editor').then(function (m) { cmModule = m; return m; }, function (e) { console.warn('Websidian: CodeMirror editor unavailable, using the plain textarea.', e); return null; }) : Promise.resolve(null);

  function newNoteTemplate() { return '---\ntitle: ' + E.rel.replace(/.*\//, '').replace(/\.md$/i, '') + '\n---\n\n'; }

  Promise.all([cmP, req('GET', 'note?rel=' + encodeURIComponent(E.rel))]).then(function (res) {
    var mod = res[0], j = res[1], text;
    if (j.protected) setProtected(j.reason);
    if (j._status === 200) { text = j.text; stamp = j.stamp; exists = true; }
    else if (j._status === 404) { text = newNoteTemplate(); stamp = null; exists = false; setStatus('New note — not saved yet'); }
    else { setStatus(j.error || 'Could not load', 'error'); return; }
    if (mod) {
      try {
        var lpPref = store('ws-live-preview');
        ed = mod.createEditor({
          parent: cmHost, doc: text, rel: E.rel, base: E.base, settings: S,
          livePreview: typeof lpPref === 'boolean' ? lpPref : undefined,
          api: {
            notes: notes, files: function () { return getJson('files'); }, tags: function () { return getJson('tags'); },
            properties: function () { return getJson('properties'); }, anchors: function (rel) { return getJson('anchors?rel=' + encodeURIComponent(rel)); },
          },
          onChange: onEdit, onSelection: updateCounts, openLink: openLink, isDark: isDark,
        });
        ta.hidden = true; ta.disabled = true; cmHost.hidden = false;
        sbEngine.textContent = 'CodeMirror';
      } catch (e) { console.error('Websidian: CodeMirror failed to start', e); ed = null; }
    }
    if (!ed) {
      ed = textareaAdapter(); ta.value = text; ta.disabled = false; ta.placeholder = 'Write Markdown…';
      ta.setSelectionRange(0, 0); ta.scrollTop = 0; sbEngine.textContent = 'Plain text';
    }
    var savedMode = store('md2html-edit-mode');
    setMode(savedMode || (S.defaultViewMode === 'preview' ? 'preview' : ed.kind === 'codemirror' ? 'edit' : 'split'), false);
    updateModeButton(); updateCounts();
    if (exists) setStatus('Loaded');
    if (location.hash && ed.scrollToHeading) { try { ed.scrollToHeading(decodeURIComponent(location.hash.slice(1))); } catch (e) {} }
    else if (mode !== 'preview') ed.focus();
    rememberRecent(E.rel);
  });

  function onEdit() {
    setDirty(true); updateCounts();
    clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 350);
    scheduleAutosave();
  }
  function setDirty(d) { dirty = d; if (d) setStatus('Unsaved changes', 'dirty'); document.title = (d ? '● ' : '') + document.title.replace(/^● /, ''); }

  // ---- rendered preview (split / reading view), only while visible ----
  var previewTimer = null;
  function previewVisible() { return previewPane && getComputedStyle(previewPane).display !== 'none'; }
  function renderPreview() {
    if (!ed || !previewVisible()) return;
    var text = ed.get();
    if (text === lastPreviewed) return;
    lastPreviewed = text;
    req('POST', 'preview', { rel: E.rel, text: text }).then(function (j) {
      if (ed.get() !== text) return;                       // already stale
      if (j._status !== 200) { preview.innerHTML = '<p class="muted">' + esc(j.error || 'Preview failed') + '</p>'; return; }
      var hasH1 = /<h1\b/i.test(j.html);
      preview.innerHTML = (hasH1 ? '' : '<h1>' + esc(j.title) + '</h1>') + j.html;
      decorate(preview);
    });
  }
  function decorate(el) {
    whenReady(function () { return !!window.hljs; }, function () { el.querySelectorAll('pre code.hljs').forEach(function (c) { try { window.hljs.highlightElement(c); } catch (e) {} }); }, 30);
    whenReady(function () { return !!window.katex; }, function () { el.querySelectorAll('.math').forEach(function (m) { try { window.katex.render(m.textContent, m, { displayMode: m.classList.contains('math-block'), throwOnError: false }); } catch (e) {} }); }, 30);
    whenReady(function () { return !!window.mermaid; }, function () {
      var blocks = el.querySelectorAll('pre.mermaid'); if (!blocks.length) return;
      window.mermaid.initialize(document.documentElement.hasAttribute('data-untrusted') ? { startOnLoad: false, theme: isDark() ? 'dark' : 'default', securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false } } : { startOnLoad: false, theme: isDark() ? 'dark' : 'default', securityLevel: 'loose' });
      window.mermaid.run({ nodes: blocks }).catch(function () {});
    }, 30);
    // Internal links in the preview open the target note in the editor; external ones in a new tab.
    el.querySelectorAll('a[href]').forEach(function (a) {
      var href = a.getAttribute('href');
      if (/^#/.test(href)) return;
      if (a.classList.contains('internal-link') && href.indexOf(E.base) === 0 && href.charAt(E.base.length) !== '_') { a.href = E.base + '_edit/' + href.slice(E.base.length); return; }
      a.target = '_blank';
    });
  }

  // ---- links followed from the editor ----
  function go(url, newTab) { if (newTab) window.open(url, '_blank'); else location.href = url; }
  function openLink(l) {
    if (!l) return;
    if (l.type === 'url') { var href = /^www\./i.test(l.href) ? 'https://' + l.href : l.href; if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener'); return; }
    if (l.type === 'file') return go(l.url, true);
    if (l.type === 'note') return go(editUrl(l.rel) + (l.heading ? '#' + encodeURIComponent(l.heading) : ''), l.newTab);
    if (l.type === 'new' && l.path) {
      // Obsidian creates a missing note on click, in the folder the vault's settings say.
      var name = l.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (name.indexOf('/') < 0) {
        if (S.newFileLocation === 'current' && E.rel.indexOf('/') >= 0) name = E.rel.slice(0, E.rel.lastIndexOf('/') + 1) + name;
        else if (S.newFileLocation === 'folder' && S.newFileFolderPath && S.newFileFolderPath !== '/') name = S.newFileFolderPath.replace(/^\/+|\/+$/g, '') + '/' + name;
      }
      go(editUrl(name), l.newTab);
    }
  }

  // ---- agent instruction files (SKILL.md, MEMORY.md… on sites that protect them) ----
  // The server answers 428 until a save or delete carries confirm: "instructions".
  // Only a person clicking "Save anyway" sends that; autosave never does.
  var protectedNote = false, autosaveBlocked = false, protectBanner = null;
  function banner() {
    if (!protectBanner) {
      protectBanner = document.createElement('div');
      protectBanner.className = 'ed-protected'; protectBanner.setAttribute('role', 'note');
      protectBanner.innerHTML = '<span class="ed-protected-icon" aria-hidden="true">⚠</span><span class="ed-protected-text"></span>';
      conflict.parentNode.insertBefore(protectBanner, conflict.nextSibling);
    }
    return protectBanner;
  }
  function setBannerText(extra) {
    var msg = protectedNote ? 'Agent instruction file — the agent follows what is written here. Changes take effect in its next session.' : '';
    if (extra) msg = msg ? msg + ' ' + extra : extra;
    banner().querySelector('.ed-protected-text').textContent = msg;
    banner().hidden = !msg;
  }
  function setProtected(reason) { protectedNote = true; if (reason) banner().title = reason; if (autosave) pauseAutosave(); else setBannerText(); }
  function pauseAutosave() {
    autosaveBlocked = true; clearTimeout(autosaveTimer);
    setBannerText('Autosave is off for this file: save it yourself (Ctrl+S) and confirm.');
  }
  function confirmDialog(j, verb, onConfirm) {
    modalOpen = true; modalHost.hidden = false;
    var warnings = (j.warnings || []).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('');
    modalHost.innerHTML = '<div class="modal-container mod-dim"><div class="modal-bg"></div><div class="modal ed-confirm" role="alertdialog" aria-modal="true" aria-labelledby="edConfirmTitle">'
      + '<div class="modal-title" id="edConfirmTitle">' + esc(verb) + ' “' + esc(E.rel) + '”?</div>'
      + '<div class="modal-content"><p>' + esc(j.reason || j.error || 'This file needs confirmation.') + '</p>'
      + (warnings ? '<ul class="ed-confirm-warnings">' + warnings + '</ul>' : '') + '</div>'
      + '<div class="modal-button-container"><button type="button" class="ed-btn mod-warning" data-act="ok">' + esc(verb) + ' anyway</button><button type="button" class="ed-btn" data-act="cancel">Cancel</button></div>'
      + '</div></div>';
    var cancelBtn = modalHost.querySelector('[data-act="cancel"]');
    function done(ok) { closeModal(); if (ok) onConfirm(); else setStatus(verb + ' cancelled'); }
    modalHost.querySelector('[data-act="ok"]').addEventListener('click', function () { done(true); });
    cancelBtn.addEventListener('click', function () { done(false); });
    modalHost.querySelector('.modal-bg').addEventListener('click', function () { done(false); });
    modalHost.querySelector('.modal').addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); done(false); } });
    cancelBtn.focus();   // the safe choice is the default
  }

  // ---- save / create / autosave ----
  function save(force, opts) {
    opts = opts || {};
    if (!ed || saving || modalHost.querySelector('.ed-confirm')) return;
    saving = true; saveBtn.disabled = true; setStatus('Saving…');
    var text = ed.get();
    var body = { rel: E.rel, text: text }; if (!force) body.stamp = stamp;
    if (opts.confirm) body.confirm = 'instructions';
    return req('PUT', 'note', body).then(function (j) {
      saving = false; saveBtn.disabled = false;
      if (j._status === 409) { conflict.hidden = false; setStatus('Conflict: changed on disk', 'error'); return; }
      if (j._status === 428) {
        if (j.protected && !protectedNote) setProtected(j.reason);
        if (opts.auto) { pauseAutosave(); setStatus('Not saved: needs confirmation', 'dirty'); return; }
        setStatus('Waiting for confirmation…', 'dirty');
        confirmDialog(j, 'Save', function () { save(force, { confirm: true }); });
        return;
      }
      if (j._status !== 200 && j._status !== 201) { setStatus(j.error || 'Save failed', 'error'); return; }
      conflict.hidden = true; stamp = j.stamp; exists = true;
      if (ed.get() === text) setDirty(false); else scheduleAutosave();
      setStatus((j.created ? 'Created ' : 'Saved ') + new Date().toLocaleTimeString());
      delBtn.disabled = false; viewLink.hidden = false; viewLink.href = j.url;
      if (j.created) { document.getElementById('edPath').textContent = E.rel; addToSidebar(j); notesP = null; }
      else { var a = sidebar.querySelector('.nav-note.is-current'); if (a && j.title) a.textContent = j.title; }
    }, function (e) { saving = false; saveBtn.disabled = false; setStatus('Save failed: ' + e.message, 'error'); });
  }
  // Obsidian saves as you type; here it is opt-in per browser, because every save publishes the page.
  var autosave = store('ws-autosave') === true, autosaveTimer = null;
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    if (autosave && exists && conflict.hidden && !autosaveBlocked) autosaveTimer = setTimeout(function () { if (dirty) save(false, { auto: true }); }, 2000);
  }
  function toggleAutosave() { autosave = !autosave; store('ws-autosave', autosave); setStatus(autosave ? 'Autosave on (2 s after you stop typing)' : 'Autosave off'); if (autosave && dirty) scheduleAutosave(); }
  function addToSidebar(j) {
    var a = document.createElement('a'); a.className = 'nav-note is-current'; a.href = j.editUrl; a.setAttribute('data-rel', j.rel); a.textContent = j.title || j.rel;
    sidebar.querySelector('.nav').appendChild(a);
  }
  saveBtn.addEventListener('click', function () { save(false); });
  document.getElementById('edReload').addEventListener('click', function () { if (confirm('Discard your changes and load the version on disk?')) { dirty = false; location.reload(); } });
  document.getElementById('edOverwrite').addEventListener('click', function () { save(true); });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ---- new / delete ----
  function newNote() {
    var folder = E.rel.indexOf('/') >= 0 ? E.rel.slice(0, E.rel.lastIndexOf('/') + 1) : '';
    var p = prompt('Path of the new note (folders are created as needed):', folder + 'Untitled');
    if (!p) return;
    if (dirty && !confirm('Discard unsaved changes?')) return;
    dirty = false;
    location.href = editUrl(p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
  }
  document.getElementById('edNew').addEventListener('click', newNote);
  function deleteNote(confirmed) {
    if (!exists || (confirmed !== true && !confirm('Move “' + E.rel + '” to the vault’s .trash folder?'))) return;
    req('DELETE', 'note?rel=' + encodeURIComponent(E.rel) + (confirmed === true ? '&confirm=instructions' : '')).then(function (j) {
      if (j._status === 428) { confirmDialog(j, 'Delete', function () { deleteNote(true); }); return; }
      if (!j.ok) { setStatus(j.error || 'Delete failed', 'error'); return; }
      dirty = false; location.href = E.base + '_edit/';
    });
  }
  delBtn.addEventListener('click', deleteNote);

  // ---- suggest modal (quick switcher, command palette), with Obsidian's DOM ----
  var modalHost = document.getElementById('edModal'), modalOpen = false;
  function closeModal() { modalHost.hidden = true; modalHost.innerHTML = ''; modalOpen = false; if (ed && mode !== 'preview') ed.focus(); }
  function suggestModal(o) {
    // o: { placeholder, search(query) -> [{ title, note, aux, run(ev) }], instructions: [[keys, text]], onCreate(query, ev) }
    modalOpen = true; modalHost.hidden = false;
    modalHost.innerHTML = '<div class="modal-container mod-dim"><div class="modal-bg"></div><div class="prompt" role="dialog" aria-label="' + esc(o.placeholder) + '">'
      + '<div class="prompt-input-container"><input class="prompt-input" dir="auto" type="text" autocomplete="off" spellcheck="false" placeholder="' + esc(o.placeholder) + '"></div>'
      + '<div class="prompt-results" role="listbox"></div>'
      + '<div class="prompt-instructions">' + (o.instructions || []).map(function (i) { return '<div class="prompt-instruction"><span class="prompt-instruction-command">' + esc(i[0]) + '</span><span>' + esc(i[1]) + '</span></div>'; }).join('') + '</div></div></div>';
    var input = modalHost.querySelector('.prompt-input'), results = modalHost.querySelector('.prompt-results');
    var items = [], sel = 0;
    function draw() {
      var q = input.value; items = o.search(q) || []; sel = Math.min(sel, Math.max(0, items.length - 1));
      results.innerHTML = items.length ? items.map(function (it, i) {
        return '<div class="suggestion-item mod-complex' + (i === sel ? ' is-selected' : '') + '" role="option" data-i="' + i + '"><div class="suggestion-content"><div class="suggestion-title">' + esc(it.title) + '</div>'
          + (it.note ? '<div class="suggestion-note">' + esc(it.note) + '</div>' : '') + '</div>' + (it.aux ? '<div class="suggestion-aux"><kbd class="suggestion-hotkey">' + esc(it.aux) + '</kbd></div>' : '') + '</div>';
      }).join('') : '<div class="suggestion-empty">' + (o.onCreate && q.trim() ? 'No match. Press Shift+Enter to create “' + esc(q.trim()) + '”.' : 'No matches.') + '</div>';
    }
    function move(d) { if (!items.length) return; sel = (sel + d + items.length) % items.length; draw(); var el = results.querySelector('.is-selected'); if (el) el.scrollIntoView({ block: 'nearest' }); }
    function choose(i, ev) { var it = items[i]; closeModal(); if (it) it.run(ev || {}); }
    var lastQ = '';
    function changed() { if (input.value !== lastQ) { lastQ = input.value; sel = 0; draw(); } }
    input.addEventListener('input', changed);
    input.addEventListener('keyup', changed);   // IMEs and some input methods skip the input event
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); move(-1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey && o.onCreate && input.value.trim()) { var q = input.value.trim(); closeModal(); o.onCreate(q, e); }
        else choose(sel, e);
      }
    });
    results.addEventListener('mousedown', function (e) { e.preventDefault(); });
    results.addEventListener('click', function (e) { var el = e.target.closest('.suggestion-item'); if (el) choose(Number(el.getAttribute('data-i')), e); });
    modalHost.querySelector('.modal-bg').addEventListener('click', closeModal);
    draw(); input.focus();
    return { redraw: draw };
  }
  function match(q, list, keys, limit) {
    if (cmModule && cmModule.fuzzyFilter) return cmModule.fuzzyFilter(q, list, keys, limit);
    var words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return list.filter(function (it) { var hay = keys.map(function (k) { return String(it[k[0]] || ''); }).join(' ').toLowerCase(); return words.every(function (w) { return hay.indexOf(w) >= 0; }); }).slice(0, limit);
  }

  function rememberRecent(rel) { var r = (store('ws-recent-' + E.site) || []).filter(function (x) { return x !== rel; }); r.unshift(rel); store('ws-recent-' + E.site, r.slice(0, 30)); }
  function quickSwitcher() {
    var list = null;
    var m = suggestModal({
      placeholder: 'Find or create a note…',
      instructions: [['↑↓', 'to navigate'], ['↵', 'to open'], ['ctrl ↵', 'to open in new tab'], ['shift ↵', 'to create'], ['esc', 'to dismiss']],
      search: function (q) {
        if (!list) return [];
        var hits;
        if (!q.trim()) {
          var recent = store('ws-recent-' + E.site) || [];
          var byRel = {}; list.forEach(function (n) { byRel[n.rel] = n; });
          hits = recent.map(function (r) { return byRel[r]; }).filter(Boolean);
          list.slice().sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); }).forEach(function (n) { if (hits.indexOf(n) < 0) hits.push(n); });
          hits = hits.slice(0, 50);
        } else hits = match(q, list, [['name', 1], ['title', 0.95], ['rel', 0.7], ['aliasText', 0.8]], 50);
        return hits.map(function (n) {
          return { title: n.title, note: n.rel.replace(/\.md$/i, '') + (n.hidden ? ' · not published' : ''), run: function (ev) { go(editUrl(n.rel), !!(ev.ctrlKey || ev.metaKey)); } };
        });
      },
      onCreate: function (q, ev) { go(editUrl(q.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')), !!(ev.ctrlKey || ev.metaKey)); },
    });
    notes().then(function (n) {
      list = n.map(function (x) { return Object.assign({ name: x.rel.replace(/^.*\//, '').replace(/\.md$/i, ''), aliasText: (x.aliases || []).join(' ') }, x); });
      if (modalOpen) m.redraw();
    });
  }

  var pageCommands = [
    { id: 'app:save', name: 'Save current file', aux: 'Ctrl + S', run: function () { save(false); } },
    { id: 'app:toggle-reading', name: 'Toggle reading view', aux: 'Ctrl + E', run: toggleReading },
    { id: 'app:toggle-live-preview', name: 'Toggle Live Preview/Source mode', run: toggleLivePreview, when: function () { return ed && ed.setLivePreview; } },
    { id: 'app:split', name: 'Show editor and preview side by side', run: function () { setMode('split'); } },
    { id: 'app:editor-only', name: 'Show editor only', run: function () { setMode('edit'); } },
    { id: 'switcher:open', name: 'Quick switcher: Open quick switcher', aux: 'Ctrl + O', run: quickSwitcher },
    { id: 'app:new-note', name: 'Create new note', aux: 'Ctrl + Alt + N', run: newNote },
    { id: 'app:delete-file', name: 'Delete current file', run: deleteNote },
    { id: 'app:open-published', name: 'Open published page', run: function () { window.open(viewLink.href, '_blank'); } },
    { id: 'app:toggle-autosave', name: 'Toggle autosave', run: toggleAutosave },
    { id: 'app:toggle-sidebar', name: 'Toggle left sidebar', run: toggleSidebar },
    { id: 'theme:toggle', name: 'Toggle light/dark theme', run: toggleTheme },
    { id: 'graph:open', name: 'Graph view: Open graph view', run: function () { window.open(E.base + '_graph?focus=' + encodeURIComponent(E.rel), '_blank'); } },
    { id: 'app:use-textarea', name: 'Reload with the plain text editor', run: function () { location.search = '?textarea=1'; } },
  ];
  function commandPalette() {
    var recent = store('ws-recent-commands') || [];
    var all = pageCommands.filter(function (c) { return !c.when || c.when(); }).concat((ed && ed.commands || []).map(function (c) { return { id: c.id, name: 'Editor: ' + c.name, aux: c.hotkey, run: c.run }; }));
    suggestModal({
      placeholder: 'Select a command…',
      instructions: [['↑↓', 'to navigate'], ['↵', 'to use'], ['esc', 'to dismiss']],
      search: function (q) {
        var hits = q.trim() ? match(q, all, [['name', 1]], 60) : recent.map(function (id) { return all.filter(function (c) { return c.id === id; })[0]; }).filter(Boolean).concat(all.filter(function (c) { return recent.indexOf(c.id) < 0; }));
        return hits.map(function (c) { return { title: c.name, aux: c.aux, run: function () { store('ws-recent-commands', [c.id].concat(recent.filter(function (x) { return x !== c.id; })).slice(0, 12)); c.run(); } }; });
      },
    });
  }

  // ---- page hotkeys (Obsidian's): work in the editor and outside it ----
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey; if (!mod) return;
    var k = e.key.toLowerCase();
    if (modalOpen && k !== 's') return;
    if (k === 's' && !e.altKey && !e.shiftKey) { e.preventDefault(); save(false); }
    else if (k === 'e' && !e.altKey && !e.shiftKey) { e.preventDefault(); toggleReading(); }
    else if (k === 'o' && !e.altKey && !e.shiftKey) { e.preventDefault(); quickSwitcher(); }
    else if (k === 'p' && !e.altKey && !e.shiftKey) { e.preventDefault(); commandPalette(); }
    else if (e.altKey && k === 'n') { e.preventDefault(); newNote(); }
  });

  // ---- textarea fallback: Tab indents, [[ autocompletes note names ----
  ta.addEventListener('input', function () { if (ed && ed.kind === 'textarea') { onEdit(); autocomplete(); } });
  ta.addEventListener('keydown', function (e) {
    if (!complete.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape')) {
      var items = complete.querySelectorAll('button'); if (!items.length) return;
      var i = Array.prototype.findIndex.call(items, function (b) { return b.classList.contains('is-active'); });
      if (e.key === 'Escape') { complete.hidden = true; e.preventDefault(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { i = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items.forEach(function (b, k) { b.classList.toggle('is-active', k === i); }); e.preventDefault(); return; }
      items[Math.max(0, i)].click(); e.preventDefault(); return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      ta.setRangeText(S.useTab === false ? new Array((S.tabSize || 4) + 1).join(' ') : '\t', ta.selectionStart, ta.selectionEnd, 'end'); onEdit();
    }
  });
  function wikiContext() {
    var s = ta.selectionStart, before = ta.value.slice(Math.max(0, s - 120), s);
    var open = before.lastIndexOf('[[');
    if (open < 0 || before.indexOf(']]', open) >= 0 || /[\n|#]/.test(before.slice(open + 2))) return null;
    return { start: s - (before.length - open - 2), query: before.slice(open + 2) };
  }
  function autocomplete() {
    var ctx = wikiContext();
    if (!ctx) { complete.hidden = true; return; }
    notes().then(function (list) {
      if (!wikiContext()) return;
      var q = ctx.query.toLowerCase();
      var hits = list.filter(function (n) { return n.rel !== E.rel && (n.title.toLowerCase().indexOf(q) >= 0 || n.rel.toLowerCase().indexOf(q) >= 0); }).slice(0, 8);
      if (!hits.length) { complete.hidden = true; return; }
      complete.innerHTML = '<span class="muted">Link to:</span>' + hits.map(function (n, i) { return '<button type="button" class="' + (i === 0 ? 'is-active' : '') + '" data-name="' + esc(n.rel.replace(/\.md$/i, '')) + '" title="' + esc(n.rel) + '">' + esc(n.title) + '</button>'; }).join('');
      complete.hidden = false;
      complete.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
        b.addEventListener('click', function () {
          var name = b.getAttribute('data-name'); var base = name.replace(/.*\//, '');
          // Obsidian's shortest-unique rule: use the bare name unless another note shares it.
          var dup = list.filter(function (n) { return n.rel.replace(/.*\//, '').replace(/\.md$/i, '').toLowerCase() === base.toLowerCase(); }).length > 1;
          var cur2 = wikiContext(); if (!cur2) return;
          ta.setRangeText((dup ? name : base) + ']]', cur2.start, ta.selectionStart, 'end');
          complete.hidden = true; ta.focus(); onEdit();
        });
      });
    });
  }
  ta.addEventListener('blur', function () { setTimeout(function () { complete.hidden = true; }, 150); });
})();
