(function () {
  'use strict';
  // Editor page (/<site>/_edit/…). The note editor itself is CodeMirror 6
  // (/_static/cm/editor.js, loaded through the import map); if it cannot load,
  // the page falls back to the plain textarea. Everything here — load, save,
  // conflicts, preview, quick switcher, command palette, status bar — works
  // with either engine through the small `ed` adapter.
  var E = window.WEBSIDIAN_EDIT || window.MD2HTML_EDIT; if (!E) return;
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
    return fetch(api + path, { method: method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'websidian' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (j) { if (j && typeof j === 'object') j._status = r.status; return j; }, function () { return { _status: r.status, error: 'HTTP ' + r.status }; }); });
  }
  function getJson(path) { return req('GET', path).then(function (j) { if (j && j._status && j._status !== 200) throw new Error(j.error || 'HTTP ' + j._status); return j; }); }
  function notes() { return notesP || (notesP = getJson('notes').catch(function () { notesP = null; return []; })); }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  function editUrl(rel) { return E.base + '_edit/' + rel.replace(/\.md$/i, '').split('/').map(encodeURIComponent).join('/'); }

  // ---- theme (same preference as the viewer) ----
  try { var saved = localStorage.getItem('websidian-theme') || localStorage.getItem('md2html-theme'); if (saved) root.setAttribute('data-theme', saved); } catch (e) {}
  var isDark = function () { return root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches); };
  function syncThemeClass() { document.body.classList.toggle('theme-dark', isDark()); document.body.classList.toggle('theme-light', !isDark()); }
  syncThemeClass();
  function toggleTheme() {
    var next = isDark() ? 'light' : 'dark'; root.setAttribute('data-theme', next);
    try { localStorage.setItem('websidian-theme', next); } catch (e) {}
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
    if (persist !== false) store('websidian-edit-mode', m);
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
  // Replace [from, to) in the textarea, keeping the browser's own undo stack.
  function taReplaceRange(from, to, text) {
    ta.focus();
    ta.setSelectionRange(from, to);
    // execCommand keeps the browser's own undo stack; setting .value would not.
    if (!document.execCommand || !document.execCommand('insertText', false, text)) {
      ta.value = ta.value.slice(0, from) + text + ta.value.slice(to);
      onEdit();                                        // no input event fires from setting .value
    }
    ta.setSelectionRange(from + text.length, from + text.length);
  }
  // A YAML scalar, quoted only where YAML would otherwise read it differently.
  // The CodeMirror engine reuses the Properties panel's own serializer instead.
  function yamlish(v) {
    var s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim();
    if (s === '') return '';
    return /^[\s\-?:,[\]{}#&*!|>'"%@`]|\s$|: | #|^\[\[|^(true|false|yes|no|on|off|null|~|-?\d+(\.\d+)?)$/i.test(s) ? JSON.stringify(s) : s;
  }
  // The frontmatter block's YAML body, by offset. A textarea's value is \n-only.
  function taFrontmatter() {
    var src = ta.value;
    if (!/^---[ \t]*\n/.test(src)) return null;
    var bodyStart = src.indexOf('\n') + 1;
    var close = /\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(src.slice(bodyStart - 1));
    if (!close) return null;
    var bodyEnd = bodyStart - 1 + close.index;
    return { bodyStart: bodyStart, bodyEnd: bodyEnd, body: bodyEnd <= bodyStart ? '' : src.slice(bodyStart, bodyEnd) };
  }
  function textareaAdapter() {
    return {
      kind: 'textarea',
      get: function () { return ta.value; },
      set: function (t) { ta.value = t; },
      focus: function () { ta.focus(); },
      selectedText: function () { return ta.value.slice(ta.selectionStart, ta.selectionEnd); },
      replaceSelection: function (text) {
        text = String(text).replace(/\r\n?/g, '\n');   // a textarea value is \n-only too
        var whole = ta.selectionStart === ta.selectionEnd;
        var from = whole ? 0 : ta.selectionStart, to = whole ? ta.value.length : ta.selectionEnd;
        taReplaceRange(from, to, text);
        ta.setSelectionRange(from, from + text.length);
      },
      // Insert at the caret without touching the rest of the note.
      insertAtCursor: function (text) { taReplaceRange(ta.selectionStart, ta.selectionEnd, String(text).replace(/\r\n?/g, '\n')); },
      // Set (or add) one frontmatter property as a single undoable edit.
      setFrontmatter: function (key, value) {
        var line = key + ': ' + yamlish(value), fm = taFrontmatter();
        if (!fm) { taReplaceRange(0, 0, '---\n' + line + '\n---\n\n'); return true; }
        if (fm.body === '') { taReplaceRange(fm.bodyStart, fm.bodyStart, line + '\n'); return true; }
        var re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':[ \\t]*.*$', 'm');
        var hit = re.exec(fm.body);
        if (hit) taReplaceRange(fm.bodyStart + hit.index, fm.bodyStart + hit.index + hit[0].length, line);
        else taReplaceRange(fm.bodyEnd, fm.bodyEnd, '\n' + line);
        return true;
      },
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
    var savedMode = store('websidian-edit-mode') || store('md2html-edit-mode');
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
    whenReady(function () { return !!window.websidianExcalidraw; }, function () { window.websidianExcalidraw.mount(el); }, 30);
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

  // ---- Obsidian-style popup menu (.menu / .menu-item / .menu-separator) ----
  // One implementation for the Writing help dropdown and the editor's
  // right-click menu, using the class names Obsidian gives its context menus so
  // a vault's theme or snippet styles both of them.
  //
  // An item is { label, icon?, aux?, title?, run } or one of the non-clickable
  // rows { separator: true } / { header: true, label } / { info: true, label }.
  var openMenu = null;
  function closeMenu() {
    if (!openMenu) return;
    var m = openMenu; openMenu = null;
    document.removeEventListener('pointerdown', m.onOutside, true);
    document.removeEventListener('keydown', m.onKey, true);
    window.removeEventListener('resize', closeMenu);
    window.removeEventListener('blur', closeMenu);
    if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
    if (m.owner) m.owner.setAttribute('aria-expanded', 'false');
    if (m.refocus && ed && mode !== 'preview') ed.focus();
  }
  function obsidianMenu(items, opts) {
    opts = opts || {};
    closeMenu();
    var el = document.createElement('div');
    el.className = 'menu ws-menu';
    el.setAttribute('role', 'menu');
    if (opts.label) el.setAttribute('aria-label', opts.label);
    el.tabIndex = -1;
    var rows = [], sel = -1;
    function select(i) {
      if (i < 0 || i >= rows.length) return;
      if (rows[sel]) rows[sel].classList.remove('selected');
      sel = i; rows[sel].classList.add('selected');
      rows[sel].scrollIntoView({ block: 'nearest' });
    }
    function move(d) { if (rows.length) select(((sel < 0 ? (d > 0 ? -1 : 0) : sel) + d + rows.length) % rows.length); }
    items.forEach(function (it) {
      var d = document.createElement('div');
      if (it.separator) { d.className = 'menu-separator'; el.appendChild(d); return; }
      if (it.header) { d.className = 'menu-item mod-section-title'; d.textContent = it.label; el.appendChild(d); return; }
      if (it.info) { d.className = 'menu-info'; d.textContent = it.label; el.appendChild(d); return; }
      d.className = 'menu-item tappable';
      d.setAttribute('role', 'menuitem');
      if (it.title) d.title = it.title;
      var icon = document.createElement('div'); icon.className = 'menu-item-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = it.icon || '';
      var name = document.createElement('div'); name.className = 'menu-item-title'; name.textContent = it.label;
      d.appendChild(icon); d.appendChild(name);
      if (it.aux) { var a = document.createElement('div'); a.className = 'menu-item-aux'; a.textContent = it.aux; d.appendChild(a); }
      d.addEventListener('mouseenter', function () { select(rows.indexOf(d)); });
      d.addEventListener('click', function (ev) { ev.preventDefault(); closeMenu(); it.run(ev); });
      el.appendChild(d); rows.push(d);
    });
    document.body.appendChild(el);

    // Place it: under the anchor button, or at the pointer for a right-click.
    var w = el.offsetWidth, h = el.offsetHeight, x = opts.x || 0, y = opts.y || 0;
    if (opts.anchor) { var r = opts.anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 4; if (x + w > window.innerWidth - 8) x = r.right - w; }
    el.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';

    function onOutside(e) { if (el.contains(e.target) || (opts.anchor && opts.anchor.contains(e.target))) return; closeMenu(); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); move(-1); }
      else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); select(0); }
      else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); select(rows.length - 1); }
      else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); move(e.shiftKey ? -1 : 1); }
      else if ((e.key === 'Enter' || e.key === ' ') && sel >= 0) { e.preventDefault(); e.stopPropagation(); rows[sel].click(); }
    }
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);
    openMenu = { el: el, onOutside: onOutside, onKey: onKey, owner: opts.anchor || null, refocus: opts.refocus !== false, kind: opts.kind || '' };
    if (openMenu.owner) openMenu.owner.setAttribute('aria-expanded', 'true');
    el.focus();
    if (opts.selectFirst !== false) select(0);
    return openMenu;
  }

  // ---- writing help (only present when the server has `assist` configured) ----
  var assistMenu = null, assistBtn = null, assistBusy = false, assistDoneTimer = null;
  function loadAssist() {
    return req('GET', 'assist').then(function (j) {
      if (j && j._status === 200 && j.actions && j.actions.length) { assistMenu = j; mountAssistButton(); }
    }, function () { /* not configured: no button, no commands, no noise */ });
  }
  function assistReady() { return !!assistMenu && !!ed && !!ed.replaceSelection; }

  // The top bar button. Built here rather than in the page's HTML so that a
  // site without `assist` has nothing to hide — there is no button at all.
  function mountAssistButton() {
    if (assistBtn) return;
    var bar = document.querySelector('.editor-topbar'); if (!bar) return;
    assistBtn = document.createElement('button');
    assistBtn.type = 'button';
    assistBtn.id = 'edAssist';
    assistBtn.className = 'ed-btn ed-assist';
    assistBtn.setAttribute('aria-haspopup', 'menu');
    assistBtn.setAttribute('aria-expanded', 'false');
    assistBtn.title = 'Writing help (Alt+W) — rewrite the selection, or the whole note when nothing is selected';
    setAssistLabel('idle');
    assistBtn.addEventListener('click', function () {
      if (openMenu && openMenu.owner === assistBtn) { closeMenu(); return; }
      openAssistMenu();
    });
    bar.insertBefore(assistBtn, document.getElementById('edNew'));
  }
  function setAssistLabel(state) {
    if (!assistBtn) return;
    assistBtn.classList.toggle('is-working', state === 'working');
    assistBtn.classList.toggle('is-done', state === 'done');
    assistBtn.textContent = state === 'working' ? '⟳ Working…' : state === 'done' ? '✓ Done' : '✦ Writing help ▾';
  }
  function assistWorking(on) {
    if (!assistBtn) return;
    clearTimeout(assistDoneTimer);
    assistBtn.disabled = !!on;
    setAssistLabel(on ? 'working' : 'idle');
  }
  function assistDone() {
    if (!assistBtn) return;
    setAssistLabel('done');
    assistDoneTimer = setTimeout(function () { setAssistLabel('idle'); }, 1600);
  }

  // What an action will be given: the selection, or the note when there is none.
  function assistScope() {
    var sel = ed && ed.selectedText ? ed.selectedText() : '';
    if (!sel) return 'Whole note';
    var w = counts(sel).words;
    return 'Selection · ' + w + (w === 1 ? ' word' : ' words');
  }
  // Rewrites first, then the suggestions, the way the palette lists them.
  function assistActionItems() {
    var rewrites = [], suggestions = [];
    assistMenu.actions.forEach(function (a) { (a.replaces === false ? suggestions : rewrites).push(a); });
    var item = function (a) {
      return {
        icon: a.replaces === false ? '☆' : '✦',
        label: a.label + (a.needsTarget ? '…' : ''),
        title: a.replaces === false ? 'Shows a suggestion; the note is not changed' : 'Replaces ' + assistScope().toLowerCase() + ' as one undoable change',
        run: function () { runAssist(a); },
      };
    };
    var items = rewrites.map(item);
    if (rewrites.length && suggestions.length) items.push({ separator: true });
    return items.concat(suggestions.map(item));
  }
  function openAssistMenu() {
    if (!assistReady()) return;
    if (assistBusy) { setStatus('Writing help is already working — wait for it to finish.', 'dirty'); return; }
    var items = [{ header: true, label: assistScope() }, { separator: true }]
      .concat(assistActionItems())
      .concat([{ separator: true }, { info: true, label: assistMenu.model + (assistMenu.backend && assistMenu.backend !== assistMenu.model ? ' · ' + assistMenu.backend : '') }]);
    obsidianMenu(items, { anchor: assistBtn, label: 'Writing help', kind: 'assist' });
  }
  function toggleAssistMenu() {
    if (openMenu && openMenu.kind === 'assist') { closeMenu(); return; }
    if (!assistReady()) { setStatus('Writing help is not configured for this site.'); return; }
    openAssistMenu();
  }

  function runAssist(action) {
    if (!ed) return;
    if (assistBusy) { setStatus('Writing help is already working — wait for it to finish.', 'dirty'); return; }
    assistBusy = true;
    var sel = ed.selectedText ? ed.selectedText() : '';
    var whole = !sel;
    var text = whole ? ed.get() : sel;
    var body = { action: action.id, text: text, title: (E.rel || '').replace(/.*\//, '').replace(/\.md$/i, '') };

    var go = Promise.resolve();
    if (action.needsTarget) {
      go = pickLanguage().then(function (lang) {
        if (!lang) return Promise.reject({ cancelled: true });
        body.target = lang;
      });
    }

    go.then(function () {
      assistWorking(true);
      setStatus((whole ? 'Whole note' : 'Selection') + ' — ' + action.label.toLowerCase() + '…');
      return req('POST', 'assist', body);
    }).then(function (j) {
      assistBusy = false; assistWorking(false);
      if (!j || j._status !== 200) throw new Error((j && j.error) || 'Failed');
      if (j.replaces === false) {
        // A suggestion, not a replacement: show it so it can be read, copied
        // and used; the note is not touched until a button here says so.
        suggestionModal(action, j.text);
        setStatus(action.label + ' — suggestion ready', 'ok');
        assistDone();
        return;
      }
      ed.replaceSelection(j.text);
      setStatus(action.label + ' — Ctrl+Z to undo', 'ok');
      assistDone();
    }).catch(function (e) {
      assistBusy = false; assistWorking(false);
      if (e && e.cancelled) return setStatus('');
      setStatus((e && e.message) || 'The writing help failed', 'error');
    });
  }

  // Built-in suggestion actions that map onto a frontmatter property.
  var SUGGEST_PROPERTY = { title: 'title', describe: 'description', description: 'description' };

  // A suggestion (`replaces: false`) in Obsidian's modal DOM, so it can be read
  // in full, copied, inserted, or written into the frontmatter.
  function suggestionModal(action, text) {
    var key = SUGGEST_PROPERTY[action.id] || null;
    modalOpen = true; modalHost.hidden = false;
    modalHost.innerHTML = '<div class="modal-container mod-dim"><div class="modal-bg"></div><div class="modal ed-suggest" role="dialog" aria-modal="true" aria-labelledby="edSuggestTitle">'
      + '<div class="modal-title" id="edSuggestTitle">' + esc(action.label) + '</div>'
      + '<div class="modal-content"><p class="ed-suggest-text" dir="auto">' + esc(text) + '</p>'
      + '<p class="ed-suggest-note muted">Nothing has been written to the note.</p></div>'
      + '<div class="modal-button-container">'
      + (key ? '<button type="button" class="ed-btn ed-primary" data-act="prop">Use as ' + esc(key) + '</button>' : '')
      + '<button type="button" class="ed-btn" data-act="insert">Insert at cursor</button>'
      + '<button type="button" class="ed-btn" data-act="copy">Copy</button>'
      + '<button type="button" class="ed-btn" data-act="close">Close</button>'
      + '</div></div></div>';
    var act = function (name, fn) { var b = modalHost.querySelector('[data-act="' + name + '"]'); if (b) b.addEventListener('click', fn); };
    act('copy', function () { copyToClipboard(text); });
    act('insert', function () {
      closeModal();
      if (ed && ed.insertAtCursor) { ed.insertAtCursor(text); setStatus(action.label + ' inserted — Ctrl+Z to undo', 'ok'); }
      else setStatus('This editor cannot insert at the cursor — copy the text instead.', 'error');
    });
    act('prop', function () {
      closeModal();
      if (ed && ed.setFrontmatter) { ed.setFrontmatter(key, text); setStatus('Set ' + key + ': — Ctrl+Z to undo', 'ok'); }
      else setStatus('This editor cannot edit the frontmatter — copy the text instead.', 'error');
    });
    act('close', closeModal);
    modalHost.querySelector('.modal-bg').addEventListener('click', closeModal);
    modalHost.querySelector('.modal').addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); closeModal(); } });
    var first = modalHost.querySelector('.modal-button-container .ed-btn'); if (first) first.focus();
  }
  function copyToClipboard(text) {
    var ok = function () { setStatus('Copied to the clipboard', 'ok'); };
    var fallback = function () {
      var box = document.createElement('textarea');
      box.value = text; box.setAttribute('readonly', ''); box.style.position = 'fixed'; box.style.opacity = '0';
      document.body.appendChild(box); box.select();
      try { document.execCommand('copy'); ok(); } catch (e) { setStatus('Could not copy — select the text and copy it yourself.', 'error'); }
      document.body.removeChild(box);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }

  // ---- right-click inside the editor ----
  // Only when writing help is available: with it off the browser's own menu
  // (which has a working Cut/Copy/Paste) is left exactly as it is.
  function edCommand(id, fallback) {
    var list = (ed && ed.commands) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].run;
    return fallback;
  }
  function editorContextMenu(e) {
    if (!assistReady() || e.shiftKey) return;            // Shift+right-click always gets the native menu
    var t = e.target;
    // Widgets (Properties, tables) have their own fields; there Paste matters
    // more than this menu does, so the browser keeps them.
    if (t && t.closest && t !== ta && t.closest('input, textarea, select, .ws-table, .metadata-container, .metadata-properties')) return;
    e.preventDefault();
    var items = [{ header: true, label: assistScope() }, { separator: true }]
      .concat(assistActionItems())
      .concat([
        { separator: true },
        { icon: '↶', label: 'Undo', aux: 'Ctrl+Z', run: edCommand('editor:undo', function () { ed.focus(); try { document.execCommand('undo'); } catch (err) {} }) },
        { icon: '↷', label: 'Redo', aux: 'Ctrl+Shift+Z', run: edCommand('editor:redo', function () { ed.focus(); try { document.execCommand('redo'); } catch (err) {} }) },
        { separator: true },
        { icon: '▤', label: 'Select all', aux: 'Ctrl+A', run: edCommand('editor:select-all', function () { ta.focus(); ta.select(); }) },
      ]);
    obsidianMenu(items, { x: e.clientX, y: e.clientY, label: 'Editor', kind: 'context' });
  }
  cmHost.addEventListener('contextmenu', editorContextMenu);
  ta.addEventListener('contextmenu', editorContextMenu);

  // Small prompt for the one action that needs an argument. Uses the same
  // suggest modal as the quick switcher, so it looks and behaves the same.
  function pickLanguage() {
    var langs = (assistMenu && assistMenu.languages) || ['Arabic', 'English'];
    return new Promise(function (resolve) {
      var picked = false;
      suggestModal({
        placeholder: 'Translate into…',
        instructions: [['↑↓', 'to navigate'], ['↵', 'to translate'], ['esc', 'to cancel']],
        search: function (q) {
          var list = langs.filter(function (l) { return l.toLowerCase().indexOf(q.toLowerCase()) >= 0; });
          // Any language, not just the configured ones.
          if (q.trim() && list.indexOf(q.trim()) < 0) list = [q.trim()].concat(list);
          return list.map(function (l) {
            return { title: l, run: function () { picked = true; resolve(l); } };
          });
        },
      });
      // closeModal() empties the host; when that happens without a pick, cancel.
      var poll = setInterval(function () {
        if (modalOpen) return;
        clearInterval(poll);
        if (!picked) resolve(null);
      }, 120);
    });
  }

  var pageCommands = [
    // Ctrl+P is Obsidian's; in a browser it is also Print, so the palette has a
    // second, web-safe binding and both are shown here.
    { id: 'app:command-palette', name: 'Command palette: Open command palette', aux: 'Ctrl + P / Ctrl + Shift + P', run: function () { setTimeout(commandPalette, 0); } },
    { id: 'assist:menu', name: 'Writing help: Open the writing help menu', aux: 'Alt + W', run: function () { setTimeout(toggleAssistMenu, 0); }, when: function () { return assistReady(); } },
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

  // One palette entry per server-defined action. Nothing is added when the
  // server has no `assist` block, so this is invisible unless it is turned on.
  function assistCommands() {
    if (!assistMenu) return [];
    return assistMenu.actions.map(function (a) {
      return {
        id: 'assist:' + a.id,
        name: 'Writing help: ' + a.label,
        aux: assistMenu.model,
        run: function () { runAssist(a); },
        when: function () { return !!ed && !!ed.replaceSelection; },
      };
    });
  }
  function commandPalette() {
    var recent = store('ws-recent-commands') || [];
    var all = pageCommands.concat(assistCommands()).filter(function (c) { return !c.when || c.when(); }).concat((ed && ed.commands || []).map(function (c) { return { id: c.id, name: 'Editor: ' + c.name, aux: c.hotkey, run: c.run }; }));
    suggestModal({
      placeholder: 'Select a command…',
      instructions: [['↑↓', 'to navigate'], ['↵', 'to use'], ['esc', 'to dismiss']],
      search: function (q) {
        var hits = q.trim() ? match(q, all, [['name', 1]], 60) : recent.map(function (id) { return all.filter(function (c) { return c.id === id; })[0]; }).filter(Boolean).concat(all.filter(function (c) { return recent.indexOf(c.id) < 0; }));
        return hits.map(function (c) { return { title: c.name, aux: c.aux, run: function () { store('ws-recent-commands', [c.id].concat(recent.filter(function (x) { return x !== c.id; })).slice(0, 12)); c.run(); } }; });
      },
    });
  }

  // Ask once whether the server offers writing help. A 404 means it does not,
  // and no commands are added.
  loadAssist();

  // ---- page hotkeys (Obsidian's): work in the editor and outside it ----
  // Registered in the **capture** phase. In the bubble phase this ran last, so
  // anything nearer the key — CodeMirror's search panel, a widget's own input,
  // the prompt box — could stop the event first, and Ctrl+P then reached the
  // browser and opened the print dialog instead of the palette. In capture this
  // handler sees the key first and cancels it whatever has focus on this page.
  // (Inside an iframe, as in the Hermes dashboard, the outer page still prints
  // when the iframe does not have focus — hence the Writing help button and
  // Ctrl+Shift+P.)
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    var mod = e.ctrlKey || e.metaKey;
    // Alt+W opens the writing help menu. Nothing in Obsidian's keymap or
    // CodeMirror's binds it (see public/cm/commands.js).
    if (e.altKey && !mod && k === 'w') { e.preventDefault(); if (!modalOpen) toggleAssistMenu(); return; }
    if (!mod) return;
    if (openMenu) closeMenu();
    // Ctrl+P / Ctrl+Shift+P: always cancelled, so the print dialog never opens
    // while the editor page has focus, whether or not the palette can open.
    if (k === 'p' && !e.altKey) { e.preventDefault(); if (!modalOpen) commandPalette(); return; }
    if (e.shiftKey) return;
    if (k === 's' && !e.altKey) { e.preventDefault(); save(false); return; }   // Ctrl+S works with a dialog open, as before
    if (modalOpen) return;
    if (k === 'e' && !e.altKey) { e.preventDefault(); toggleReading(); }
    else if (k === 'o' && !e.altKey) { e.preventDefault(); quickSwitcher(); }
    else if (e.altKey && k === 'n') { e.preventDefault(); newNote(); }
  }, true);

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
