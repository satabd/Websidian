// The agent panel: talk to Claude Code, Codex, Hermes Agent or OpenClaw about the open note.
// Loaded only when the server has `agents` configured. Each agent keeps one conversation per
// note (or per vault, with `agents.sessionScope: "vault"`), held by the agent's own CLI, so a
// message sends only what you type — not the note, not the context, again.
(function () {
  'use strict';
  var W = window.WebsidianEditor;
  if (!W) return;
  var E = W.E, esc = W.esc, req = W.req;

  var menu = null, agent = null, mode = 'review', session = null, busy = null, pollTimer = null, tickTimer = null;
  var panel, log, input, sendBtn, stopBtn, pick, modeBox, statusLine, selChip, btn;

  function key(k) { return 'ws-agent-' + k; }
  function agentById(id) { return (menu.agents || []).filter(function (a) { return a.id === id; })[0] || null; }

  req('GET', 'agents').then(function (j) {
    if (!j || j._status !== 200 || !j.agents || !j.agents.length) return;
    menu = j; mount();
  }, function () {});

  // ---- layout ----
  function mount() {
    var bar = document.querySelector('.editor-topbar');
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ed-btn ed-agent-btn'; btn.id = 'edAgentBtn';
    btn.title = 'Agents (Alt+A) — review or edit this note with ' + menu.agents.map(function (a) { return a.label; }).join(', ');
    btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'edAgent');
    btn.textContent = '◈ Agents';
    btn.addEventListener('click', function () { toggle(); });
    bar.insertBefore(btn, document.getElementById('edNew'));

    panel = document.createElement('aside');
    panel.className = 'ed-agent'; panel.id = 'edAgent'; panel.hidden = true; panel.setAttribute('aria-label', 'Agent');
    panel.innerHTML =
      '<div class="ed-agent-head">'
      + '<select class="dropdown ed-agent-pick" aria-label="Agent"></select>'
      + '<div class="ed-agent-modes" role="group" aria-label="Mode"></div>'
      + '<span class="topbar-spacer"></span>'
      + '<button type="button" class="clickable-icon ed-agent-new" title="New conversation — the agent forgets this one">⟲</button>'
      + '<button type="button" class="clickable-icon ed-agent-close" title="Close (Alt+A)">✕</button>'
      + '</div>'
      + '<div class="ed-agent-log" aria-live="polite"></div>'
      + '<div class="ed-agent-foot">'
      + '<div class="ed-agent-context"><span class="ed-agent-sel" hidden></span><span class="ed-agent-status muted"></span></div>'
      + '<textarea class="ed-agent-input" rows="3" dir="auto" placeholder="Ask about this note…  (Enter to send, Shift+Enter for a new line)"></textarea>'
      + '<div class="ed-agent-actions"><button type="button" class="ed-btn ed-agent-stop" hidden>Stop</button><button type="button" class="ed-btn ed-primary ed-agent-send">Send</button></div>'
      + '</div>';
    document.body.appendChild(panel);
    log = panel.querySelector('.ed-agent-log'); input = panel.querySelector('.ed-agent-input');
    sendBtn = panel.querySelector('.ed-agent-send'); stopBtn = panel.querySelector('.ed-agent-stop');
    pick = panel.querySelector('.ed-agent-pick'); modeBox = panel.querySelector('.ed-agent-modes');
    statusLine = panel.querySelector('.ed-agent-status'); selChip = panel.querySelector('.ed-agent-sel');

    pick.innerHTML = menu.agents.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.label + (a.model ? ' · ' + a.model : '')) + '</option>'; }).join('');
    var saved = W.store(key('agent'));
    choose(agentById(saved) ? saved : menu.agents[0].id);
    pick.addEventListener('change', function () { choose(pick.value); });
    panel.querySelector('.ed-agent-close').addEventListener('click', function () { toggle(false); });
    panel.querySelector('.ed-agent-new').addEventListener('click', newConversation);
    sendBtn.addEventListener('click', send);
    stopBtn.addEventListener('click', stop);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      else if (e.key === 'Escape') { e.preventDefault(); toggle(false); }
    });
    document.addEventListener('selectionchange', updateSelection);
    document.addEventListener('keyup', updateSelection);
    document.addEventListener('mouseup', updateSelection);
    document.addEventListener('keydown', function (e) {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key || '').toLowerCase() === 'a') { e.preventDefault(); if (!W.isModalOpen()) toggle(); }
    }, true);
    W.addCommand({ id: 'agents:toggle', name: 'Agents: Toggle the agent panel', aux: 'Alt + A', run: function () { toggle(); } });
    W.addCommand({ id: 'agents:review', name: 'Agents: Review this note', run: function () { toggle(true); quick('review'); } });
    W.addCommand({ id: 'agents:new', name: 'Agents: Start a new conversation', run: function () { toggle(true); newConversation(); } });
    if (W.store(key('open')) === true) toggle(true);
  }

  // Under the top bar as it really is: on a phone it wraps onto two rows.
  function place() {
    var bar = document.querySelector('.editor-topbar'), foot = document.getElementById('edStatusBar');
    if (bar) panel.style.top = Math.max(0, bar.getBoundingClientRect().bottom) + 'px';
    if (foot) panel.style.bottom = foot.offsetHeight + 'px';
  }
  window.addEventListener('resize', function () { if (panel && !panel.hidden) place(); });
  function toggle(on) {
    var open = on === undefined ? panel.hidden : !!on;
    panel.hidden = !open;
    if (open) place();
    document.body.classList.toggle('agent-open', open);
    btn.setAttribute('aria-expanded', String(open)); btn.classList.toggle('is-active', open);
    W.store(key('open'), open);
    if (open) { updateSelection(); setTimeout(function () { input.focus(); }, 0); }
  }

  function choose(id) {
    agent = agentById(id); if (!agent) return;
    pick.value = id; W.store(key('agent'), id);
    var m = W.store(key('mode-' + id));
    mode = agent.modes.indexOf(m) >= 0 ? m : agent.modes[0];
    drawModes();
    loadSession();
  }

  function drawModes() {
    modeBox.innerHTML = agent.modes.length < 2 ? '<span class="ed-agent-mode-label" title="' + esc(modeHelp(agent.modes[0])) + '">' + (agent.modes[0] === 'edit' ? 'Edit' : 'Review') + '</span>'
      : agent.modes.map(function (m) { return '<button type="button" data-mode="' + m + '" class="' + (m === mode ? 'is-active' : '') + '" title="' + esc(modeHelp(m)) + '">' + (m === 'edit' ? 'Edit' : 'Review') + '</button>'; }).join('');
    modeBox.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { mode = b.getAttribute('data-mode'); W.store(key('mode-' + agent.id), mode); drawModes(); placeholder(); });
    });
    placeholder();
  }
  function modeHelp(m) {
    if (m === 'edit') return 'Edit: the agent may change files in the vault. Every change comes back as a diff you can revert.';
    return agent.enforcesReview ? 'Review: read-only. The agent cannot write to the vault.' : 'Review: the agent is asked not to write. ' + agent.label + ' cannot be locked to read-only, so any file it does change is shown here with a Revert button.';
  }
  function placeholder() { input.placeholder = (mode === 'edit' ? 'Ask ' + agent.label + ' to change this note…' : 'Ask ' + agent.label + ' about this note…') + '  (Enter to send, Shift+Enter for a new line)'; }

  // ---- the conversation ----
  function sessionPath() { return 'agents/' + encodeURIComponent(agent.id) + '/session?rel=' + encodeURIComponent(E.rel); }
  function loadSession() {
    log.innerHTML = ''; status('');
    return req('GET', sessionPath()).then(function (j) {
      if (j._status !== 200) { status(j.error || 'Could not load the conversation', 'error'); return; }
      session = j;
      var h = j.history || [];
      if (!h.length) { empty(); }
      else {
        var agentTexts = h.filter(function (m) { return m.role === 'agent'; }).map(function (m) { return m.text; });
        renderMany(agentTexts).then(function (html) {
          var k = 0;
          h.forEach(function (m) { if (m.role === 'user') addUser(m); else addAgent(m, html[k++], null); });
          scrollDown();
        });
      }
      sessionLine();
      // A turn that was still running when the page was left: pick it up again.
      var pending = sessionStorage.getItem(key('turn-' + agent.id + '-' + E.rel));
      if (pending) watch(pending);
    });
  }
  function sessionLine() {
    if (!session || !session.sessionId) status(menu.skills && menu.skills.length ? 'New conversation · skills: ' + menu.skills.join(', ') : 'New conversation');
    else status('Conversation of ' + session.turns + ' message' + (session.turns === 1 ? '' : 's') + (menu.scope === 'vault' ? ' across the vault' : ' about this note') + ' — the agent remembers it');
  }
  function empty() {
    var box = document.createElement('div'); box.className = 'ed-agent-empty';
    box.innerHTML = '<p class="muted">' + esc(agent.label) + ' reads the vault itself, with the Obsidian skills. Your first message tells it which note is open; after that it remembers the conversation.</p>'
      + '<div class="ed-agent-quick">'
      + '<button type="button" class="ed-btn" data-q="review">Review this note</button>'
      + '<button type="button" class="ed-btn" data-q="links">Check links and syntax</button>'
      + '<button type="button" class="ed-btn" data-q="related">Find related notes</button>'
      + (agent.modes.indexOf('edit') >= 0 ? '<button type="button" class="ed-btn" data-q="tidy">Tidy the frontmatter</button>' : '')
      + '</div>';
    box.querySelectorAll('[data-q]').forEach(function (b) { b.addEventListener('click', function () { quick(b.getAttribute('data-q')); }); });
    log.appendChild(box);
  }
  var QUICK = {
    review: ['review', 'Review this note: what is unclear, wrong, missing or out of date? Quote the lines you mean.'],
    links: ['review', 'Check this note\'s Obsidian syntax: broken [[wikilinks]] or embeds (look the targets up in the vault), malformed callouts, frontmatter or tables. List each problem with its fix.'],
    related: ['review', 'Which other notes in this vault are related to this one and should be linked from it? Give each as a [[wikilink]] with one line on why.'],
    tidy: ['edit', 'Tidy this note\'s frontmatter: consistent property names and types, a useful description and tags that already exist in the vault. Change nothing in the body.'],
  };
  function quick(k) {
    var q = QUICK[k]; if (!q) return;
    if (agent.modes.indexOf(q[0]) >= 0 && mode !== q[0]) { mode = q[0]; drawModes(); }
    input.value = q[1]; send();
  }

  function newConversation() {
    if (busy) { status(agent.label + ' is still working — stop it first.', 'error'); return; }
    if (session && session.turns && !confirm('Start a new conversation with ' + agent.label + '? It forgets this one.')) return;
    req('DELETE', sessionPath()).then(function () { session = null; log.innerHTML = ''; empty(); sessionLine(); input.focus(); });
  }

  function updateSelection() {
    if (!panel || panel.hidden) return;
    var t = W.selectedText();
    selChip.hidden = !t;
    if (t) selChip.textContent = 'Selection: ' + t.length + ' characters — sent with your message';
  }

  function send() {
    var text = input.value.trim();
    if (!text || !agent) return;
    if (busy) { status(agent.label + ' is still working on your last message.', 'error'); return; }
    // An edit works on the saved file; unsaved text would be overwritten or cause a conflict.
    if (mode === 'edit' && W.isDirty()) {
      status('Saving first — the agent edits the file on disk…');
      var p = W.save();
      if (!p || !p.then) { status('Save the note first (Ctrl+S): in Edit mode the agent works on the saved file.', 'error'); return; }
      p.then(function () { if (W.isDirty()) status('Save the note first (Ctrl+S): in Edit mode the agent works on the saved file.', 'error'); else send(); });
      return;
    }
    var selection = W.selectedText();
    var body = { rel: E.rel, message: text, mode: mode, selection: selection || undefined, dirty: W.isDirty() };
    var empt = log.querySelector('.ed-agent-empty'); if (empt) empt.remove();
    addUser({ text: text, mode: mode, selection: !!selection, at: new Date().toISOString() });
    input.value = ''; scrollDown();
    working(true);
    req('POST', 'agents/' + encodeURIComponent(agent.id) + '/turn', body).then(function (j) {
      if (j._status !== 202) { working(false); addError(j.error || 'The agent did not start'); return; }
      sessionStorage.setItem(key('turn-' + agent.id + '-' + E.rel), j.turn);
      watch(j.turn);
    }, function (e) { working(false); addError(e.message); });
  }

  function watch(turn) {
    busy = { turn: turn, agent: agent.id, started: Date.now() };
    working(true);
    var poll = function () {
      req('GET', 'agent-turns/' + encodeURIComponent(turn)).then(function (j) {
        if (!busy || busy.turn !== turn) return;
        if (j._status === 404) { finish(turn); return; }
        if (j.elapsedMs != null) busy.started = Date.now() - j.elapsedMs;
        if (j.state === 'running') { pollTimer = setTimeout(poll, 1500); return; }
        finish(turn);
        if (j.state === 'failed') { addError(j.error); if (j.changes && j.changes.length) addAgent({ text: '', turn: turn }, '', j.changes); return; }
        renderMany([j.text]).then(function (html) {
          addAgent({ text: j.text, turn: turn, at: new Date().toISOString(), usage: j.usage, ms: j.ms }, html[0], j.changes || []);
          scrollDown();
          session = session || {}; session.sessionId = j.sessionId; session.turns = (session.turns || 0) + 1; sessionLine();
          afterChanges(j.changes || []);
        });
      }, function () { pollTimer = setTimeout(poll, 4000); });
    };
    poll();
  }
  function finish(turn) {
    clearTimeout(pollTimer); busy = null; working(false);
    sessionStorage.removeItem(key('turn-' + agent.id + '-' + E.rel));
  }
  function stop() {
    if (!busy) return;
    req('POST', 'agent-turns/' + encodeURIComponent(busy.turn) + '/cancel', {}).then(function () { status('Stopping…'); });
  }
  function working(on) {
    sendBtn.disabled = !!on; stopBtn.hidden = !on; pick.disabled = !!on;
    btn.classList.toggle('is-working', !!on);
    clearInterval(tickTimer);
    if (on) {
      var tick = function () {
        if (!busy) return;
        var s = Math.round((Date.now() - busy.started) / 1000);
        status(agent.label + ' is working… ' + Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2));
      };
      tick(); tickTimer = setInterval(tick, 1000);
    } else sessionLine();
  }

  // The open note was changed by the agent: load it, unless there are unsaved edits.
  function afterChanges(changes) {
    var mine = changes.filter(function (c) { return c.rel === E.rel; })[0];
    if (!mine) return;
    W.reloadFromDisk().then(function (ok) {
      W.setStatus(ok ? agent.label + ' changed this note — reloaded' : agent.label + ' changed this note on disk; you have unsaved changes', ok ? 'ok' : 'dirty');
    });
  }

  // ---- messages ----
  function renderMany(texts) {
    if (!texts.length) return Promise.resolve([]);
    return req('POST', 'agents/render', { rel: E.rel, texts: texts }).then(function (j) {
      return j._status === 200 ? j.html : texts.map(function (t) { return '<pre class="ed-agent-plain">' + esc(t) + '</pre>'; });
    }, function () { return texts.map(function (t) { return '<pre class="ed-agent-plain">' + esc(t) + '</pre>'; }); });
  }
  function addUser(m) {
    var d = document.createElement('div'); d.className = 'ed-agent-msg is-user';
    d.innerHTML = '<div class="ed-agent-meta">' + (m.mode === 'edit' ? '<span class="ed-agent-tag is-edit">edit</span>' : '') + (m.selection ? '<span class="ed-agent-tag">with selection</span>' : '') + (m.rel && m.rel !== E.rel ? '<span class="ed-agent-tag" title="' + esc(m.rel) + '">' + esc(m.rel.replace(/.*\//, '').replace(/\.md$/i, '')) + '</span>' : '') + '</div><div class="ed-agent-text" dir="auto"></div>';
    d.querySelector('.ed-agent-text').textContent = m.text;
    log.appendChild(d);
  }
  function addError(text) {
    var d = document.createElement('div'); d.className = 'ed-agent-msg is-error';
    d.innerHTML = '<div class="callout" data-callout="failure"><div class="callout-title"><div class="callout-title-inner">' + esc(text || 'Failed') + '</div></div></div>';
    log.appendChild(d); scrollDown();
  }
  function addAgent(m, html, changes) {
    var d = document.createElement('div'); d.className = 'ed-agent-msg is-agent';
    if (html) {
      var body = document.createElement('div'); body.className = 'ed-agent-text markdown-rendered markdown-preview-view'; body.setAttribute('dir', 'auto');
      body.innerHTML = html;
      body.querySelectorAll('a.internal-link[href]').forEach(function (a) { a.setAttribute('target', '_blank'); });
      W.decorate(body);
      d.appendChild(body);
      var tools = document.createElement('div'); tools.className = 'ed-agent-msg-tools';
      tools.innerHTML = '<button type="button" class="clickable-icon" title="Copy the reply as Markdown">⧉</button>'
        + (m.usage && m.usage.costUsd ? '<span class="muted">$' + m.usage.costUsd.toFixed(3) + '</span>' : '')
        + (m.ms ? '<span class="muted">' + Math.round(m.ms / 1000) + ' s</span>' : '');
      tools.querySelector('button').addEventListener('click', function () { copy(m.text); });
      d.appendChild(tools);
    }
    // Changes kept in the history carry only rel + status; a fresh turn carries diffs.
    var list = changes || m.changes || [];
    if (list.length) d.appendChild(changeList(list, m.turn, !!changes));
    log.appendChild(d);
  }
  function changeList(list, turn, live) {
    var box = document.createElement('div'); box.className = 'ed-agent-changes';
    var head = document.createElement('div'); head.className = 'ed-agent-changes-head';
    var unexpected = list.some(function (c) { return c.unexpected; });
    head.textContent = (unexpected ? '⚠ Changed in Review mode — ' : '') + list.length + ' file' + (list.length === 1 ? '' : 's') + ' changed';
    if (unexpected) head.classList.add('is-warning');
    box.appendChild(head);
    list.forEach(function (c) {
      var row = document.createElement('div'); row.className = 'ed-agent-change' + (c.protected ? ' is-protected' : '');
      var name = c.rel.replace(/\.md$/i, '');
      row.innerHTML = '<span class="ed-agent-change-status is-' + esc(c.status) + '">' + esc(c.status) + '</span>'
        + (/\.md$/i.test(c.rel) && c.status !== 'deleted' ? '<a href="' + esc(W.editUrl(c.rel)) + '" title="Open in the editor">' + esc(name) + '</a>' : '<span>' + esc(c.rel) + '</span>')
        + (c.protected ? '<span class="ed-agent-tag is-danger" title="An agent instruction file: whatever it says, an agent follows">instructions</span>' : '')
        + '<span class="topbar-spacer"></span>'
        + (live && c.diff ? '<button type="button" class="ed-btn ed-agent-diff-btn">Diff</button>' : '')
        + (live && c.revertible ? '<button type="button" class="ed-btn ed-agent-revert">Revert</button>' : '');
      box.appendChild(row);
      if (live && c.diff) {
        var pre = document.createElement('pre'); pre.className = 'ed-agent-diff'; pre.hidden = !(c.protected || c.unexpected || list.length === 1);
        pre.innerHTML = c.diff.split('\n').map(function (l) {
          var k = l[0] === '+' ? 'is-add' : l[0] === '-' ? 'is-del' : l.slice(0, 2) === '@@' ? 'is-hunk' : '';
          return '<span class="' + k + '">' + esc(l) + '</span>';
        }).join('\n');
        box.appendChild(pre);
        row.querySelector('.ed-agent-diff-btn').addEventListener('click', function () { pre.hidden = !pre.hidden; });
      }
      var rb = row.querySelector('.ed-agent-revert');
      if (rb) rb.addEventListener('click', function () {
        if (!confirm('Put ' + c.rel + ' back the way it was before this turn?')) return;
        rb.disabled = true;
        req('POST', 'agent-turns/' + encodeURIComponent(turn) + '/revert', { rel: c.rel }).then(function (j) {
          if (j._status !== 200) { rb.disabled = false; W.setStatus(j.error || 'Revert failed', 'error'); return; }
          rb.textContent = j.status === 'trashed' ? 'Moved to .trash' : 'Reverted';
          row.classList.add('is-reverted');
          if (c.rel === E.rel) W.reloadFromDisk().then(function (ok) { W.setStatus(ok ? 'Reverted — reloaded' : 'Reverted on disk; you have unsaved changes', ok ? 'ok' : 'dirty'); });
        });
      });
    });
    return box;
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { W.setStatus('Copied', 'ok'); });
  }
  function status(text, kind) { statusLine.textContent = text; statusLine.className = 'ed-agent-status ' + (kind === 'error' ? 'is-error' : 'muted'); }
  function scrollDown() { log.scrollTop = log.scrollHeight; }
})();
