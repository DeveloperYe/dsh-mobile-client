/* DSH Mobile — a small, dependency-free phone client for a self-hosted
 * DeepSeek Harness. All assets are local to the APK; only RPC/WS traffic goes
 * over the network, so the shell paints instantly.
 *
 * Wire contract (verified against dsh 0.2.0-rc.2):
 *   unary:  POST /api/<method>  {type:'client-request', rpcId, method, payload:{args}}
 *           -> {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}
 *   stream: WS /api/remote.mux   {type:'open', streamId, endpoint, payload:{args}}
 *           <- {type:'item', streamId, value} | {type:'end'|'error', streamId}
 *   auth:   POST /-/auth/login (dsh-access-gate password) then follow the
 *           redirect chain that exchanges the launch token for the auth cookie.
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────── utilities
  var K = { server: 'dshm.server', pass: 'dshm.pass', theme: 'dshm.theme', cache: 'dshm.cache', cwd: 'dshm.cwd', inject: 'dshm.inject' };
  // The shell is always served *by* the target instance (Android intercepts
  // /__app/** on the configured origin), so location.origin is the server.
  var DEFAULT_SERVER = 'http://36.138.189.24:3080';
  var ORIGIN = (function () { try { return location.origin && location.origin !== 'null' ? location.origin : ''; } catch (e) { return ''; } })();

  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsJSON(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }

  function uuid() {
    // crypto.randomUUID needs a secure context; plain-HTTP origins only have
    // getRandomValues, which is why dsh-access-gate ships the same polyfill.
    try {
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) {}
    var b = new Uint8Array(16);
    (crypto && crypto.getRandomValues) ? crypto.getRandomValues(b) : (function () { for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); })();
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = []; for (var i = 0; i < 16; i++) h.push((b[i] + 256).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10).join('');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts), now = Date.now(), diff = now - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 天前';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function baseName(p) {
    if (!p) return '';
    var s = String(p).replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function safeJson(s) { try { return JSON.parse(s); } catch (e) { return s; } }

  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2200);
  }

  // ─────────────────────────────────────────────────────────── markdown (tiny)
  var md = (function () {
    function inline(s) {
      var toks = String(s).split(/(`[^`]*`)/);
      return toks.map(function (t) {
        if (t.length > 1 && t.charAt(0) === '`' && t.charAt(t.length - 1) === '`') return '<code>' + esc(t.slice(1, -1)) + '</code>';
        var x = esc(t);
        x = x.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        x = x.replace(/(^|[\s(（])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        x = x.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, function (m, txt, href) {
          return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>';
        });
        x = x.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, function (m, pre, url) {
          return pre + '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
        });
        x = x.replace(/\n/g, '<br>');
        return x;
      }).join('');
    }

    function render(src) {
      var parts = String(src == null ? '' : src).split('```');
      var out = '';
      for (var i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
          var body = parts[i], lang = '';
          var nl = body.indexOf('\n');
          if (nl >= 0) { lang = body.slice(0, nl).trim(); body = body.slice(nl + 1); }
          out += '<pre><code>' + esc(body.replace(/\n$/, '')) + '</code></pre>';
        } else {
          out += blocks(parts[i]);
        }
      }
      return out;
    }

    function blocks(text) {
      var lines = String(text).split('\n');
      var out = [], i = 0, buf = [];
      function flush() {
        if (!buf.length) return;
        var para = buf.join('\n');
        if (para.trim()) out.push('<p>' + inline(para) + '</p>');
        buf = [];
      }
      while (i < lines.length) {
        var ln = lines[i];
        var m;
        if ((m = /^(#{1,6})\s+(.*)$/.exec(ln))) { flush(); out.push('<h' + Math.min(m[1].length + 2, 5) + '>' + inline(m[2]) + '</h' + Math.min(m[1].length + 2, 5) + '>'); i++; continue; }
        if (/^\s*(---+|\*\*\*+)\s*$/.test(ln)) { flush(); out.push('<hr>'); i++; continue; }
        if (/^\s*>\s?/.test(ln)) {
          flush(); var q = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
          out.push('<blockquote>' + blocks(q.join('\n')) + '</blockquote>'); continue;
        }
        if (/^\s*([-*+]|\d+\.)\s+/.test(ln)) {
          flush();
          var ordered = /^\s*\d+\.\s+/.test(ln);
          var items = [];
          while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')); i++;
            while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
              items[items.length - 1] += '\n' + lines[i].trim(); i++;
            }
          }
          out.push('<' + (ordered ? 'ol' : 'ul') + '>' + items.map(function (t) { return '<li>' + inline(t) + '</li>'; }).join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
          continue;
        }
        // table: | a | b |  +  |---|---|
        if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
          flush();
          var cells = function (row) {
            return row.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
          };
          var head = cells(ln); i += 2;
          var rows = [];
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
          out.push('<table><thead><tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>'
            + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>'; }).join('')
            + '</tbody></table>');
          continue;
        }
        buf.push(ln); i++;
      }
      flush();
      return out.join('');
    }

    return render;
  })();

  // ─────────────────────────────────────────────────────────── state
  var S = {
    server: lsGet(K.server, ORIGIN || DEFAULT_SERVER),
    pass: lsGet(K.pass, ''),
    theme: lsGet(K.theme, 'dark'),
    cwd: lsGet(K.cwd, ''),
    view: 'sessions',
    sessions: lsJSON(K.cache + '.sessions', []),
    control: {},
    cur: null,            // { id, title, cwd, records:[], live:null, header, hasMore, throughSeq, running }
    mux: null,
    muxReady: false,
    busy: false,
    lastError: '',
    showInject: lsGet(K.inject, '0') === '1',
    pending: [],          // queued image parts
    clientId: '',         // $events stream generation id (required for every reply)
    forwardId: null,      // $events stream handle
    interactive: [],      // unanswered approval / user-question requests
    searchOpen: false,
    query: '',
    searchHits: [],
    prevView: null,
    files: null,
    jobs: null,
    goal: null,
  };

  function saveCache() {
    lsSet(K.cache + '.sessions', JSON.stringify(S.sessions.slice(0, 80)));
  }

  // ─────────────────────────────────────────────────────────── RPC
  function ApiError(message, code, details) { this.message = message; this.code = code; this.details = details; }
  ApiError.prototype = Object.create(Error.prototype);

  function rpc(method, args) {
    var rpcId = uuid();
    return fetch(S.server + '/api/' + method, {
      method: 'POST',
      credentials: 'include',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: rpcId, method: method, payload: { args: args || {} } })
    }).then(function (res) {
      if (res.type === 'opaqueredirect' || res.status === 0) throw new ApiError('未登录', 'unauthenticated');
      if (res.status === 401 || res.status === 403) throw new ApiError('未登录或密码失效', 'unauthenticated');
      if (!res.ok) throw new ApiError('HTTP ' + res.status, 'http');
      return res.json();
    }).then(function (body) {
      if (!body || body.type !== 'server-response') throw new ApiError('响应格式异常', 'protocol');
      var r = body.result;
      if (!r || r.ok !== true) {
        var e = (r && r.error) || {};
        if (e.code === 'unauthenticated') showLogin();
        throw new ApiError(e.message || '调用失败', e.code, e.details);
      }
      return r.value;
    });
  }

  function login(server, password) {
    var body = 'password=' + encodeURIComponent(password) + '&next=' + encodeURIComponent('/');
    return fetch(server + '/-/auth/login', {
      method: 'POST',
      credentials: 'include',
      redirect: 'follow',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body
    }).then(function (res) {
      return res.text().then(function (text) {
        if (res.status === 401 || /密码错误|incorrect/i.test(text)) throw new ApiError('密码错误', 'bad-password');
        if (res.status >= 400) throw new ApiError('HTTP ' + res.status, 'http');
        return true;
      });
    }).then(function () {
      return fetch(server + '/api/session/list', {
        method: 'POST', credentials: 'include', redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: uuid(), method: 'session/list', payload: { args: { _request: {} } } })
      });
    }).then(function (res) {
      if (res.type === 'opaqueredirect' || res.status === 401) throw new ApiError('登录未生效（cookie 被拦截？）', 'unauthenticated');
      return true;
    });
  }

  // ─────────────────────────────────────────────────────────── mux (WS)
  function Mux() {
    this.ws = null;
    this.streams = new Map();
    this.retry = 0;
    this.closed = false;
  }
  Mux.prototype.url = function () { return S.server.replace(/^http/, 'ws') + '/api/remote.mux'; };
  Mux.prototype.connect = function () {
    var self = this;
    if (this.closed) return;
    try { this.ws = new WebSocket(this.url()); } catch (e) { return this.scheduleRetry(); }
    this.ws.onopen = function () {
      self.retry = 0;
      S.muxReady = true;
      self.streams.forEach(function (st) { self.send({ type: 'open', streamId: st.id, endpoint: st.endpoint, payload: { args: st.args } }); });
      render();
    };
    this.ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      var st = self.streams.get(m.streamId);
      if (!st) return;
      if (m.type === 'item') { try { st.onFrame(m.value); } catch (e) { console.error(e); } }
      else if (m.type === 'end') { st.onEnd && st.onEnd(); }
      else if (m.type === 'error') { st.onError && st.onError(m.error); }
    };
    this.ws.onclose = function () {
      S.muxReady = false;
      if (!self.closed) self.scheduleRetry();
      render();
    };
    this.ws.onerror = function () {};
  };
  Mux.prototype.scheduleRetry = function () {
    var self = this;
    this.retry = Math.min(this.retry + 1, 6);
    setTimeout(function () { self.connect(); }, 500 * Math.pow(1.7, this.retry));
  };
  Mux.prototype.send = function (obj) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; }
    return false;
  };
  Mux.prototype.open = function (endpoint, args, handlers) {
    var id = uuid();
    this.streams.set(id, { id: id, endpoint: endpoint, args: args, onFrame: handlers.onFrame, onEnd: handlers.onEnd, onError: handlers.onError });
    if (this.ws && this.ws.readyState === 1) this.send({ type: 'open', streamId: id, endpoint: endpoint, payload: { args: args } });
    return id;
  };
  Mux.prototype.closeStream = function (id) {
    if (this.streams.has(id)) { this.send({ type: 'end', streamId: id }); this.streams.delete(id); }
  };
  Mux.prototype.closeAll = function () { this.streams.clear(); };

  function mux() {
    if (!S.mux) { S.mux = new Mux(); S.mux.connect(); }
    return S.mux;
  }

  // ─────────────────────────────── forwarded events ($events) + interactive flows
  //
  // The host pushes two kinds of frame on this stream:
  //   {type:'emit', event, args}                            — notification, no reply
  //   {type:'waterfall', event, eventId, agentId, request}   — MUST be answered,
  //      otherwise the agent blocks forever (approval/request,
  //      user-questions/request). The answer is an ordinary unary call to
  //      POST /api/$events/result with {clientId, eventId, outcome}.
  function attachForwardedEvents() {
    if (S.forwardId) return;
    S.forwardId = mux().open('$events', {}, {
      onFrame: onForwardFrame,
      onEnd: function () { S.forwardId = null; S.clientId = ''; },
      onError: function () { S.forwardId = null; S.clientId = ''; }
    });
  }

  function onForwardFrame(w) {
    if (!w || !w.type) return;
    if (w.type === 'ready') { S.clientId = w.clientId || ''; return; }
    if (w.type === 'emit') { onForwardEmit(w); return; }
    if (w.type === 'cancel') { removeInteractive(w.eventId); return; }
    if (w.type === 'waterfall') { onWaterfall(w); return; }
  }

  /** Keep the session list live from host notifications instead of polling hard. */
  function onForwardEmit(w) {
    var a = w.args || [];
    if (w.event === 'api-session/status') {
      var s = byId(a[0]);
      if (s) s.running = !!a[1];
      if (S.cur && S.cur.id === a[0]) { S.cur.running = !!a[1]; renderComposer(); }
    } else if (w.event === 'api-session/added') {
      if (a[0] && a[0].sessionId) {
        var cur = byId(a[0].sessionId);
        if (cur) { for (var k in a[0]) cur[k] = a[0][k]; } else S.sessions.push(a[0]);
      }
    } else if (w.event === 'api-session/activity') {
      var s2 = byId(a[0]);
      if (s2) s2.updatedAt = a[1];
    } else if (w.event === 'api-session/removed') {
      S.sessions = S.sessions.filter(function (x) { return x.sessionId !== a[0]; });
    } else {
      return;
    }
    S.sessions.sort(function (x, y) { return (y.updatedAt || 0) - (x.updatedAt || 0); });
    saveCache();
    scheduleListRender();
  }

  function byId(id) {
    for (var i = 0; i < S.sessions.length; i++) if (S.sessions[i].sessionId === id) return S.sessions[i];
    return null;
  }

  var listRenderQueued = false;
  function scheduleListRender() {
    if (listRenderQueued || S.view !== 'sessions') return;
    listRenderQueued = true;
    requestAnimationFrame(function () { listRenderQueued = false; if (S.view === 'sessions') render(); });
  }

  function onWaterfall(w) {
    if (w.event === 'approval/request' || w.event === 'user-questions/request') {
      // Replacing a stale card for the same session keeps the panel unambiguous.
      S.interactive = S.interactive.filter(function (it) { return it.eventId !== w.eventId; });
      S.interactive.push({
        kind: w.event === 'approval/request' ? 'approval' : 'question',
        eventId: w.eventId,
        agentId: w.agentId,
        request: w.request || {},
        picked: {},          // questionId -> { selected:[], custom:'' }
        custom: {},
        sent: false
      });
      if (S.view === 'chat') renderComposer();
      toast(w.event === 'approval/request' ? '需要你批准一个操作' : '模型有问题要问你');
      return;
    }
    // Unknown waterfall: delegate so this client is never the reason a turn stalls.
    replyEvent(w.eventId, { kind: 'next' });
  }

  function removeInteractive(eventId) {
    S.interactive = S.interactive.filter(function (it) { return it.eventId !== eventId; });
    if (S.view === 'chat') renderComposer();
  }

  /** Answer one forwarded waterfall request; `outcome` is next | result | rejected. */
  function replyEvent(eventId, outcome) {
    if (!S.clientId) return Promise.reject(new ApiError('事件流未就绪', 'no-client-id'));
    return rpc('$events/result', { clientId: S.clientId, eventId: eventId, outcome: outcome });
  }

  function answerApproval(item, decision) {
    item.sent = true;
    if (S.view === 'chat') renderComposer();
    replyEvent(item.eventId, { kind: 'result', value: decision })
      .then(function () { removeInteractive(item.eventId); toast(decision === 'allowed-once' ? '已允许' : '已拒绝'); })
      .catch(function (e) { item.sent = false; renderComposer(); toast('回复失败：' + e.message); });
  }

  function answerQuestions(item) {
    var qs = item.request.questions || [];
    var answers = qs.map(function (q) {
      var p = item.picked[q.id] || {};
      return { id: q.id, selected: (p.selected || []).slice(), custom: (p.custom || '') || undefined };
    });
    var blank = answers.every(function (a) { return !a.selected.length && !a.custom; });
    if (blank) { toast('请先选择或填写'); return; }
    item.sent = true;
    if (S.view === 'chat') renderComposer();
    replyEvent(item.eventId, { kind: 'result', value: { answers: answers } })
      .then(function () { removeInteractive(item.eventId); toast('已提交'); })
      .catch(function (e) { item.sent = false; renderComposer(); toast('提交失败：' + e.message); });
  }

  function toggleOption(item, q, label) {
    var p = item.picked[q.id] || (item.picked[q.id] = { selected: [], custom: '' });
    if (q.multiSelect) {
      var i = p.selected.indexOf(label);
      if (i >= 0) p.selected.splice(i, 1); else p.selected.push(label);
    } else {
      p.selected = p.selected[0] === label ? [] : [label];
    }
    renderComposer();
  }

  // ─────────────────────────────────────────────────────────── sessions
  function loadSessions() {
    return rpc('session/list', { _request: {} }).then(function (v) {
      S.sessions = (v && v.items) || [];
      S.sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      saveCache();
      render();
      return S.sessions;
    });
  }

  function openSession(id, title) {
    if (S.cur && S.cur.followId) { S.mux && S.mux.closeStream(S.cur.followId); }
    S.cur = { id: id, title: title || '会话', records: [], live: null, header: null, hasMore: false, throughSeq: 0, running: false, projections: {}, followId: null, loaded: false };
    S.view = 'chat';
    render();
    attachFollow();
  }

  function attachFollow() {
    var cur = S.cur;
    if (!cur) return;
    var args = {
      request: {
        address: { kind: 'session', sessionId: cur.id },
        assistantStream: true,
        maxMessages: 200,
        turnWindow: { minMessages: 30, minTurns: 1 }
      }
    };
    cur.followId = mux().open('session/follow', args, {
      onFrame: function (frame) { onFollowFrame(cur, frame); },
      onError: function (err) { toast('会话流错误：' + (err && err.message || '')); }
    });
  }

  function onFollowFrame(cur, frame) {
    if (!frame || !frame.type) return;
    if (frame.type === 'snapshot') {
      cur.header = frame.header;
      cur.records = (frame.records || []).slice();
      cur.hasMore = !!frame.hasMore;
      cur.throughSeq = frame.cursor || 0;
      cur.projections = (frame.projections && frame.projections.values) || {};
      cur.title = cur.projections.title || cur.title;
      cur.running = false;
      cur.loaded = true;
      cur.live = null;
      var base = frame.assistantStream;
      if (base && base.activeAttempt) {
        replayLive(cur, base.activeAttempt);
      }
      renderChat(true);
      return;
    }
    if (frame.type === 'event' && frame.event) {
      var ev = frame.event;
      cur.records.push(frame);
      if (ev.seq && ev.seq > cur.throughSeq) cur.throughSeq = ev.seq;
      if (ev.type === 'turn/start') { cur.running = true; cur.live = null; }
      if (ev.type === 'turn/end') { cur.running = false; cur.live = null; }
      if (ev.type === 'assistant/message') cur.live = null;
      if (ev.type === 'session/title' && ev.data && ev.data.title) cur.title = ev.data.title;
      if (ev.type === 'permission/preset' && ev.data && ev.data.preset) cur.projections.permissions = { currentValue: ev.data.preset };
      if (ev.type === 'model/selection' && ev.data) cur.projections.modelSelection = { next: { provider: ev.data.provider, model: ev.data.model }, lastUsed: cur.projections.modelSelection && cur.projections.modelSelection.lastUsed };
      if (ev.type === 'todo/write') cur.projections.todos = ev.data.todos;
      appendRecord(cur, frame);
      renderChat(false);
      if (ev.type === 'assistant/message' || ev.type === 'turn/end') loadSessions().catch(function () {});
      return;
    }
    if (frame.type === 'assistant-stream' && frame.frame) {
      applyLive(cur, frame.frame);
      updateLiveNode(cur);
    }
  }

  function replayLive(cur, attempt) {
    var live = { blocks: [], usage: null };
    (attempt.stream || []).forEach(function (f) { if (f && f.type === 'chunk') applyChunk(live, f.chunk); });
    cur.live = live;
  }

  function applyLive(cur, f) {
    if (f.type === 'start') cur.live = { blocks: [], usage: null };
    else if (f.type === 'chunk') { if (!cur.live) cur.live = { blocks: [], usage: null }; applyChunk(cur.live, f.chunk); }
    else if (f.type === 'end') { /* durable record follows */ }
  }

  function applyChunk(live, chunk) {
    if (!chunk) return;
    var ix = chunk.index || 0;
    if (chunk.type === 'block-start') { live.blocks[ix] = { type: chunk.blockType || 'text', text: '' }; }
    else if (chunk.type === 'text-delta') {
      if (!live.blocks[ix]) live.blocks[ix] = { type: 'text', text: '' };
      live.blocks[ix].text += chunk.text || '';
    } else if (chunk.type === 'block-end') {
      var b = live.blocks[ix];
      if (!b) live.blocks[ix] = { type: (chunk.block && chunk.block.type) || 'text', text: (chunk.block && chunk.block.text) || '' };
      else if (chunk.block && typeof chunk.block.text === 'string') b.text = chunk.block.text;
    } else if (chunk.type === 'usage') { live.usage = chunk.usage; }
    else if (chunk.type === 'block-delta' || chunk.type === 'delta') {
      // Shape drift guard: ignore unknown delta payloads rather than corrupt the bubble.
      if (!live.blocks[ix]) live.blocks[ix] = { type: 'text', text: '' };
      live.blocks[ix].text += chunk.text || chunk.delta || '';
    }
  }

  function sendPrompt(text, images) {
    if (!S.cur) return Promise.resolve();
    var content = [];
    if (text) content.push({ type: 'text', text: text });
    (images || []).forEach(function (im) { content.push({ type: 'image', mediaType: im.mediaType, data: im.data, name: im.name }); });
    if (!content.length) return Promise.resolve();
    return rpc('session/prompt', {
      request: { requestId: uuid(), sessionId: S.cur.id, mode: 'queue', content: content, clientTimeZone: tz() }
    }).then(function () {
      S.cur.running = true;
      renderComposer();
    });
  }

  function tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'; } catch (e) { return 'Asia/Shanghai'; } }

  function cancelTurn() {
    if (!S.cur) return Promise.resolve();
    return rpc('session/cancel', { request: { sessionId: S.cur.id } }).then(function () { toast('已请求中断'); });
  }

  // ─────────────────────────────────────────── record → display items
  // Keeps DOM appends cheap: records are turned into display items once.
  function recordToItem(rec) {
    var ev = rec.event || rec;
    var d = ev.data || {};
    switch (ev.type) {
      case 'user/message': {
        var kind = (d.source && d.source.kind) || 'user';
        if (kind !== 'user' && !S.showInject) return null;   // injected context: noise on a phone
        return { kind: kind === 'user' ? 'user' : 'inject', seq: ev.seq, text: blocksText(d.content), meta: kind };
      }
      case 'assistant/message':
        return { kind: 'assistant', seq: ev.seq, blocks: (d.message && d.message.content) || [], usage: d.usage, model: d.message && d.message.source };
      case 'tool/call':
        return { kind: 'tool', seq: ev.seq, callId: d.callId, name: d.name, args: safeJson(d.arguments), isError: false, done: false };
      case 'tool/result': {
        // Wire shape: {turn, step, message:{role:'tool', toolCallId, content, isError}}.
        var tm = d.message || d;
        return { kind: 'tool-result', seq: ev.seq, callId: tm.toolCallId || d.toolCallId, text: blocksText(tm.content), isError: !!tm.isError };
      }
      case 'todo/write':
        return { kind: 'todo', seq: ev.seq, todos: d.todos || [] };
      case 'turn/end':
        return { kind: 'note', seq: ev.seq, text: d.reason && d.reason.kind === 'completed' ? '' : '（回合结束：' + ((d.reason && d.reason.kind) || '未知') + '）' };
      case 'session/title':
        return null;
      case 'system/message':
        if (!S.showInject) return null;
        return { kind: 'inject', seq: ev.seq, text: blocksText(d.message && d.message.content), meta: 'system', hidden: true };
      default:
        return null;
    }
  }

  function blocksText(content) {
    if (!content) return '';
    if (typeof content === 'string') return content;
    return content.map(function (b) {
      if (b.type === 'text') return b.text || '';
      if (b.type === 'image') return '［图片］';
      return '';
    }).filter(Boolean).join('\n');
  }

  // ─────────────────────────────────────────────────────────── views
  var app = null;
  function mount(node) {
    app = document.getElementById('app');
    app.innerHTML = '';
    app.appendChild(node);
  }

  function render() {
    if (!app) app = document.getElementById('app');
    if (!S.server) return renderSetup(true);
    if (S.view === 'login') return renderLogin();
    if (S.view === 'setup') return renderSetup(false);
    if (S.view === 'settings') return renderSettings();
    if (S.view === 'more') return renderMore();
    if (S.view === 'files') return renderFiles();
    if (S.view === 'jobs') return renderJobs();
    if (S.view === 'goal') return renderGoal();
    if (S.view === 'chat' && S.cur) return renderChatView();
    return renderSessions();
  }

  // ---------- sessions list
  function renderSessions() {
    var wrap = document.createDocumentFragment();
    wrap.appendChild(header('DSH', S.sessions.length ? S.sessions.length + ' 个会话' : '连接中…', [
      { icon: 'search', label: '搜索', on: toggleSearch },
      { icon: 'plus', label: '新会话', on: newSession },
      { icon: 'gear', label: '设置', on: function () { S.view = 'settings'; render(); } }
    ]));

    if (S.searchOpen) {
      var bar = el('div', 'searchbar');
      var inp = document.createElement('input');
      inp.type = 'search';
      inp.placeholder = '搜索标题，或按内容搜（≥2 字）';
      inp.value = S.query || '';
      var t = null;
      inp.addEventListener('input', function () {
        S.query = inp.value;
        clearTimeout(t);
        t = setTimeout(function () { runSearch(); }, 260);
      });
      bar.appendChild(inp);
      wrap.appendChild(bar);
    }

    var sc = el('div', 'scroll');
    var rows = visibleSessions();
    if (!rows.length) {
      var e = el('div', 'empty');
      if (S.query) e.textContent = '没有匹配的会话';
      else e.innerHTML = S.lastError ? esc(S.lastError) : '<span class="spin-sm"></span>&nbsp; 正在读取会话…';
      sc.appendChild(e);
    }
    var lastCwd = null;
    rows.forEach(function (s) {
      var cwd = s.cwd || '(未知工作区)';
      if (cwd !== lastCwd && !S.query) {
        lastCwd = cwd;
        sc.appendChild(el('div', 'group-label', baseName(cwd) || cwd));
      }
      sc.appendChild(sessionRow(s));
    });
    if (S.searchHits && S.searchHits.length) {
      sc.appendChild(el('div', 'group-label', '内容命中'));
      S.searchHits.forEach(function (hit) {
        var s = byId(hit.sessionId);
        var row = el('div', 'row');
        row.dataset.id = hit.sessionId;
        var g = el('div', 'grow');
        g.appendChild(el('div', 't', (s && s.projections && s.projections.values && s.projections.values.title) || hit.sessionId));
        var m = el('div', 'm');
        m.appendChild(el('span', 'snip', String(hit.snippet || '').replace(/\s+/g, ' ')));
        g.appendChild(m);
        row.appendChild(g);
        row.addEventListener('click', function () { openSession(hit.sessionId, ''); });
        sc.appendChild(row);
      });
    }
    sc.addEventListener('scroll', function () {
      if (sc.scrollTop <= 0 && Date.now() - (renderSessions._last || 0) > 4000) {
        renderSessions._last = Date.now();
        loadSessions().catch(function (e) { if (e.code === 'unauthenticated') showLogin(); });
      }
    });
    wrap.appendChild(sc);
    mount(wrap);
  }

  function visibleSessions() {
    var q = (S.query || '').trim().toLowerCase();
    if (!q) return S.sessions;
    return S.sessions.filter(function (s) {
      var title = (s.projections && s.projections.values && (s.projections.values.title || '')) || '';
      return title.toLowerCase().indexOf(q) >= 0 || (s.cwd || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  function toggleSearch() {
    S.searchOpen = !S.searchOpen;
    if (!S.searchOpen) { S.query = ''; S.searchHits = []; }
    render();
    if (S.searchOpen) { var i = document.querySelector('.searchbar input'); i && i.focus(); }
  }

  /** Title filtering is instant; content search asks the host (session/search). */
  function runSearch() {
    var q = (S.query || '').trim();
    if (q.length < 2) { S.searchHits = []; render(); return; }
    rpc('session/search', { request: { query: q } }).then(function (v) {
      S.searchHits = (v && v.items) || [];
      render();
    }).catch(function () { render(); });
  }

  function sessionRow(s) {
    var row = el('div', 'row');
    row.dataset.id = s.sessionId;
    var dot = el('div', 'dot ' + (s.running ? 'run' : 'idle'));
    row.appendChild(dot);
    var g = el('div', 'grow');
    var title = (s.projections && s.projections.values && s.projections.values.title) || (s.blank ? '（新会话）' : '（无标题）');
    g.appendChild(el('div', 't', title));
    var m = el('div', 'm');
    m.appendChild(el('span', null, fmtTime(s.updatedAt)));
    var p = el('span', 'path', baseName(s.cwd) || '');
    m.appendChild(p);
    if (s.origin === 'subagent') m.appendChild(el('span', 'tag', '子代理'));
    g.appendChild(m);
    row.appendChild(g);
    row.addEventListener('click', function () { openSession(s.sessionId, title); });
    return row;
  }

  function newSession() {
    pickCwd();
  }

  // ---------- chat
  var chatRefs = { log: null, liveNode: null, liveBody: null };
  var renderedCount = 0;

  function renderChatView() {
    var cur = S.cur;
    var frag = document.createDocumentFragment();
    var title = cur.projections.title || cur.title || '会话';
    frag.appendChild(header(title, '', [
      { icon: 'back', label: '返回', on: function () { leaveChat(); } },
      { icon: 'more', label: '菜单', on: function () { chatMenu(); } }
    ]));
    var st = statsText(cur);
    var line = el('div', 'statline', st);
    if (!st) line.style.display = 'none';
    frag.appendChild(line);
    var log = el('div', 'scroll log');
    frag.appendChild(log);
    frag.appendChild(composer());
    mount(frag);
    chatRefs.log = log;
    chatRefs.statline = line;
    renderedCount = 0;
    renderChat(true);
  }

  function leaveChat() {
    if (S.cur && S.cur.followId && S.mux) S.mux.closeStream(S.cur.followId);
    S.cur = null;
    S.view = 'sessions';
    render();
    loadSessions().catch(function () {});
  }

  function chatMenu() {
    var cur = S.cur;
    var items = [];
    items.push(['文件', function () { openPanel('files'); }]);
    items.push(['后台任务', function () { openPanel('jobs'); }]);
    items.push(['长期目标', function () { openPanel('goal'); }]);
    items.push(['命令面板', commandPalette]);
    items.push(['选择模型', pickModel]);
    items.push(['重命名会话', renameCur]);
    items.push(['复制会话 ID', function () { copy(cur.id); }]);
    items.push(['回到列表', leaveChat]);
    var sheet = el('div', 'toast');
    sheet.style.bottom = 'auto';
    sheet.style.top = 'calc(var(--sat) + 60px)';
    sheet.style.borderRadius = '14px';
    sheet.style.padding = '6px';
    sheet.style.textAlign = 'left';
    sheet.innerHTML = items.map(function (it, i) { return '<div data-i="' + i + '" style="padding:10px 14px">' + esc(it[0]) + '</div>'; }).join('');
    document.body.appendChild(sheet);
    sheet.addEventListener('click', function (ev) {
      var d = ev.target.closest('[data-i]');
      if (!d) { sheet.remove(); return; }
      var fn = items[Number(d.dataset.i)][1];
      sheet.remove();
      fn();
    });
    setTimeout(function () { document.addEventListener('click', function h() { sheet.remove(); document.removeEventListener('click', h); }); }, 0);
  }

  function copy(t) {
    try { navigator.clipboard.writeText(t); toast('已复制'); } catch (e) { toast(t); }
  }

  function renameCur() {
    var t = prompt('新的会话标题', S.cur.projections.title || S.cur.title || '');
    if (!t) return;
    rpc('session/rename', { request: { sessionId: S.cur.id, title: t } }).then(function () {
      S.cur.title = t; S.cur.projections.title = t; render();
    }).catch(function (e) { toast('失败：' + e.message); });
  }

  /** Switch the session's permission preset through the `/permission` command. */
  function pickPermission() {
    if (!S.cur) return;
    rpc('permissionPresets/catalog', {}).then(function (cat) {
      var current = (S.cur.projections.permissions || {}).currentValue || '';
      var sheet = el('div', 'toast');
      sheet.style.top = 'calc(var(--sat) + 50px)';
      sheet.style.borderRadius = '14px'; sheet.style.padding = '6px';
      sheet.style.textAlign = 'left'; sheet.style.width = '76vw'; sheet.style.maxWidth = '320px';
      var html = '<div style="padding:8px 14px;color:var(--fg-faint);font-size:12px">权限预设（当前：' + esc(current || '未知') + '）</div>';
      (cat.options || []).forEach(function (o) {
        html += '<div data-v="' + esc(o.value) + '" style="padding:10px 14px;' + (o.value === current ? 'color:var(--accent)' : '') + '">'
          + esc(o.name || o.value) + (o.value === current ? ' ✓' : '') + '</div>';
      });
      sheet.innerHTML = html;
      document.body.appendChild(sheet);
      var close = function () { sheet.remove(); document.removeEventListener('click', outside); };
      var outside = function () { close(); };
      sheet.addEventListener('click', function (ev) {
        var d = ev.target.closest('[data-v]');
        if (!d) return;
        close();
        var preset = d.dataset.v;
        rpc('commands/execute', { agentId: S.cur.id, line: '/permission ' + preset, submittedAttachments: [] })
          .then(function () {
            S.cur.projections.permissions = { currentValue: preset };
            renderComposer();
            toast('已切换为 ' + preset);
          })
          .catch(function (e) { toast('切换失败：' + e.message); });
      });
      setTimeout(function () { document.addEventListener('click', outside); }, 0);
    }).catch(function (e) { toast('读取预设失败：' + e.message); });
  }

  function pickModel() {    rpc('session/modelCatalog', {}).then(function (cat) {
      var sheet = el('div', 'toast');
      sheet.style.bottom = 'auto'; sheet.style.top = 'calc(var(--sat) + 50px)';
      sheet.style.borderRadius = '14px'; sheet.style.padding = '6px'; sheet.style.textAlign = 'left';
      sheet.style.maxHeight = '70vh'; sheet.style.overflowY = 'auto'; sheet.style.width = '76vw';
      var html = '';
      html += '<div style="padding:8px 14px;color:var(--fg-faint);font-size:12px">默认：' + esc(cat.default.provider + ' / ' + cat.default.model) + '</div>';
      (cat.groups || []).forEach(function (g) {
        html += '<div style="padding:8px 14px;color:var(--fg-faint);font-size:12px">' + esc(g.name || g.id) + '</div>';
        (g.models || []).forEach(function (m) {
          html += '<div data-p="' + esc(g.id) + '" data-m="' + esc(m.id) + '" style="padding:9px 14px">' + esc(m.name || m.id) + '</div>';
        });
      });
      sheet.innerHTML = html;
      document.body.appendChild(sheet);
      sheet.addEventListener('click', function (ev) {
        var d = ev.target.closest('[data-p]');
        if (!d) return;
        sheet.remove();
        rpc('session/selectModel', { request: { sessionId: S.cur.id, provider: d.dataset.p, model: d.dataset.m } })
          .then(function () { toast('已切换模型'); })
          .catch(function (e) { toast('切换失败：' + e.message); });
      });
    }).catch(function (e) { toast('读取模型失败：' + e.message); });
  }

  function appendRecord(cur, rec) {
    var item = recordToItem(rec);
    if (!item || !chatRefs.log) return;
    renderItemInto(chatRefs.log, item, cur);
    renderedCount++;
    scrollChat(true);
  }

  function renderChat(force) {
    if (!chatRefs.log || !S.cur) return;
    if (force) {
      chatRefs.log.innerHTML = '';
      chatRefs.liveNode = null;
      renderedCount = 0;
      if (S.cur.hasMore) {
        var more = el('button', 'btn ghost');
        more.textContent = '载入更早的消息';
        more.style.margin = '4px auto 10px';
        more.style.display = 'block';
        more.addEventListener('click', function () { loadOlder(more); });
        chatRefs.log.appendChild(more);
      }
      var items = [];
      S.cur.records.forEach(function (r) { var it = recordToItem(r); if (it) items.push(it); });
      items.forEach(function (it) { renderItemInto(chatRefs.log, it, S.cur); renderedCount++; });
      if (!items.length) {
        var e = el('div', 'empty', '还没有消息，下面输入框里说点什么。');
        chatRefs.log.appendChild(e);
      }
    }
    updateLiveNode(S.cur);
    // Projections only exist after the snapshot: fill the stats line and chips now.
    if (chatRefs.statline) {
      var stText = statsText(S.cur);
      chatRefs.statline.textContent = stText + (S.cur.projections.agentPreset ? ' · ' + S.cur.projections.agentPreset : '');
      chatRefs.statline.style.display = stText ? '' : 'none';
    }
    renderComposer();
    scrollChat(false);
  }

  function loadOlder(btn) {
    var cur = S.cur;
    var oldest = null;
    for (var i = 0; i < cur.records.length; i++) { var r = cur.records[i]; if (r.event && r.event.seq) { oldest = r.event.seq; break; } }
    if (!oldest) { btn.remove(); return; }
    btn.textContent = '载入中…';
    rpc('session/page', {
      request: { address: { kind: 'session', sessionId: cur.id }, throughSeq: cur.throughSeq, beforeSeq: oldest, maxMessages: 100, turnWindow: { minMessages: 20, minTurns: 1 } }
    }).then(function (page) {
      cur.records = (page.records || []).concat(cur.records);
      cur.hasMore = !!page.hasMore;
      renderChat(true);
    }).catch(function (e) { btn.textContent = '载入更早的消息'; toast('失败：' + e.message); });
  }

  function renderItemInto(log, item, cur) {
    var node = null;
    if (item.kind === 'user') {
      node = el('div', 'msg user');
      node.innerHTML = md(item.text);
      attachLongPress(node, function () { msgActions(item); });
    } else if (item.kind === 'inject') {
      if (!item.text) return;
      node = document.createElement('details');
      node.className = 'msg assistant';
      var sum = document.createElement('summary');
      sum.style.cursor = 'pointer';
      sum.style.fontSize = '12px';
      sum.style.color = 'var(--fg-faint)';
      sum.textContent = '上下文注入 · ' + (item.meta || '') + ' · ' + fmtBytes(byteLen(item.text));
      var body = el('div');
      body.innerHTML = md(item.text);
      node.appendChild(sum); node.appendChild(body);
    } else if (item.kind === 'assistant') {
      var blocks = item.blocks || [];
      var html = '';
      var textSeen = false;
      var reasoningSeen = false;
      blocks.forEach(function (b) {
        if (b.type === 'reasoning') {
          reasoningSeen = true;
          html += '<details class="think"><summary>思考过程 · ' + fmtBytes(byteLen(b.text || '')) + '</summary>' + md(b.text || '') + '</details>';
        } else if (b.type === 'text') {
          if ((b.text || '').trim()) textSeen = true;
          html += md(b.text || '');
        }
      });
      // A step that only made tool calls carries no prose — the tool card below
      // already says what happened, so render nothing instead of an empty bubble.
      if (!textSeen && !reasoningSeen) return;
      node = el('div', 'msg assistant');
      node.innerHTML = html;
    } else if (item.kind === 'tool') {
      node = toolNode(item);
    } else if (item.kind === 'tool-result') {
      // attach to the matching card if it is the most recent one
      var cards = log.querySelectorAll('.tool[data-call="' + cssEsc(item.callId) + '"]');
      var card = cards[cards.length - 1];
      if (card) {
        card.dataset.error = item.isError ? '1' : '';
        var state = card.querySelector('.state');
        if (state) { state.textContent = item.isError ? '失败' : '完成'; state.className = 'state' + (item.isError ? ' err' : ''); }
        var body = card.querySelector('.body');
        if (body) {
          var pre = el('pre');
          pre.textContent = truncate(item.text, 4000) || '(无输出)';
          if (item.isError) pre.style.color = 'var(--danger)';
          body.appendChild(pre);
        }
      } else {
        node = el('div', 'msg note', '工具结果');
      }
    } else if (item.kind === 'todo') {
      node = el('div', 'msg assistant');
      node.innerHTML = '<div class="who">任务清单</div><ul>' + (item.todos || []).map(function (t) {
        var mark = t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '▶' : '○';
        return '<li>' + esc(mark + ' ' + t.content) + '</li>';
      }).join('') + '</ul>';
    } else if (item.kind === 'note') {
      if (!item.text) return;
      node = el('div', 'msg note', item.text);
    }
    if (node) log.appendChild(node);
  }

  function byteLen(s) { try { return new Blob([s || '']).size; } catch (e) { return (s || '').length; } }

  function toolNode(item) {
    var d = document.createElement('details');
    d.className = 'tool';
    d.dataset.call = item.callId || '';
    var sum = document.createElement('summary');
    var name = el('span', 'name', item.name || 'tool');
    var hint = el('span', 'hint', hintOf(item.name, item.args));
    var state = el('span', 'state', '运行中');
    sum.appendChild(name); sum.appendChild(hint); sum.appendChild(state);
    d.appendChild(sum);
    var body = el('div', 'body');
    var pre = el('pre');
    pre.textContent = typeof item.args === 'string' ? item.args : JSON.stringify(item.args, null, 1);
    body.appendChild(pre);
    d.appendChild(body);
    return d;
  }

  function hintOf(name, args) {
    if (args == null) return '';
    if (typeof args !== 'object') return truncate(String(args).replace(/\s+/g, ' '), 60);
    var keys = ['command', 'description', 'path', 'file_path', 'pattern', 'query', 'url', 'prompt', 'text', 'questions', 'line', 'title'];
    for (var i = 0; i < keys.length; i++) {
      var v = args[keys[i]];
      if (v == null || v === '') continue;
      if (typeof v === 'string') return truncate(v.replace(/\s+/g, ' '), 60);
      if (Array.isArray(v)) {
        var parts = v.map(function (x) {
          if (typeof x === 'string') return x;
          if (x && typeof x === 'object') return x.question || x.label || x.id || JSON.stringify(x);
          return String(x);
        }).join(' · ');
        return truncate(parts.replace(/\s+/g, ' '), 60);
      }
      if (typeof v === 'object') return truncate(JSON.stringify(v).replace(/\s+/g, ' '), 60);
    }
    var k = Object.keys(args)[0];
    if (!k) return '';
    var val = args[k];
    var s = typeof val === 'object' ? JSON.stringify(val) : String(val);
    return k + '=' + truncate(s.replace(/\s+/g, ' '), 40);
  }

  function cssEsc(s) { return String(s || '').replace(/["\\]/g, '\\$&'); }

  function updateLiveNode(cur) {
    var log = chatRefs.log;
    if (!log) return;
    if (!cur.live || !hasLiveText(cur.live)) {
      if (chatRefs.liveNode) { chatRefs.liveNode.remove(); chatRefs.liveNode = null; }
      return;
    }
    if (!chatRefs.liveNode) {
      chatRefs.liveNode = el('div', 'msg assistant');
      chatRefs.liveBody = el('div');
      chatRefs.liveNode.appendChild(chatRefs.liveBody);
      log.appendChild(chatRefs.liveNode);
    }
    var html = '';
    cur.live.blocks.forEach(function (b) {
      if (!b) return;
      if (b.type === 'reasoning') html += '<details class="think" open><summary>思考中…</summary>' + md(b.text || '') + '</details>';
      else html += md(b.text || '');
    });
    html += '<span class="cursor"></span>';
    chatRefs.liveBody.innerHTML = html;
    scrollChat(true);
  }

  function hasLiveText(live) {
    for (var i = 0; i < live.blocks.length; i++) { var b = live.blocks[i]; if (b && b.text) return true; }
    return false;
  }

  function scrollChat(force) {
    var log = chatRefs.log;
    if (!log) return;
    var nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
    if (force && nearBottom) requestAnimationFrame(function () { log.scrollTop = log.scrollHeight; });
  }

  // ---------- composer
  var composerRefs = {};
  function composer() {
    var box = el('div', 'composer');
    var ask = el('div', 'ask-slot');
    box.appendChild(ask);
    var chips = el('div', 'chips');
    box.appendChild(chips);

    var line = el('div', 'line');
    var file = document.createElement('input');
    file.type = 'file'; file.accept = 'image/*'; file.multiple = true; file.style.display = 'none';
    file.addEventListener('change', function () { addImages(file.files); file.value = ''; });

    var ta = document.createElement('textarea');
    ta.rows = 1;
    ta.placeholder = '发消息…';

    var send = el('button', 'send');
    send.type = 'button';

    var plus = el('button', 'iconbtn');
    plus.appendChild(icon('plus', 20));
    plus.addEventListener('click', function () { file.click(); });

    line.appendChild(plus); line.appendChild(ta); line.appendChild(send);
    box.appendChild(line);
    box.appendChild(file);

    composerRefs = { ta: ta, send: send, chips: chips, ask: ask, box: box };

    ta.addEventListener('input', function () {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
      renderComposer();
    });
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); doSend(); }
    });
    send.addEventListener('click', function () {
      if (S.cur && S.cur.running) cancelTurn().catch(function (e) { toast(e.message); });
      else doSend();
    });
    setTimeout(renderComposer, 0);
    return box;
  }

  /** Approval / user-question card pinned above the composer (the browser shows
   *  the same two flows as a composer takeover). */
  function renderAskSlot() {
    var slot = composerRefs.ask;
    if (!slot) return;
    slot.innerHTML = '';
    if (!S.cur) return;
    // Requests are agent(session)-scoped; only show the ones for the open session.
    var mine = S.interactive.filter(function (it) { return !it.agentId || it.agentId === S.cur.id; });
    var item = mine[0];
    if (!item) return;

    var card = el('div', 'ask');
    var head = el('div', 'ask-head');
    head.appendChild(el('span', 'ask-kind', item.kind === 'approval' ? '需要批准' : '模型提问'));
    if (item.request && item.request.toolName) head.appendChild(el('span', 'ask-tool', item.request.toolName));
    card.appendChild(head);

    if (item.kind === 'approval') {
      var r = item.request || {};
      var reason = r.reason || (r.displayReason && (r.displayReason.zh || r.displayReason.en)) || '';
      if (reason) {
        var body = el('div', 'ask-text');
        body.textContent = reason;
        card.appendChild(body);
      }
      var row = el('div', 'ask-actions');
      var allow = el('button', 'btn', item.sent ? '处理中…' : '允许一次');
      allow.disabled = !!item.sent;
      allow.addEventListener('click', function () { answerApproval(item, 'allowed-once'); });
      var deny = el('button', 'btn ghost', '拒绝');
      deny.disabled = !!item.sent;
      deny.addEventListener('click', function () { answerApproval(item, 'rejected'); });
      row.appendChild(allow); row.appendChild(deny);
      card.appendChild(row);
    } else {
      var qs = (item.request && item.request.questions) || [];
      qs.forEach(function (q) {
        var box = el('div', 'ask-q');
        if (q.header) box.appendChild(el('div', 'ask-header', q.header));
        box.appendChild(el('div', 'ask-text', q.question));
        if (q.detail) box.appendChild(el('div', 'ask-detail', q.detail));
        var picked = (item.picked[q.id] || {}).selected || [];
        if (q.options && q.options.length) {
          var opts = el('div', 'ask-opts');
          q.options.forEach(function (o) {
            var on = picked.indexOf(o.label) >= 0;
            var b = el('button', 'opt' + (on ? ' on' : ''));
            b.appendChild(el('span', 'opt-label', o.label));
            if (o.description) b.appendChild(el('span', 'opt-desc', o.description));
            b.addEventListener('click', function () { toggleOption(item, q, o.label); });
            opts.appendChild(b);
          });
          box.appendChild(opts);
        }
        if (q.options && q.options.length && q.multiSelect) box.appendChild(el('div', 'ask-detail', '可多选'));
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = q.options && q.options.length ? '其他（可填）' : '输入你的回答';
        inp.value = item.custom[q.id] || '';
        inp.addEventListener('input', function () {
          item.custom[q.id] = inp.value;
          var p = item.picked[q.id] || (item.picked[q.id] = { selected: [], custom: '' });
          p.custom = inp.value;
        });
        box.appendChild(inp);
        card.appendChild(box);
      });
      var row2 = el('div', 'ask-actions');
      var submit = el('button', 'btn', item.sent ? '提交中…' : '提交回答');
      submit.disabled = !!item.sent;
      submit.addEventListener('click', function () { answerQuestions(item); });
      row2.appendChild(submit);
      if (mine.length > 1) row2.appendChild(el('span', 'ask-detail', '还有 ' + (mine.length - 1) + ' 个待处理'));
      card.appendChild(row2);
    }
    slot.appendChild(card);
  }

  function doSend() {
    var ta = composerRefs.ta;
    if (!ta) return;
    var text = ta.value.trim();
    if (!text && !S.pending.length) return;
    ta.value = ''; ta.style.height = 'auto';
    var images = S.pending.slice();
    S.pending = [];
    sendPrompt(text, images).then(function () {
      renderComposer();
      // the durable user/message arrives over the follow stream
    }).catch(function (e) {
      toast('发送失败：' + e.message);
      if (e.code === 'unauthenticated') showLogin();
    });
  }

  function addImages(files) {
    Array.prototype.slice.call(files || []).forEach(function (f) {
      if (f.size > 6 * 1024 * 1024) { toast('图片过大（>6MB）'); return; }
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result);
        var m = /^data:([^;]+);base64,(.*)$/.exec(s);
        if (!m) return;
        S.pending.push({ mediaType: m[1], data: m[2], name: f.name });
        renderComposer();
      };
      fr.readAsDataURL(f);
    });
  }

  function renderComposer() {
    if (!composerRefs.chips) return;
    renderAskSlot();
    var chips = composerRefs.chips;
    chips.innerHTML = '';
    var cur = S.cur;
    var ms = (cur && cur.projections && cur.projections.modelSelection) || {};
    var next = ms.next || ms.lastUsed;
    if (next) {
      var c = el('span', 'chip', next.model || next.provider);
      c.addEventListener('click', pickModel);
      chips.appendChild(c);
    }
    var perms = cur && cur.projections && cur.projections.permissions;
    if (perms && perms.currentValue) {
      var pc = el('span', 'chip', perms.currentValue);
      pc.addEventListener('click', pickPermission);
      chips.appendChild(pc);
    }
    if (S.muxReady) chips.appendChild(el('span', 'chip run', '● 已连接'));
    else chips.appendChild(el('span', 'chip', '连接中…'));
    S.pending.forEach(function (p, i) {
      var c = el('span', 'chip on', '图 ' + (i + 1) + ' ✕');
      c.addEventListener('click', function () { S.pending.splice(i, 1); renderComposer(); });
      chips.appendChild(c);
    });
    var ta = composerRefs.ta;
    var send = composerRefs.send;
    if (cur && cur.running) {
      send.classList.add('stop');
      send.innerHTML = '';
      send.appendChild(icon('stop', 18));
      send.disabled = false;
    } else {
      send.classList.remove('stop');
      send.innerHTML = '';
      send.appendChild(icon('send', 19));
      send.disabled = !(ta && ta.value.trim()) && !S.pending.length;
    }
  }

  // ---------- header helper
  // ---------- small UI kit: inline icons + bottom sheet
  var ICONS = {
    back: 'M15 5l-7 7 7 7',
    more: 'M6 12h.01M12 12h.01M18 12h.01',
    plus: 'M12 5v14M5 12h14',
    gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.0a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    send: 'M12 19V5M5 12l7-7 7 7',
    stop: 'M7 7h10v10H7z',
    terminal: 'M4 5h16v14H4zM8 10l2.5 2L8 14m5 0h4',
    file: 'M14 3v5h5M6 3h9l4 4v14H6z',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z'
  };
  function icon(name, size) {
    var p = ICONS[name] || '';
    var n = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    n.setAttribute('viewBox', '0 0 24 24');
    n.setAttribute('width', size || 20); n.setAttribute('height', size || 20);
    n.setAttribute('fill', 'none'); n.setAttribute('stroke', 'currentColor');
    n.setAttribute('stroke-width', '1.8'); n.setAttribute('stroke-linecap', 'round');
    n.setAttribute('stroke-linejoin', 'round');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', p);
    n.appendChild(path);
    return n;
  }

  /** Bottom sheet. `build(body, close)` fills the body; returns a closer. */
  function sheet(title, build) {
    var back = el('div', 'sheet-back');
    var box = el('div', 'sheet');
    var grab = el('div', 'sheet-grab');
    box.appendChild(grab);
    if (title) box.appendChild(el('div', 'sheet-title', title));
    var body = el('div', 'sheet-body');
    box.appendChild(body);
    back.appendChild(box);
    var close = function () {
      back.classList.add('out');
      setTimeout(function () { back.remove(); }, 160);
    };
    back.addEventListener('click', function (ev) { if (ev.target === back) close(); });
    document.body.appendChild(back);
    requestAnimationFrame(function () { back.classList.add('in'); });
    build(body, close);
    return close;
  }
  function sheetRow(label, desc, onClick, opts) {
    var r = el('div', 'sheet-row');
    var t = el('div', 'sheet-row-main');
    t.appendChild(el('div', 'sheet-row-label', label));
    if (desc) t.appendChild(el('div', 'sheet-row-desc', desc));
    r.appendChild(t);
    if (opts && opts.active) r.appendChild(el('span', 'sheet-check', '✓'));
    r.addEventListener('click', onClick);
    return r;
  }

  /** Compact token/time summary for the open session. */
  function statsText(cur) {
    var p = (cur && cur.projections) || {};
    var u = p.tokenUsage || {};
    var s = p.sessionStats || {};
    var bits = [];
    if (u.cacheReadTokens || u.uncachedInputTokens) {
      var inTok = (u.uncachedInputTokens || 0) + (u.cacheReadTokens || 0);
      bits.push((inTok >= 1000 ? Math.round(inTok / 1000) + 'k' : inTok) + ' in');
    }
    if (u.outputTokens) bits.push((u.outputTokens >= 1000 ? (u.outputTokens / 1000).toFixed(1) + 'k' : u.outputTokens) + ' out');
    if (s.steps) bits.push(s.steps + ' 步');
    if (s.llmMs) bits.push('LLM ' + Math.round(s.llmMs / 1000) + 's');
    var cp = p.contextPressure || {};
    if (cp.contextWindow) bits.push(Math.round((cp.pressureTokens || 0) / cp.contextWindow * 100) + '% ctx');
    return bits.join(' · ');
  }

  /** Slash-command palette: /compact, /permission, /goal, /export … */
  function commandPalette() {
    if (!S.cur) return;
    rpc('commands/list', { agentId: S.cur.id }).then(function (list) {
      sheet('命令', function (body, close) {
        (list || []).forEach(function (c) {
          body.appendChild(sheetRow('/' + c.name, c.description, function () {
            close();
            var hint = (c.input && c.input.hint) || '';
            var arg = hint ? prompt('/' + c.name + '  ' + hint, '') : null;
            if (hint && arg === null) return;
            rpc('commands/execute', { agentId: S.cur.id, line: '/' + c.name + (arg ? ' ' + arg : ''), submittedAttachments: [] })
              .then(function () { toast('/' + c.name + ' 已执行'); })
              .catch(function (e) { toast('执行失败：' + e.message); });
          }));
        });
        body.appendChild(sheetRow('取消', '', close));
      });
    }).catch(function (e) { toast('读取命令失败：' + e.message); });
  }

  /** New-session workspace picker: recent cwds plus a manual entry. */
  function pickCwd() {
    var seen = {}, list = [];
    S.sessions.forEach(function (s) { if (s.cwd && !seen[s.cwd]) { seen[s.cwd] = 1; list.push(s.cwd); } });
    sheet('新建会话', function (body, close) {
      body.appendChild(el('div', 'sheet-note', '选一个工作目录（服务器上的路径）'));
      list.slice(0, 8).forEach(function (cwd) {
        body.appendChild(sheetRow(baseName(cwd) || cwd, cwd, function () { close(); createSessionIn(cwd); }));
      });
      var custom = sheetRow('其他目录…', '手动输入完整路径', function () {
        var p = prompt('工作目录（服务器路径）', S.cwd || list[0] || '');
        if (!p) return;
        close(); createSessionIn(p);
      });
      body.appendChild(custom);
    });
  }

  function createSessionIn(cwd) {
    toast('正在新建…');
    rpc('session/create', { request: { cwd: cwd } }).then(function (v) {
      S.cwd = cwd; lsSet(K.cwd, cwd);
      return loadSessions().then(function () { openSession(v.sessionId, '（新会话）'); });
    }).catch(function (e) { toast('新建失败：' + e.message); });
  }

  /** Long-press actions for one user message: copy / resend / fork from here. */
  function msgActions(item, close) {
    close && close();
    sheet('消息', function (body, c) {
      body.appendChild(sheetRow('复制', '', function () {
        c();
        try { navigator.clipboard.writeText(item.text || ''); toast('已复制'); } catch (e) { toast('复制失败'); }
      }));
      body.appendChild(sheetRow('重新发送', '把这条内容再发一次', function () {
        c();
        sendPrompt(item.text || '', []).catch(function (e) { toast('失败：' + e.message); });
      }));
      body.appendChild(sheetRow('从此处分叉会话', '以这条消息为界新建一个分支', function () {
        c();
        rpc('session/fork', { request: { sessionId: S.cur.id, atSeq: item.seq } })
          .then(function (v) { toast('已分叉'); loadSessions().then(function () { openSession(v.sessionId, '（分叉）'); }); })
          .catch(function (e) { toast('分叉失败：' + e.message); });
      }));
    });
  }

  /** Long-press (or right-click) hook for message actions. */
  function attachLongPress(node, fn) {
    var timer = null, moved = false;
    node.addEventListener('touchstart', function () {
      moved = false;
      timer = setTimeout(function () {
        if (moved) return;
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
        fn();
      }, 480);
    }, { passive: true });
    node.addEventListener('touchmove', function () { moved = true; clearTimeout(timer); }, { passive: true });
    node.addEventListener('touchend', function () { clearTimeout(timer); }, { passive: true });
    node.addEventListener('touchcancel', function () { clearTimeout(timer); }, { passive: true });
    node.addEventListener('contextmenu', function (ev) { ev.preventDefault(); fn(); });
  }

  // ─────────────────────────── panels: files / jobs / goal / more settings
  //
  // Panel shapes verified against the host type declarations:
  //   workspaceFiles/list(workspaceFileScopeId, path) -> {path, entries:[{name,type,size?}]}
  //   workspaceFiles/read(workspaceFileScopeId, path, {offset,limit}) -> {text, lines, eof}
  //   job/list  (stream) -> {type:'rows', jobs:[...]};  job/kill({sessionId, jobId})
  //   goals/get(agentId) -> GoalView | undefined
  function openPanel(kind) {
    S.prevView = S.view;
    S.view = kind;
    if (kind === 'files' && !S.files) S.files = { path: '', entries: null, inflight: false, error: '' };
    if (kind === 'jobs') S.jobs = null;
    if (kind === 'goal') S.goal = null;
    render();
  }

  function closePanel() {
    S.view = S.prevView || (S.cur ? 'chat' : 'sessions');
    render();
  }

  function panelHeader(title, extra) {
    var acts = [{ icon: 'back', label: '返回', on: closePanel }];
    (extra || []).forEach(function (a) { acts.push(a); });
    return header(title, '', acts);
  }

  function needSession() {
    if (S.cur) return true;
    toast('先打开一个会话');
    closePanel();
    return false;
  }

  // ---------- files
  /** Host paths: '.' means the workspace root, children are absolute. */
  function absOf(rel) {
    var root = ((S.cur && S.cur.header && S.cur.header.cwd) || (S.cur && S.cur.cwd) || '').replace(/[\\/]+$/, '');
    if (!rel) return '.';
    return root + '\\' + rel.split('/').join('\\');
  }

  function renderFiles() {
    if (!needSession()) return;
    var st = S.files;
    if (st.entries === null && !st.inflight) { loadDir(st.path); return; }
    var frag = document.createDocumentFragment();
    frag.appendChild(panelHeader('文件', [
      { icon: 'search', label: '刷新', on: function () { loadDir(st.path); } }
    ]));
    frag.appendChild(el('div', 'statline', st.path ? '/' + st.path : '（工作区根目录）'));
    var sc = el('div', 'scroll');
    if (st.error) sc.appendChild(el('div', 'empty', st.error));
    else if (st.entries === null) sc.appendChild(el('div', 'empty', '<span class="spin-sm"></span> 载入中…'));
    else {
      if (st.path) {
        var up = el('div', 'row');
        up.appendChild(el('div', 'dot idle'));
        var g0 = el('div', 'grow');
        g0.appendChild(el('div', 't', '..'));
        up.appendChild(g0);
        up.addEventListener('click', function () {
          var parts = st.path.split('/').filter(Boolean);
          parts.pop();
          loadDir(parts.join('/'));
        });
        sc.appendChild(up);
      }
      var list = st.entries || [];
      if (!list.length && !st.path) sc.appendChild(el('div', 'empty', '目录为空'));
      list.forEach(function (e) {
        var row = el('div', 'row');
        var g = el('div', 'grow');
        g.appendChild(el('div', 't', (e.type === 'directory' ? '📁 ' : '📄 ') + e.name));
        if (e.type === 'file' && e.size != null) {
          var m = el('div', 'm');
          m.appendChild(el('span', null, fmtBytes(e.size)));
          g.appendChild(m);
        }
        row.appendChild(g);
        row.addEventListener('click', function () {
          var child = st.path ? st.path + '/' + e.name : e.name;
          if (e.type === 'directory') loadDir(child);
          else previewFile(child, e.name);
        });
        sc.appendChild(row);
      });
    }
    frag.appendChild(sc);
    mount(frag);
  }

  function loadDir(path) {
    var st = S.files;
    st.path = path || '';
    st.inflight = true;
    st.entries = null;
    st.error = '';
    if (S.view === 'files') renderFiles();
    rpc('workspaceFiles/list', { workspaceFileScopeId: S.cur.id, path: st.path ? absOf(st.path) : '.' }).then(function (v) {
      st.entries = (v && v.entries) || [];
      if (v && typeof v.path === 'string') st.path = v.path;
      st.inflight = false;
      if (S.view === 'files') renderFiles();
    }).catch(function (e) {
      st.entries = [];
      st.inflight = false;
      st.error = '读取目录失败：' + e.message;
      if (S.view === 'files') renderFiles();
    });
  }

  function previewFile(path, name) {
    sheet(name, function (body) {
      body.appendChild(el('div', 'empty', '<span class="spin-sm"></span> 读取中…'));
      rpc('workspaceFiles/read', { workspaceFileScopeId: S.cur.id, path: absOf(path), range: { offset: 1, limit: 400 } })
        .then(function (v) {
          body.innerHTML = '';
          body.appendChild(el('div', 'sheet-note', '第 ' + ((v && v.offset) || 1) + ' 行起 · ' + ((v && v.lines) || 0) + ' 行' + (v && v.eof ? ' · 到文件末尾' : '')));
          var pre = el('pre');
          pre.textContent = (v && v.text) || '(空文件)';
          pre.style.maxHeight = '52vh';
          pre.style.overflow = 'auto';
          body.appendChild(pre);
        })
        .catch(function (e) {
          body.innerHTML = '';
          body.appendChild(el('div', 'empty', '这个文件不能当文本预览（' + e.message + '）'));
        });
    });
  }

  // ---------- jobs
  function renderJobs() {
    if (!needSession()) return;
    var frag = document.createDocumentFragment();
    frag.appendChild(panelHeader('后台任务', [
      { icon: 'search', label: '刷新', on: function () { S.jobs = null; renderJobs(); } }
    ]));
    var sc = el('div', 'scroll');
    if (!S.jobs) sc.appendChild(el('div', 'empty', '<span class="spin-sm"></span> 载入中…'));
    else if (S.jobs.error) sc.appendChild(el('div', 'empty', S.jobs.error));
    else if (!S.jobs.rows.length) sc.appendChild(el('div', 'empty', '没有后台任务'));
    else {
      S.jobs.rows.forEach(function (j) {
        var row = el('div', 'row');
        var g = el('div', 'grow');
        g.appendChild(el('div', 't', j.title || j.command || j.jobId || '任务'));
        var m = el('div', 'm');
        m.appendChild(el('span', null, [j.status, j.kind, j.startedAt ? fmtTime(j.startedAt) : ''].filter(Boolean).join(' · ')));
        g.appendChild(m);
        row.appendChild(g);
        var kill = el('button', 'btn ghost');
        kill.textContent = '结束';
        kill.style.padding = '6px 12px';
        kill.addEventListener('click', function (ev) {
          ev.stopPropagation();
          rpc('job/kill', { request: { sessionId: S.cur.id, jobId: j.jobId } })
            .then(function () { toast('已请求结束'); S.jobs = null; renderJobs(); })
            .catch(function (e2) { toast('失败：' + e2.message); });
        });
        row.appendChild(kill);
        sc.appendChild(row);
      });
    }
    frag.appendChild(sc);
    mount(frag);
    if (!S.jobs) loadJobs();
  }

  function loadJobs() {
    var rows = [];
    var id = mux().open('job/list', { request: { sessionId: S.cur.id } }, {
      onFrame: function (f) {
        if (f && f.type === 'rows' && Array.isArray(f.jobs)) rows = f.jobs;
        S.jobs = { rows: rows.slice() };
        if (S.view === 'jobs') renderJobs();
      },
      onEnd: function () {
        S.jobs = S.jobs || { rows: [] };
        if (S.view === 'jobs') renderJobs();
      },
      onError: function (e) {
        S.jobs = { rows: [], error: '读取任务失败：' + ((e && e.message) || '') };
        if (S.view === 'jobs') renderJobs();
      }
    });
    setTimeout(function () {
      if (S.view !== 'jobs' && S.mux) S.mux.closeStream(id);
    }, 20000);
  }

  // ---------- goal
  function renderGoal() {
    if (!needSession()) return;
    var frag = document.createDocumentFragment();
    frag.appendChild(panelHeader('长期目标'));
    var sc = el('div', 'scroll');
    var g = S.goal;
    if (g === null) sc.appendChild(el('div', 'empty', '<span class="spin-sm"></span> 载入中…'));
    else if (g === undefined) sc.appendChild(el('div', 'empty', '这个会话没有设定目标'));
    else if (g.error) sc.appendChild(el('div', 'empty', g.error));
    else {
      var box = el('div', 'pane');
      box.innerHTML = '<h2>' + esc(g.objective || g.title || '（无标题）') + '</h2>'
        + '<div class="hint">状态：' + esc(g.status || g.phase || '未知')
        + (g.roundsStarted != null ? ' · 已进行 ' + g.roundsStarted + ' 轮' : '') + '</div>';
      sc.appendChild(box);
      var dump = el('pre');
      dump.textContent = JSON.stringify(g, null, 1).slice(0, 4000);
      dump.style.margin = '0 14px';
      sc.appendChild(dump);
    }
    frag.appendChild(sc);
    mount(frag);
    if (S.goal === null) {
      rpc('goals/get', { agentId: S.cur.id }).then(function (v) {
        S.goal = v || undefined;
        if (S.view === 'goal') renderGoal();
      }).catch(function (e) {
        S.goal = { error: '读取目标失败：' + e.message };
        if (S.view === 'goal') renderGoal();
      });
    }
  }

  // ---------- settings (extra: providers / plugins, read-only)
  function renderMore() {
    var frag = document.createDocumentFragment();
    frag.appendChild(panelHeader('更多设置'));
    var sc = el('div', 'scroll');
    var box = el('div', 'pane');
    sc.appendChild(box);
    frag.appendChild(sc);
    mount(frag);
    box.appendChild(el('div', 'empty', '<span class="spin-sm"></span> 读取中…'));
    Promise.all([
      rpc('llm/listProviders', {}).catch(function (e) { return { error: e.message }; }),
      rpc('pluginInventory/list', {}).catch(function (e) { return { error: e.message }; })
    ]).then(function (res) {
      box.innerHTML = '';
      var prov = res[0], plug = res[1];
      var h = '<h2>模型供应商</h2>';
      var list = (prov && (prov.providers || prov.items)) || [];
      if (prov && prov.error) h += '<div class="hint">读取失败：' + esc(prov.error) + '</div>';
      else if (!list.length) h += '<div class="hint">' + esc(JSON.stringify(prov).slice(0, 400)) + '</div>';
      else h += list.map(function (p) {
        return '<div class="row"><div class="grow"><div class="t">' + esc(p.name || p.id) + '</div>'
          + '<div class="m"><span>' + esc(p.id || '') + '</span></div></div></div>';
      }).join('');
      h += '<h2>已装插件</h2>';
      var plugins = (plug && (plug.plugins || plug.items)) || [];
      if (plug && plug.error) h += '<div class="hint">读取失败：' + esc(plug.error) + '</div>';
      else if (!plugins.length) h += '<div class="hint">' + esc(JSON.stringify(plug).slice(0, 400)) + '</div>';
      else h += plugins.slice(0, 40).map(function (p) {
        return '<div class="row"><div class="grow"><div class="t">' + esc(p.name || p.id) + '</div>'
          + '<div class="m"><span>' + esc([p.version, p.enabled === false ? '已禁用' : ''].filter(Boolean).join(' · ')) + '</span></div></div></div>';
      }).join('');
      box.innerHTML = h;
    });
  }

  function header(title, sub, actions) {
    var h = el('div', 'hdr');
    var t = el('h1');
    t.textContent = title;
    if (sub) { var s = el('span', 'sub'); s.textContent = ' ' + sub; t.appendChild(s); }
    h.appendChild(t);
    (actions || []).forEach(function (a) {
      var b = el('button', 'iconbtn');
      b.setAttribute('aria-label', a.label);
      if (ICONS[a.icon]) b.appendChild(icon(a.icon, 19));
      else b.textContent = a.icon;
      b.addEventListener('click', a.on);
      h.appendChild(b);
    });
    return h;
  }

  // ---------- login / setup / settings
  function renderSetup(first) {
    var frag = document.createDocumentFragment();
    frag.appendChild(header(first ? '连接 DSH' : '设置', '', []));
    var pane = el('div', 'scroll');
    var inner = el('div', 'pane');
    inner.innerHTML = '<h2>服务器</h2><div class="hint">填 DSH Web 的地址，例如 http://36.138.189.24:3080（手机与它网络可达即可）。</div>';
    var f1 = el('div', 'field');
    f1.innerHTML = '<label>服务器地址</label>';
    var server = document.createElement('input');
    server.type = 'url'; server.value = S.server || 'http://36.138.189.24:3080'; server.placeholder = 'http://host:3080';
    f1.appendChild(server); inner.appendChild(f1);

    var f2 = el('div', 'field');
    f2.innerHTML = '<label>访问密码（dsh-access-gate）</label>';
    var pass = document.createElement('input');
    pass.type = 'password'; pass.value = S.pass || ''; pass.placeholder = '留空表示该实例未设密码';
    f2.appendChild(pass); inner.appendChild(f2);

    var f3 = el('div', 'field');
    f3.innerHTML = '<label>默认工作目录（新建会话用，必须是服务器上的路径）</label>';
    var cwd = document.createElement('input');
    cwd.type = 'text'; cwd.value = S.cwd || ''; cwd.placeholder = 'D:\\Users\\Administrator\\Documents\\deepseek-harness\\work';
    f3.appendChild(cwd); inner.appendChild(f3);

    var err = el('div', 'err-box'); err.hidden = true;
    inner.appendChild(err);

    var go = el('button', 'btn', '连接并登录');
    go.style.width = '100%';
    go.addEventListener('click', function () {
      S.server = server.value.trim().replace(/\/+$/, '');
      S.pass = pass.value;
      S.cwd = cwd.value.trim();
      lsSet(K.server, S.server); lsSet(K.pass, S.pass); lsSet(K.cwd, S.cwd);
      go.disabled = true; go.textContent = '连接中…'; err.hidden = true;
      if (applyServerToShell()) return;   // native shell reloads at the new origin
      login(S.server, S.pass).then(function () {
        S.view = 'sessions';
        resetMux();
        loadSessions().catch(function (e) { err.hidden = false; err.textContent = e.message; });
        render();
      }).catch(function (e) {
        go.disabled = false; go.textContent = '连接并登录';
        err.hidden = false; err.textContent = '连接失败：' + e.message;
      });
    });
    inner.appendChild(go);

    const t = el('div', 'field');
    t.innerHTML = '<h2>外观</h2>';
    var themeBtn = el('button', 'btn ghost', S.theme === 'dark' ? '切换为浅色' : '切换为深色');
    themeBtn.addEventListener('click', function () {
      S.theme = S.theme === 'dark' ? 'light' : 'dark';
      lsSet(K.theme, S.theme);
      document.documentElement.dataset.theme = S.theme;
      render();
    });
    t.appendChild(themeBtn);
    var injectBtn = el('button', 'btn ghost', S.showInject ? '隐藏上下文注入' : '显示上下文注入');
    injectBtn.style.marginTop = '8px';
    injectBtn.addEventListener('click', function () {
      S.showInject = !S.showInject;
      lsSet(K.inject, S.showInject ? '1' : '0');
      render();
      if (S.cur) renderChat(true);
    });
    t.appendChild(injectBtn);
    inner.appendChild(t);

    var more = el('button', 'btn ghost', '更多设置（模型供应商 / 插件）');
    more.style.width = '100%'; more.style.marginTop = '10px';
    more.addEventListener('click', function () { S.prevView = 'settings'; S.view = 'more'; render(); });
    inner.appendChild(more);

    if (S.server) {
      var back = el('button', 'btn ghost', '返回会话列表');
      back.style.width = '100%'; back.style.marginTop = '10px';
      back.addEventListener('click', function () { S.view = 'sessions'; render(); });
      inner.appendChild(back);
    }
    pane.appendChild(inner);
    frag.appendChild(pane);
    mount(frag);
  }

  function renderLogin() {
    if (!S.server) return renderSetup(true);
    var frag = document.createDocumentFragment();
    frag.appendChild(header('需要登录', S.server.replace(/^https?:\/\//, ''), []));
    var pane = el('div', 'scroll');
    var inner = el('div', 'pane');
    inner.innerHTML = '<div class="hint">访问密码已失效或未登录，重新输入密码即可。</div>';
    var pass = document.createElement('input');
    pass.type = 'password'; pass.value = S.pass || ''; pass.placeholder = '访问密码';
    inner.appendChild(pass);
    var err = el('div', 'err-box'); err.hidden = true; inner.appendChild(err);
    var go = el('button', 'btn', '登录'); go.style.width = '100%';
    go.addEventListener('click', function () {
      S.pass = pass.value; lsSet(K.pass, S.pass);
      go.disabled = true; go.textContent = '登录中…';
      login(S.server, S.pass).then(function () {
        S.view = 'sessions'; resetMux();
        loadSessions(); render();
      }).catch(function (e) { go.disabled = false; go.textContent = '登录'; err.hidden = false; err.textContent = e.message; });
    });
    inner.appendChild(go);
    var cfg = el('button', 'btn ghost', '修改服务器地址'); cfg.style.width = '100%'; cfg.style.marginTop = '10px';
    cfg.addEventListener('click', function () { S.view = 'setup'; render(); });
    inner.appendChild(cfg);
    pane.appendChild(inner); frag.appendChild(pane);
    mount(frag);
  }

  function renderSettings() { renderSetup(false); }

  function showLogin() {
    if (S.view === 'login' || S.view === 'setup') return;
    if (S.cur && S.cur.followId && S.mux) S.mux.closeStream(S.cur.followId);
    S.cur = null; S.view = 'login'; render();
  }

  /** After a successful login, drop the unauthenticated mux and reconnect. */
  function resetMux() {
    if (S.mux) { S.mux.closed = true; try { S.mux.ws && S.mux.ws.close(); } catch (e) {} S.mux = null; }
    S.muxReady = false;
    S.forwardId = null;
    S.clientId = '';
    S.interactive = [];
    mux();
    attachForwardedEvents();
  }

  /** Android back button: chat → list → settings → exit. */
  function goBack() {
    if (S.view === 'chat') { leaveChat(); return 'nav'; }
    if (S.view === 'files' || S.view === 'jobs' || S.view === 'goal' || S.view === 'more') { closePanel(); return 'nav'; }
    if (S.view === 'settings') { S.view = S.server ? 'sessions' : 'setup'; render(); return 'nav'; }
    if (S.view === 'login') { S.view = 'sessions'; render(); return 'nav'; }
    return 'exit';
  }

  /** Move the native shell to another instance (reloads the WebView origin). */
  function applyServerToShell() {
    try {
      if (window.DSHMAndroid && window.DSHMAndroid.getServer && window.DSHMAndroid.getServer() !== S.server) {
        window.DSHMAndroid.setServer(S.server);
        return true;
      }
    } catch (e) {}
    return false;
  }

  // ─────────────────────────────────────────────────────────── boot
  function boot() {
    document.documentElement.dataset.theme = S.theme;
    mount(el('div', 'boot'));
    app.innerHTML = '<div class="boot"><div class="boot-dot"></div></div>';
    setTimeout(run, 0);
  }

  function run() {
    if (!S.server) { S.view = 'setup'; render(); return; }
    // Paint the cached list immediately, then refresh.
    S.view = 'sessions';
    render();
    mux();
    attachForwardedEvents();
    loadSessions().catch(function (e) {
      if (e.code === 'unauthenticated') showLogin();
      else { S.lastError = '连不上服务器：' + e.message; render(); }
    });
    // The $events stream keeps the list live; this slow poll is only a safety net.
    setInterval(function () {
      if (S.view === 'sessions' && document.visibilityState === 'visible') loadSessions().catch(function () {});
    }, 30000);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.view === 'sessions') loadSessions().catch(function () {});
  });

  window.__DSHM__ = {
    state: S, rpc: rpc, md: md, login: login, back: goBack,
    // test hooks (used by test/harness*.mjs)
    open: function (id, title) { openSession(id, title); },
    panel: function (k) { openPanel(k); },
    send: function (text) { return sendPrompt(text, []); },
    list: function () { return loadSessions(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();


