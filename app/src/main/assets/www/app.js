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
  var K = { server: 'dshm.server', pass: 'dshm.pass', theme: 'dshm.theme', cache: 'dshm.cache', cwd: 'dshm.cwd', inject: 'dshm.inject', collapsed: 'dshm.collapsed' };
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
          var code = esc(body.replace(/\n$/, ''));
          out += '<div class="codeblock"><div class="codebar"><span>' + esc(lang || 'code') + '</span>'
            + '<button class="codecopy" type="button">复制</button></div><pre><code>' + code + '</code></pre></div>';
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
    term: null,
    sched: null,
    ws: null,
    settings: null,
    skills: null,
    modelMenu: null,   // open model popover, so the chip can toggle it
    permMenu: null,
    authed: false,      // true once a request has succeeded; gates the mux
    loginPass: '',      // survives re-renders of the login form
    drawer: null,
    drawerQuery: '',
    collapsedCwds: lsJSON(K.collapsed, {}),   // workspace groups the user folded away
    blankOpen: {},                            // blank-session groups the user expanded
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
    // Before login the handshake is rejected (403), and every rejection used to
    // re-render the shell — that is what made the login form unusable.
    if (this.closed || !S.authed) return;
    try { this.ws = new WebSocket(this.url()); } catch (e) { return this.scheduleRetry(); }
    this.ws.onopen = function () {
      self.retry = 0;
      S.muxReady = true;
      self.streams.forEach(function (st) { self.send({ type: 'open', streamId: st.id, endpoint: st.endpoint, payload: { args: st.args } }); });
      if (S.view !== 'login' && S.view !== 'setup') render();
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
      if (!self.closed && S.authed) self.scheduleRetry();
      if (S.view !== 'login' && S.view !== 'setup') render();
    };
    this.ws.onerror = function () {};
  };
  Mux.prototype.scheduleRetry = function () {
    var self = this;
    this.retry = Math.min(this.retry + 1, 6);
    setTimeout(function () { if (S.authed) self.connect(); }, 500 * Math.pow(1.7, this.retry));
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
  /** Push one uplink item on a bidirectional stream (terminal input/ack protocol). */
  Mux.prototype.push = function (id, value) {
    if (!this.streams.has(id)) return false;
    return this.send({ type: 'item', streamId: id, value: value });
  };
  Mux.prototype.closeStream = function (id) {
    if (this.streams.has(id)) { this.send({ type: 'end', streamId: id }); this.streams.delete(id); }
  };
  Mux.prototype.closeAll = function () { this.streams.clear(); };

  function mux() {
    if (!S.mux) S.mux = new Mux();
    if (S.authed && !S.mux.ws && !S.mux.closed) S.mux.connect();
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
      S.authed = true;
      S.sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      try { wsEnsure(); } catch (e) {}
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
    if (S.view === 'trajectory') return renderTrajectory();
    if (S.view === 'info') return renderInfo();
    if (S.view === 'sched') return renderSchedule();
    if (S.view === 'skills') return renderSkills();
    if (S.view === 'workspace') return renderWorkspace();
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
    if (!S.query && S.ws && S.ws.archived && S.ws.archived.length) {
      var ab = el('div', 'row');
      ab.appendChild(el('div', 'dot idle'));
      var abg = el('div', 'grow');
      abg.appendChild(el('div', 't', '归档箱'));
      var abm = el('div', 'm');
      abm.appendChild(el('span', null, S.ws.archived.length + ' 个已归档会话 · 点这里恢复'));
      abg.appendChild(abm);
      ab.appendChild(abg);
      ab.addEventListener('click', archiveBox);
      sc.appendChild(el('div', 'group-label', '归档箱'));
      sc.appendChild(ab);
    }
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
    var live = S.sessions.filter(function (s) { return !isArchived(s.sessionId); });
    var rows = !q ? live : live.filter(function (s) {
      var title = (s.projections && s.projections.values && (s.projections.values.title || '')) || '';
      return title.toLowerCase().indexOf(q) >= 0 || (s.cwd || '').toLowerCase().indexOf(q) >= 0;
    });
    if (!S.ws || !S.ws.pinned.length) return rows;
    var pin = [], rest = [];
    rows.forEach(function (s) { (isPinned(s.sessionId) ? pin : rest).push(s); });
    return pin.concat(rest);
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
    if (isPinned(s.sessionId)) m.appendChild(el('span', 'tag', '★ 置顶'));
    if (s.origin === 'subagent') m.appendChild(el('span', 'tag', '子代理'));
    g.appendChild(m);
    row.appendChild(g);
    row.addEventListener('click', function () { openSession(s.sessionId, title); });
    attachLongPress(row, function () { sessionActions(s); });
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
      { icon: 'more', label: '菜单', on: function () { chatMenu(); } }
    ], [
      { icon: 'menu', label: '会话列表', on: openDrawer }
    ]));
    var st = statsText(cur);
    var line = el('div', 'statline', st);
    if (!st) line.style.display = 'none';
    frag.appendChild(line);
    var wrap = el('div', 'chatwrap');
    var log = el('div', 'scroll log');
    wrap.appendChild(log);
    var jump = el('button', 'jumpbtn');
    jump.setAttribute('aria-label', '回到最新');
    jump.appendChild(icon('down', 18));
    jump.addEventListener('click', function () { log.scrollTop = log.scrollHeight; });
    wrap.appendChild(jump);
    frag.appendChild(wrap);
    chatRefs.jump = jump;
    log.addEventListener('scroll', function () {
      var away = log.scrollHeight - log.scrollTop - log.clientHeight > 220;
      jump.classList.toggle('on', away);
    }, { passive: true });
    frag.appendChild(composer());
    mount(frag);
    chatRefs.log = log;
    chatRefs.statline = line;
    renderedCount = 0;
    renderChat(true);
  }

  /** Left drawer: the desktop's persistent session sidebar, folded away on a phone. */
  function openDrawer() {
    if (S.drawer) { closeDrawer(); return; }
    var back = el('div', 'drawer-back');
    var box = el('div', 'drawer');

    var head = el('div', 'dhead');
    head.appendChild(el('h2', null, '会话'));
    var nw = el('button', 'iconbtn');
    nw.setAttribute('aria-label', '新会话');
    nw.appendChild(icon('plus', 19));
    nw.addEventListener('click', function () { closeDrawer(); newSession(); });
    head.appendChild(nw);
    var cl = el('button', 'iconbtn');
    cl.setAttribute('aria-label', '关闭');
    cl.appendChild(icon('back', 19));
    cl.addEventListener('click', closeDrawer);
    head.appendChild(cl);
    box.appendChild(head);

    var sb = el('div', 'dsearch');
    var q = document.createElement('input');
    q.type = 'search';
    q.placeholder = '搜索会话';
    q.value = S.drawerQuery || '';
    sb.appendChild(q);
    box.appendChild(sb);

    var list = el('div', 'dlist');
    box.appendChild(list);

    function paint() {
      list.innerHTML = '';
      var qs = (S.drawerQuery || '').trim().toLowerCase();
      var live = S.sessions.filter(function (x) { return !isArchived(x.sessionId); });
      if (qs) {
        live = live.filter(function (x) {
          var t = (x.projections && x.projections.values && (x.projections.values.title || '')) || '';
          return t.toLowerCase().indexOf(qs) >= 0 || (x.cwd || '').toLowerCase().indexOf(qs) >= 0;
        });
      }
      var pin = [], rest = [];
      live.forEach(function (x) { (isPinned(x.sessionId) ? pin : rest).push(x); });
      var rows = pin.concat(rest);
      if (!rows.length) { list.appendChild(el('div', 'empty', S.sessions.length ? '没有匹配的会话' : '正在读取…')); return; }

      // one block per workspace, first-seen order (the input is newest-first)
      var order = [], byCwd = {};
      rows.forEach(function (x) {
        var k = x.cwd || '';
        if (!byCwd[k]) { byCwd[k] = []; order.push(k); }
        byCwd[k].push(x);
      });

      order.forEach(function (cwd) {
        var items = byCwd[cwd];
        var blank = items.filter(function (x) { return x.blank && !isPinned(x.sessionId); });
        var real = items.filter(function (x) { return !(x.blank && !isPinned(x.sessionId)); });

        var collapsed = !!S.collapsedCwds[cwd];
        var head = el('div', 'dgroup' + (collapsed ? '' : ' open'));
        head.appendChild(el('span', 'dchev'));
        head.appendChild(el('span', 'dglabel', baseName(cwd) || cwd || '工作区'));
        head.appendChild(el('span', 'dgcount', String(real.length + blank.length)));
        head.setAttribute('role', 'button');
        head.addEventListener('click', function () {
          S.collapsedCwds[cwd] = !collapsed;
          lsSet(K.collapsed, JSON.stringify(S.collapsedCwds));
          paint();
        });
        list.appendChild(head);
        if (collapsed) return;

        function addRow(x, label) {
          var r = el('div', 'drow' + (S.cur && S.cur.id === x.sessionId ? ' cur' : ''));
          r.appendChild(el('div', 'dot ' + (x.running ? 'run' : 'idle')));
          var t = label || (x.projections && x.projections.values && x.projections.values.title)
            || (x.blank ? '（空会话）' : '（无标题）');
          r.appendChild(el('div', 'dt', (isPinned(x.sessionId) ? '★ ' : '') + t));
          r.appendChild(el('div', 'dm', fmtTime(x.updatedAt)));
          r.addEventListener('click', function () {
            closeDrawer();
            if (!S.cur || S.cur.id !== x.sessionId) openSession(x.sessionId, t);
          });
          attachLongPress(r, function () { closeDrawer(); sessionActions(x); });
          list.appendChild(r);
        }

        real.forEach(function (x) { addRow(x); });

        // Blank sessions pile up fast (every "new chat" that was never used), so they
        // collapse into one row instead of flooding the list.
        if (blank.length) {
          var openKey = cwd || '';
          var shown = !!S.blankOpen[openKey];
          var brow = el('div', 'drow blankrow');
          brow.appendChild(el('div', 'dot idle'));
          var bg = el('div', 'grow');
          bg.appendChild(el('div', 'dt', '空会话 · ' + blank.length + ' 个'));
          bg.appendChild(el('div', 'dm', shown ? '点一下收起' : '点一下展开'));
          brow.appendChild(bg);
          brow.appendChild(el('div', 'dm', shown ? '▾' : '▸'));
          brow.addEventListener('click', function () {
            S.blankOpen[openKey] = !shown;
            paint();
          });
          list.appendChild(brow);
          if (shown) blank.forEach(function (x) { addRow(x); });
        }
      });
    }

    paint();
    q.addEventListener('input', function () {
      S.drawerQuery = q.value;
      paint();
    });

    var foot = el('div', 'dfoot');
    [['工作区', function () { closeDrawer(); openPanel('workspace'); }],
     ['归档箱', function () { closeDrawer(); archiveBox(); }],
     ['设置', function () { closeDrawer(); S.view = 'settings'; render(); }]].forEach(function (b) {
      var btn = el('button', 'kbtn', b[0]);
      btn.addEventListener('click', b[1]);
      foot.appendChild(btn);
    });
    box.appendChild(foot);

    back.appendChild(box);
    back.addEventListener('click', function (ev) { if (ev.target === back) closeDrawer(); });
    document.body.appendChild(back);
    S.drawer = back;
    requestAnimationFrame(function () { back.classList.add('in'); });
  }

  function closeDrawer() {
    var back = S.drawer;
    S.drawer = null;
    if (!back) return;
    back.classList.remove('in');
    setTimeout(function () { back.remove(); }, 200);
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
    items.push(['终端', openTerminal]);
    items.push(['文件', function () { openPanel('files'); }]);
    items.push(['后台任务', function () { openPanel('jobs'); }]);
    items.push(['长期目标', function () { openPanel('goal'); }]);
    items.push(['定时任务', function () { openPanel('sched'); }]);
    items.push(['工作区（置顶/归档）', function () { openPanel('workspace'); }]);
    items.push(['会话信息（计划/待办/交付物）', function () { openPanel('info'); }]);
    items.push(['轨迹', function () { openPanel('trajectory'); }]);
    items.push(['技能', function () { openPanel('skills'); }]);
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

  /** Clipboard with three fallbacks: the Android bridge, the async API, then execCommand. */
  function copy(t) {
    var text = String(t == null ? '' : t);
    try {
      if (window.DSHMAndroid && window.DSHMAndroid.copy) { window.DSHMAndroid.copy(text); toast('已复制'); return true; }
    } catch (e) {}
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        toast('已复制');
        return true;
      }
    } catch (e) {}
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      ta.remove();
      if (ok) { toast('已复制'); return true; }
    } catch (e) {}
    toast(text.length > 120 ? text.slice(0, 120) + '…' : text);
    return false;
  }

  function renameCur() {
    var t = prompt('新的会话标题', S.cur.projections.title || S.cur.title || '');
    if (!t) return;
    rpc('session/rename', { request: { sessionId: S.cur.id, title: t } }).then(function () {
      S.cur.title = t; S.cur.projections.title = t; render();
    }).catch(function (e) { toast('失败：' + e.message); });
  }

  /** Switch the session's permission preset through the `/permission` command. */
  function pickPermission(trigger) {
    if (!S.cur) { toast('先打开一个会话'); return; }
    if (S.permMenu) { S.permMenu.close(); return; }
    rpc('permissionPresets/catalog', {}).then(function (cat) {
      var current = (S.cur.projections.permissions || {}).currentValue || '';
      var menu = chipMenu({
        top: 'calc(var(--sat) + 50px)',
        width: '76vw',
        maxWidth: '320px',
        trigger: trigger,
        onClose: function () { S.permMenu = null; }
      });
      S.permMenu = menu;
      menu.head('权限预设（当前：' + (current || '未知') + '）');
      (cat.options || []).forEach(function (o) {
        menu.item(o.name || o.value, { v: o.value }, o.value === current);
      });
      menu.cancelRow();
      menu.node.addEventListener('click', function (ev) {
        var d = ev.target.closest('[data-v]');
        if (!d) return;
        menu.close();
        var preset = d.dataset.v;
        rpc('commands/execute', { agentId: S.cur.id, line: '/permission ' + preset, submittedAttachments: [] })
          .then(function () {
            S.cur.projections.permissions = { currentValue: preset };
            renderComposer();
            toast('已切换为 ' + preset);
          })
          .catch(function (e) { toast('切换失败：' + e.message); });
      });
    }).catch(function (e) { toast('读取预设失败：' + e.message); });
  }

  function pickModel(trigger) {
    if (!S.cur) { toast('先打开一个会话'); return; }
    if (S.modelMenu) { S.modelMenu.close(); return; }   // tapping the chip again closes it
    rpc('session/modelCatalog', {}).then(function (cat) {
      var menu = chipMenu({
        top: 'calc(var(--sat) + 50px)',
        width: '76vw',
        maxWidth: '360px',
        trigger: trigger,
        onClose: function () { S.modelMenu = null; }
      });
      S.modelMenu = menu;
      menu.head('默认：' + (cat.default ? cat.default.provider + ' / ' + cat.default.model : '未知'));
      (cat.groups || []).forEach(function (g) {
        menu.head(g.name || g.id);
        (g.models || []).forEach(function (m) {
          menu.item(m.name || m.id, { p: g.id, m: m.id });
        });
      });
      menu.cancelRow();
      menu.node.addEventListener('click', function (ev) {
        var d = ev.target.closest('[data-p]');
        if (!d) return;
        menu.close();
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

  function renderChat(force, keepPos) {
    if (!chatRefs.log || !S.cur) return;
    var prevTop = chatRefs.log.scrollTop, prevMax = chatRefs.log.scrollHeight;
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
    var stick = chatRefs.log.scrollTop + chatRefs.log.clientHeight >= chatRefs.log.scrollHeight - 140;
    var top = chatRefs.log.scrollTop;
    updateLiveNode(S.cur);
    // Projections only exist after the snapshot: fill the stats line and chips now.
    if (chatRefs.statline) {
      var stText = statsText(S.cur);
      chatRefs.statline.textContent = stText + (S.cur.projections.agentPreset ? ' · ' + S.cur.projections.agentPreset : '');
      chatRefs.statline.style.display = stText ? '' : 'none';
    }
    renderComposer();
    if (keepPos && prevMax) { chatRefs.log.scrollTop = Math.max(0, prevTop + (chatRefs.log.scrollHeight - prevMax)); }
    else if (force || stick) { chatRefs.log.scrollTop = chatRefs.log.scrollHeight; }
    else { chatRefs.log.scrollTop = top; }
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
      renderChat(true, true);
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
    if (node) {
      if (item.seq != null) node.dataset.seq = String(item.seq);
      log.appendChild(node);
    }
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
      c.dataset.chip = 'model';
      c.addEventListener('click', function () { pickModel(c); });
      chips.appendChild(c);
    }
    var perms = cur && cur.projections && cur.projections.permissions;
    if (perms && perms.currentValue) {
      var pc = el('span', 'chip', perms.currentValue);
      pc.dataset.chip = 'perm';
      pc.addEventListener('click', function () { pickPermission(pc); });
      chips.appendChild(pc);
    }
    var linkChip = el('span', 'chip' + (S.muxReady ? ' run' : ''), S.muxReady ? '● 已连接' : '连接中…');
    linkChip.dataset.chip = 'link';
    chips.appendChild(linkChip);
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
    command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z',
  refresh: 'M20.5 12a8.5 8.5 0 1 1-2.9-6.4M21 4v5.5h-5.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  down: 'M12 5v14M5 12l7 7 7-7',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9-5.3-2.9-5.3 2.9 1.1-5.9L3.5 9.7l5.9-.8z',
  archive: 'M3.5 7.5h17M5.5 7.5V19a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7.5M9.5 7.5v-2a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v2M10 12.5h4'
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
      document.removeEventListener('keydown', onKey);
      back.classList.add('out');
      setTimeout(function () { back.remove(); }, 160);
    };
    back.addEventListener('click', function (ev) { if (ev.target === back) close(); });
    grab.style.cursor = 'pointer';
    grab.addEventListener('click', function () { close(); });
    var onKey = function (ev) { if (ev.key === 'Escape' || ev.key === 'Esc') close(); };
    document.addEventListener('keydown', onKey);
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

  /**
   * Floating chip menu. Every dismissal path is wired: tap outside, Escape, or the
   * 取消 row — a menu that can only be left by making a choice is a trap.
   */
  function chipMenu(opts) {
    opts = opts || {};
    var node = el('div', 'toast chipmenu');
    node.style.bottom = 'auto';
    node.style.top = opts.top || 'calc(var(--sat) + 50px)';
    node.style.borderRadius = '14px';
    node.style.padding = '6px';
    node.style.textAlign = 'left';
    node.style.width = opts.width || '76vw';
    if (opts.maxWidth) node.style.maxWidth = opts.maxWidth;
    node.style.maxHeight = '70vh';
    node.style.overflowY = 'auto';

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('click', outside, true);
      document.removeEventListener('keydown', onKey);
      node.remove();
      if (opts.onClose) opts.onClose();
    }
    function outside(ev) {
      if (node.contains(ev.target)) return;
      if (opts.trigger && opts.trigger.contains && opts.trigger.contains(ev.target)) return;
      close();
    }
    function onKey(ev) { if (ev.key === 'Escape' || ev.key === 'Esc') close(); }

    document.body.appendChild(node);
    // register on the next tick so the tap that opened the menu does not close it
    setTimeout(function () {
      if (closed) return;
      document.addEventListener('click', outside, true);
      document.addEventListener('keydown', onKey);
    }, 0);

    return {
      node: node,
      close: close,
      head: function (text) {
        var h = el('div', 'chipmenu-head', text);
        node.appendChild(h);
        return h;
      },
      item: function (label, dataset, active) {
        var d = el('div', 'chipmenu-item' + (active ? ' on' : ''), label);
        Object.keys(dataset || {}).forEach(function (k) { d.dataset[k] = dataset[k]; });
        node.appendChild(d);
        return d;
      },
      cancelRow: function () {
        var c = el('div', 'chipmenu-cancel', '取消');
        c.setAttribute('role', 'button');
        c.addEventListener('click', function (ev) { ev.stopPropagation(); close(); });
        node.appendChild(c);
        return c;
      }
    };
  }

  /** Compact token/time summary for the open session. */
  function statsText(cur) {
    var p = (cur && cur.projections) || {};
    var u = p.tokenUsage || {};
    var s = p.sessionStats || {};
    var bits = [];
    var tok = function (n) {
      if (!n) return '0';
      if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
      if (n >= 1e3) return Math.round(n / 1e3) + 'k';
      return String(n);
    };
    if (u.cacheReadTokens || u.uncachedInputTokens) {
      bits.push(tok((u.uncachedInputTokens || 0) + (u.cacheReadTokens || 0)) + ' in');
    }
    if (u.outputTokens) bits.push(tok(u.outputTokens) + ' out');
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

  // ---------- trajectory (turns / steps / tools / duration)
  function renderTrajectory() {
    if (!needSession()) return;
    var frag = document.createDocumentFragment();
    frag.appendChild(panelHeader('轨迹'));
    var sc = el('div', 'scroll');
    var turns = {};
    (S.cur.records || []).forEach(function (r) {
      var e = r.event || {};
      var d = e.data || {};
      if (d.turn == null) return;
      var o = turns[d.turn] || (turns[d.turn] = { steps: 0, tools: 0, t0: null, t1: null });
      if (e.type === 'step/start') o.steps++;
      if (e.type === 'tool/call') o.tools++;
      if (e.time) {
        o.t0 = o.t0 === null ? e.time : Math.min(o.t0, e.time);
        o.t1 = o.t1 === null ? e.time : Math.max(o.t1, e.time);
      }
    });
    var keys = Object.keys(turns).map(Number).sort(function (a, b) { return b - a; });
    if (!keys.length) sc.appendChild(el('div', 'empty', '还没有可展示的回合'));
    var outline = S.cur.projections.turnOutline || [];
    keys.forEach(function (k) {
      var o = turns[k];
      var hit = outline.filter(function (x) { return x.turn === k; })[0] || {};
      var row = el('div', 'row');
      var g = el('div', 'grow');
      var prompt = hit.prompt ? String(hit.prompt).replace(/\s+/g, ' ') : '';
      g.appendChild(el('div', 't', '回合 ' + k + (prompt ? ' · ' + truncate(prompt, 34) : '')));
      var m = el('div', 'm');
      var secs = (o.t0 && o.t1) ? Math.max(1, Math.round((o.t1 - o.t0) / 1000)) + 's' : '';
      m.appendChild(el('span', null, [o.steps + ' 步', o.tools + ' 工具', secs].filter(Boolean).join(' · ')));
      g.appendChild(m);
      row.appendChild(g);
      if (hit.seq != null) row.addEventListener('click', (function (s) { return function () { jumpToSeq(s); }; })(hit.seq));
      sc.appendChild(row);
    });
    frag.appendChild(sc);
    mount(frag);
  }

  /** Close the panel and scroll the conversation to the given event seq. */
  function jumpToSeq(seq) {
    closePanel();
    setTimeout(function () {
      var log = chatRefs.log;
      if (!log) return;
      var nodes = log.querySelectorAll('[data-seq]');
      var best = null;
      for (var i = 0; i < nodes.length; i++) {
        var v = Number(nodes[i].dataset.seq);
        if (!isNaN(v) && v <= seq) best = nodes[i];
      }
      (best || nodes[0] || log).scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 150);
  }

  // ---------- session info: plan / todos / deliverables / subagents
  // Everything here is derived from state the client already holds (projections
  // and the durable record stream), so it adds no protocol surface.
  function renderInfo() {
    if (!needSession()) return;
    var cur = S.cur;
    var frag = document.createDocumentFragment();
    frag.appendChild(panelHeader('会话信息'));
    var sc = el('div', 'scroll');
    var box = el('div', 'pane');
    sc.appendChild(box);
    frag.appendChild(sc);
    mount(frag);

    var p = cur.projections || {};
    var html = '';

    var plan = p.plan || {};
    if (plan && (plan.active || plan.pending)) {
      html += '<h2>计划模式</h2><div class="hint">' + (plan.active ? '正在执行计划' : (plan.pending ? '待确认计划' : '')) + '</div>';
    }

    var todos = p.todos || [];
    if (todos.length) {
      var done = todos.filter(function (x) { return x.status === 'completed'; }).length;
      html += '<h2>待办 ' + done + '/' + todos.length + '</h2><ul>';
      todos.forEach(function (x) {
        var mark = x.status === 'completed' ? '✔' : x.status === 'in_progress' ? '▶' : '○';
        html += '<li>' + esc(mark + ' ' + x.content) + '</li>';
      });
      html += '</ul>';
    }

    var files = [];
    (cur.records || []).forEach(function (r) {
      var e = r.event || {};
      if (e.type !== 'tool/call') return;
      if (e.data && e.data.name === 'present') {
        var a = safeJson(e.data.arguments);
        if (a && Array.isArray(a.files)) {
          a.files.forEach(function (f) {
            if (f && f.path && !files.some(function (x) { return x.path === f.path; })) files.push(f);
          });
        }
      }
    });
    html += '<h2>交付物 ' + (files.length || '') + '</h2>';
    if (!files.length) html += '<div class="hint">这个会话还没有 present 交付物</div>';
    files.forEach(function (f) {
      html += '<div class="row" data-path="' + esc(f.path) + '"><div class="grow">'
        + '<div class="t">' + esc(baseName(f.path)) + '</div>'
        + '<div class="m"><span class="path">' + esc(f.path) + '</span></div></div></div>';
    });

    var subs = p.subagentCatalog || p.subagent || null;
    var kids = [];
    (cur.records || []).forEach(function (r) {
      var e = r.event || {};
      if (e.type === 'subagent/catalog' && e.data && e.data.childId) kids.push(e.data);
    });
    if (kids.length) {
      html += '<h2>子代理 ' + kids.length + '</h2>';
      kids.forEach(function (k) {
        html += '<div class="row" data-open="' + esc(k.childId) + '"><div class="grow">'
          + '<div class="t">' + esc(k.label || k.childId) + '</div>'
          + '<div class="m"><span>' + esc(k.mode || '') + '</span></div></div></div>';
      });
    }

    var stats = statsText(cur);
    html += '<h2>用量</h2><div class="hint">' + esc(stats || '暂无') + '</div>';

    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('[data-open]'), function (row) {
      row.addEventListener('click', function () { openSession(row.dataset.open, '子代理'); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-path]'), function (row) {
      row.addEventListener('click', function () {
        try { navigator.clipboard.writeText(row.dataset.path); toast('路径已复制'); } catch (e) { toast(row.dataset.path); }
      });
    });
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
    if (kind === 'sched') S.sched = { filter: S.sched ? S.sched.filter : null, items: null, error: '', loading: false, total: 0 };
    if (kind === 'workspace') wsEnsure();
    if (kind === 'skills') S.skills = null;
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

  // ---------- terminal
  //
  // Protocol (verified live 2026-11-10 against dsh 0.2.2-rc.1):
  //   environment(agentId) -> {cwd,maxInputBytes,maxBufferedBytes,maxCols,maxRows,scrollback}
  //   shells(agentId)      -> [{path,name,args}]
  //   list(sessionId)      -> WebTerminalInfo[]          (note: sessionId, not agentId)
  //   create(agentId,{id,shellPath?,cols,rows}) -> WebTerminalInfo   (id is client-minted, idempotent)
  //   retain(sessionId,id) stream -> [{type:'retained'}]  (physical window hold; stops idle reaping)
  //   attach(agentId,id) BIDIRECTIONAL stream:
  //     down -> {type:'snapshot',sequence,screen,info,writable,inputWindow?}
  //             {type:'output',sequence,data} | {type:'state',info,writable}
  //             {type:'ack',sequence,refusal?}
  //     up   -> {type:'write',sequence,data} | {type:'resize',sequence,cols,rows}
  //            sent as {type:'item', streamId, value}; sequences run 1,2,3… per attachment.
  //   close(agentId,id) | rename(agentId,id,title)
  // 0.2.2 removed terminal/follow, terminal/write and terminal/resize — input and resize
  // ride the attach stream, and "am I allowed to type" is the frame's own `writable`.
  // The screen snapshot is @xterm/addon-serialize output, so we must run the same
  // xterm version the host uses (6.0.0) — loaded lazily from assets on first open.
  var xtermLoad = null;

  function loadXterm() {
    if (window.Terminal && window.FitAddon) return Promise.resolve();
    if (xtermLoad) return xtermLoad;
    xtermLoad = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = './vendor/xterm.css';
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = './vendor/xterm.js';
      s.onload = function () { if (window.Terminal) resolve(); else reject(new Error('终端组件未就绪')); };
      s.onerror = function () { xtermLoad = null; reject(new Error('终端组件加载失败')); };
      document.head.appendChild(s);
    });
    return xtermLoad;
  }

  function termKey(sid) { return 'dshm.term.' + sid; }

  function termTheme() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (n, d) { var x = (cs.getPropertyValue(n) || '').trim(); return x || d; };
    var light = document.documentElement.dataset.theme === 'light';
    return {
      background: v('--bg-elev', '#171a21'),
      foreground: v('--fg', '#e7e9ee'),
      cursor: v('--accent', '#4f8cff'),
      cursorAccent: v('--bg-elev', '#171a21'),
      selectionBackground: light ? 'rgba(47,111,228,.22)' : 'rgba(79,140,255,.32)',
      black: light ? '#40474f' : '#1b1f27', red: '#e5484d', green: light ? '#127a52' : '#3ddc97',
      yellow: light ? '#8a6116' : '#e7c15a', blue: light ? '#2f6fe4' : '#4f8cff',
      magenta: light ? '#8a3fa8' : '#c792ea', cyan: light ? '#0e7490' : '#56c8d8',
      white: light ? '#5b6472' : '#d6dae2',
      brightBlack: light ? '#78828f' : '#5a6373', brightRed: '#ff6b6b', brightGreen: '#63e8ad',
      brightYellow: '#f0d07c', brightBlue: '#79a7ff', brightMagenta: '#d9a9f5',
      brightCyan: '#7ad8e6', brightWhite: light ? '#131722' : '#ffffff'
    };
  }

  function termFail(st, msg) {
    if (!st || st.disposed) return;
    st.error = msg || '未知错误';
    st.status = 'error';
    st.writable = false;
    termStatus(st);
  }

  function termErrText(e) {
    if (!e) return '未知错误';
    if (e.code === 'terminal/limit-reached') return '终端数量已达上限（' + ((e.details && e.details.limit) || '?') + '），先关闭一个';
    if (e.code === 'terminal/unavailable') return '终端已结束，请新建';
    if (e.code === 'terminal/control-unavailable') return '没有输入控制权（另一个窗口正在操作）';
    return e.message || String(e);
  }

  function termStatus(st) {
    if (!st || st.disposed) return;
    var info = st.info || {};
    var label = st.error ? st.error
      : st.status === 'connecting' ? '连接中…'
        : st.status === 'ended' || st.status === 'closed' ? '已断开'
          : st.status === 'exited' ? '进程已退出' + (info.exitCode != null ? '（' + info.exitCode + '）' : '')
            : st.status === 'failed' ? '启动失败'
              : st.writable ? '运行中' : '只读';
    if (st.sub) {
      var bits = [];
      if (info.shell && info.shell.name) bits.push(info.shell.name);
      bits.push(label);
      if (info.cols) bits.push(info.cols + '×' + info.rows);
      st.sub.textContent = ' ' + bits.join(' · ');
    }
    if (st.bar) {
      st.bar.textContent = st.error ? st.error : (info.cwd || (st.env && st.env.cwd) || '正在读取工作目录…');
      st.bar.classList.toggle('bad', !!st.error);
    }
    if (st.spin) st.spin.hidden = !!(st.status === 'connected' && st.info);
    if (st.keys) st.keys.classList.toggle('off', !st.writable);
  }

  /** Build the overlay page once; render() never touches it. */
  function termPage(st) {
    var page = el('div', 'termpage');
    var hdr = el('div', 'hdr');
    var back = el('button', 'iconbtn');
    back.setAttribute('aria-label', '返回');
    back.appendChild(icon('back', 19));
    back.addEventListener('click', closeTermPage);
    var h1 = el('h1', null, '终端');
    st.sub = el('span', 'sub', ' 连接中…');
    h1.appendChild(st.sub);
    var add = el('button', 'iconbtn');
    add.setAttribute('aria-label', '新建终端');
    add.appendChild(icon('plus', 19));
    add.addEventListener('click', function () { termNew(st); });
    var more = el('button', 'iconbtn');
    more.setAttribute('aria-label', '终端菜单');
    more.appendChild(icon('more', 19));
    more.addEventListener('click', function () { termMenu(st); });
    hdr.appendChild(back); hdr.appendChild(h1); hdr.appendChild(add); hdr.appendChild(more);

    st.bar = el('div', 'termbar');
    st.bar.addEventListener('click', function () { termCopy(st.bar.textContent); });

    var wrap = el('div', 'termwrap');
    st.host = el('div', 'termhost');
    st.spin = el('div', 'termspin');
    st.spin.innerHTML = '<span class="spin-sm"></span> 正在连接终端…';
    wrap.appendChild(st.host);
    wrap.appendChild(st.spin);

    st.keys = el('div', 'termkeys');
    [['Esc', '\u001b'], ['Tab', '\t'], ['^C', '\u0003'], ['^D', '\u0004'], ['↑', '\u001b[A'], ['↓', '\u001b[B'], ['⏎', '\r']].forEach(function (k) {
      var b = el('button', 'kbtn', k[0]);
      if (k[0] === '^C') b.classList.add('danger');
      b.addEventListener('click', function () { termWrite(st, k[1]); });
      st.keys.appendChild(b);
    });
    var inp = document.createElement('input');
    inp.className = 'terminput';
    inp.type = 'text';
    inp.setAttribute('autocapitalize', 'off');
    inp.setAttribute('autocomplete', 'off');
    inp.setAttribute('autocorrect', 'off');
    inp.spellcheck = false;
    inp.placeholder = '输入命令后回车执行';
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); termLine(st, inp.value); inp.value = ''; }
    });
    st.input = inp;
    var send = el('button', 'kbtn primary', '发送');
    send.addEventListener('click', function () { termLine(st, inp.value); inp.value = ''; });
    st.keys.appendChild(inp);
    st.keys.appendChild(send);

    page.appendChild(hdr);
    page.appendChild(st.bar);
    page.appendChild(wrap);
    page.appendChild(st.keys);
    st.page = page;
    st.wrap = wrap;
    return page;
  }

  function openTerminal() {
    if (!S.cur) { toast('先打开一个会话'); return; }
    if (S.term && S.term.page && S.term.page.parentNode) return;
    var st = S.term = {
      sid: S.cur.id, id: null, info: null, env: null, shells: [], term: null, fit: null,
      followId: null, retainId: null, lastSeq: null, upSeq: 0,
      status: 'connecting', error: '', writable: false, disposed: false, q: Promise.resolve(),
      sentCols: 0, sentRows: 0
    };
    document.body.appendChild(termPage(st));
    termStatus(st);
    loadXterm().then(function () {
      if (st.disposed) return;
      st.term = new window.Terminal({
        cols: 80, rows: 24, fontSize: 12.5, lineHeight: 1.22,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace',
        cursorBlink: true, scrollback: 2000, convertEol: false,
        allowProposedApi: true, theme: termTheme(), scrollOnUserInput: true
      });
      st.fit = new window.FitAddon.FitAddon();
      st.term.loadAddon(st.fit);
      st.term.open(st.host);
      try { st.term.options.theme = termTheme(); } catch (e) {}
      st.term.onData(function (d) { termWrite(st, d); });
      termFit(st);
      return termBoot(st);
    }).catch(function (e) { termFail(st, e.message); });
    window.addEventListener('resize', termRefit);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', termRefit);
    // follow theme switches from any code path, not just the settings toggle
    if (!st.themeObs) {
      st.themeObs = new MutationObserver(function () {
        if (st.term && !st.disposed) { try { st.term.options.theme = termTheme(); } catch (e) {} }
      });
      st.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
  }

  function termRefit() {
    var st = S.term;
    if (st && !st.disposed && st.term) termFit(st);
  }

  function termFit(st) {
    if (!st || !st.fit || !st.term) return;
    var d;
    try { d = st.fit.proposeDimensions(); } catch (e) { return; }
    if (!d || !isFinite(d.cols) || !isFinite(d.rows)) return;
    var env = st.env || { maxCols: 500, maxRows: 200 };
    var cols = Math.max(2, Math.min(d.cols, env.maxCols || 500));
    var rows = Math.max(1, Math.min(d.rows, env.maxRows || 200));
    if (st.term.cols !== cols || st.term.rows !== rows) {
      try { st.term.resize(cols, rows); } catch (e) { return; }
    }
    if (cols === st.sentCols && rows === st.sentRows) return;
    if (!st.writable) return;
    st.sentCols = cols; st.sentRows = rows;
    if (!termSend(st, { type: 'resize', cols: cols, rows: rows })) { st.sentCols = 0; st.sentRows = 0; }
  }


  function termBoot(st) {
    var sid = st.sid;
    return Promise.all([
      rpc('terminal/environment', { agentId: sid }),
      rpc('terminal/list', { sessionId: sid })
    ]).then(function (res) {
      st.env = res[0] || { cwd: '', maxCols: 500, maxRows: 200 };
      st.env.cwd = (st.env.cwd || '').replace(/[\\/]+$/, '');
      var list = res[1] || [];
      var saved = lsGet(termKey(sid), '');
      var pick = null;
      for (var i = 0; i < list.length; i++) if (saved && list[i].id === saved) pick = list[i];
      if (!pick && list.length) pick = list[0];
      if (pick) { st.id = pick.id; return pick; }
      return rpc('terminal/shells', { agentId: sid }).then(function (shells) {
        st.shells = shells || [];
        var prev = lsGet('dshm.term.shell', '');
        var path = '';
        for (var j = 0; j < st.shells.length; j++) if (st.shells[j].path === prev) path = prev;
        if (!path && st.shells.length) path = st.shells[0].path;
        st.id = uuid();
        var req = { id: st.id, cols: Math.min(80, st.env.maxCols || 80), rows: Math.min(24, st.env.maxRows || 24) };
        if (path) { req.shellPath = path; lsSet('dshm.term.shell', path); }
        return rpc('terminal/create', { agentId: sid, request: req });
      });
    }).then(function (info) {
      if (st.disposed || !info) return;
      st.info = info;
      lsSet(termKey(sid), st.id);
      termStatus(st);
      termConnect(st);
    }).catch(function (e) { termFail(st, termErrText(e)); });
  }

  function termDetach(st) {
    var m = S.mux;
    if (st.followId && m) m.closeStream(st.followId);
    if (st.retainId && m) m.closeStream(st.retainId);
    st.followId = null; st.retainId = null; st.lastSeq = null; st.upSeq = 0;
  }

  /** (Re)attach: fresh snapshot + input control; the process itself is untouched. */
  function termConnect(st, forceNew) {
    if (!st || st.disposed || !st.id) return;
    termDetach(st);
    st.error = '';
    st.status = 'connecting';
    st.writable = false;
    st.sentCols = 0; st.sentRows = 0;
    st.upSeq = 0;
    st.acks = [];
    termStatus(st);
    var m = mux();
    st.retainId = m.open('terminal/retain', { sessionId: st.sid, id: st.id }, {
      onFrame: function () {}, onEnd: function () {}, onError: function () {}
    });
    st.followId = m.open('terminal/attach', { agentId: st.sid, id: st.id }, {
      onFrame: function (f) { termFrame(st, f); },
      onEnd: function () {
        if (st.disposed) return;
        st.status = 'ended';
        st.writable = false;
        termStatus(st);
      },
      onError: function (e) {
        if (st.disposed) return;
        termFail(st, termErrText(e));
      }
    });
    if (forceNew && st.term) { try { st.term.reset(); } catch (e) {} }
  }

  /** One uplink command; sequences are consecutive from 1 within each attachment. */
  function termSend(st, input) {
    if (!st || st.disposed || !st.followId) return false;
    st.upSeq = (st.upSeq || 0) + 1;
    input.sequence = st.upSeq;
    var sent = mux().push(st.followId, input);
    if (!sent) st.upSeq -= 1;
    return sent;
  }


  function termFrame(st, f) {
    if (st.disposed || !st.term || !f) return;
    if (f.type === 'snapshot') {
      st.lastSeq = f.sequence;
      st.info = f.info;
      st.writable = !!f.writable;
      st.status = f.info.state === 'running' ? 'connected' : f.info.state;
      st.error = '';
      try { st.term.reset(); } catch (e) {}
      if (f.screen) st.term.write(f.screen);
      termStatus(st);
      termFit(st);
      return;
    }
    if (f.type === 'output') {
      if (st.lastSeq != null && f.sequence !== st.lastSeq + 1) { termConnect(st); return; }
      st.lastSeq = f.sequence;
      st.term.write(f.data);
      return;
    }
    if (f.type === 'state') {
      st.info = f.info;
      st.writable = !!f.writable;
      st.status = f.info.state === 'running' ? 'connected' : f.info.state;
      termStatus(st);
      return;
    }
    if (f.type === 'ack') {
      if (f.refusal) {
        st.writable = false;
        termFail(st, f.refusal === 'read-only' ? '输入被拒绝：另一个窗口持有控制权' : '进程已结束');
      }
    }
  }


  function termWrite(st, data) {
    if (!st || st.disposed || !st.id) return;
    if (!st.writable) {
      if (st.status === 'connecting') return;
      toast('终端当前只读，菜单里“重新连接”可取回输入权');
      return;
    }
    st.q = st.q.then(function () {
      if (!termSend(st, { type: 'write', data: data })) termFail(st, '输入通道已断开');
    });
  }


  function termLine(st, text) {
    if (!text) { termWrite(st, '\r'); return; }
    termWrite(st, text + '\r');
  }

  function termText(st) {
    if (!st || !st.term) return '';
    var buf = st.term.buffer.active, out = [];
    for (var i = 0; i < buf.length; i++) {
      var ln = buf.getLine(i);
      out.push(ln ? ln.translateToString(true) : '');
    }
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join('\n');
  }

  function termCopy(t) {
    try { navigator.clipboard.writeText(t); toast('已复制'); } catch (e) { toast('复制失败'); }
  }

  function closeTermPage() {
    var st = S.term;
    if (!st) return;
    st.disposed = true;
    if (st.themeObs) { try { st.themeObs.disconnect(); } catch (e) {} }
    termDetach(st);
    window.removeEventListener('resize', termRefit);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', termRefit);
    try { if (st.term) st.term.dispose(); } catch (e) {}
    if (st.page) st.page.remove();
    S.term = null;
  }

  function termNew(st) {
    if (!st || !st.env) { toast('终端还没准备好'); return; }
    rpc('terminal/shells', { agentId: st.sid }).then(function (shells) {
      sheet('新建终端', function (body, close) {
        (shells || []).forEach(function (sh) {
          body.appendChild(sheetRow(sh.name, sh.path, function () { close(); termSpawn(st, sh.path); }));
        });
        if (!(shells || []).length) body.appendChild(el('div', 'empty', '没有可用的 shell'));
      });
    }).catch(function (e) { toast(termErrText(e)); });
  }

  function termSpawn(st, shellPath) {
    var cols = Math.min(st.term ? st.term.cols : 80, (st.env && st.env.maxCols) || 500);
    var rows = Math.min(st.term ? st.term.rows : 24, (st.env && st.env.maxRows) || 200);
    var req = { id: uuid(), cols: Math.max(2, cols), rows: Math.max(1, rows) };
    if (shellPath) req.shellPath = shellPath;
    rpc('terminal/create', { agentId: st.sid, request: req }).then(function (info) {
      lsSet(termKey(st.sid), info.id);
      st.id = info.id;
      st.info = info;
      termConnect(st, true);
    }).catch(function (e) { toast(termErrText(e)); });
  }

  function termMenu(st) {
    if (!st) return;
    rpc('terminal/list', { sessionId: st.sid }).catch(function () { return []; }).then(function (list) {
      list = list || [];
      sheet('终端', function (body, close) {
        body.appendChild(sheetRow('复制全部输出', '当前屏幕与回滚缓冲区写入剪贴板', function () {
          close();
          termCopy(termText(st));
        }));
        body.appendChild(sheetRow('重新连接', '重新获取屏幕快照与输入控制权', function () {
          close();
          termConnect(st);
        }));
        body.appendChild(sheetRow('新建终端', '在会话工作目录里开一个新 shell', function () {
          close();
          termNew(st);
        }));
        body.appendChild(sheetRow('重命名', (st.info && st.info.title) || '当前终端', function () {
          close();
          var t = prompt('终端名称', (st.info && st.info.title) || '');
          if (!t) return;
          rpc('terminal/rename', { agentId: st.sid, id: st.id, title: t }).catch(function (e) { toast(termErrText(e)); });
        }));
        if (list.length > 1) {
          body.appendChild(el('div', 'sheet-sep', '运行中的终端'));
          list.forEach(function (it) {
            body.appendChild(sheetRow(it.title + (it.id === st.id ? '（当前）' : ''), it.state + ' · ' + it.cols + '×' + it.rows, function () {
              close();
              if (it.id === st.id) return;
              lsSet(termKey(st.sid), it.id);
              st.id = it.id;
              st.info = it;
              termConnect(st, true);
            }));
          });
        }
        body.appendChild(el('div', 'sheet-sep', '危险操作'));
        body.appendChild(sheetRow('关闭这个终端', '结束进程，正在运行的任务会被终止', function () {
          close();
          rpc('terminal/close', { agentId: st.sid, id: st.id }).then(function () {
            lsSet(termKey(st.sid), '');
            closeTermPage();
            toast('终端已关闭');
          }).catch(function (e) { toast(termErrText(e)); });
        }));
      });
    });
  }

  // ---------- schedules (定时任务) — dsh 0.2.2 API
  //
  // Verified 2026-11-10 on 0.2.2-rc.1:
  //   schedule/list({active?,limit?,offset?}) -> {items,shown,total,limit,offset}   (Host-wide)
  //   schedule/create({title,prompt,timing,target?}) -> ScheduleCatalogEntry
  //   schedule/edit({id, action:'update', patch:{title?,prompt?,timing?,target?,active?}, expectedUpdatedAt?})
  //   schedule/edit({id, action:'delete'})
  //   schedule/run({id}) | schedule/view({id}) | schedule/deleteInactive()
  // 0.2.2 replaced the old daily/weekly/cron records with RFC-5545 `kind:'rrule'` rows and
  // added status active|paused|ended; legacy `after` rows still show up.
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtClock(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return iso ? String(iso) : '';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function relText(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '';
    var diff = d.getTime() - Date.now();
    var a = Math.abs(diff), s;
    if (a < 60000) s = Math.round(a / 1000) + ' 秒';
    else if (a < 3600000) s = Math.round(a / 60000) + ' 分钟';
    else if (a < 86400000) s = Math.round(a / 3600000) + ' 小时';
    else s = Math.round(a / 86400000) + ' 天';
    return diff >= 0 ? s + '后' : s + '前';
  }

  function fmtDur(sec) {
    sec = Number(sec) || 0;
    if (sec % 86400 === 0) return (sec / 86400) + ' 天';
    if (sec % 3600 === 0) return (sec / 3600) + ' 小时';
    if (sec % 60 === 0) return (sec / 60) + ' 分钟';
    return sec + ' 秒';
  }

  var WEEK_CN = ['一', '二', '三', '四', '五', '六', '日'];
  var RRULE_FREQ = { SECONDLY: '每秒', MINUTELY: '每分钟', HOURLY: '每小时', DAILY: '每天', WEEKLY: '每周', MONTHLY: '每月', YEARLY: '每年' };

  /** Human reading of one RFC-5545 rule line plus its DTSTART anchor. */
  function prettyRRule(rrule) {
    if (!rrule) return '';
    var text = String(rrule);
    var dt = /DTSTART(?:;[^:]*)?:(\d{8})T(\d{6})/.exec(text);
    var clock = dt ? dt[2].slice(0, 2) + ':' + dt[2].slice(2, 4) : '';
    var rule = /RRULE:([^\n]+)/.exec(text);
    if (!rule) return clock ? '从 ' + clock + ' 开始' : text.slice(0, 40);
    var parts = {};
    rule[1].split(';').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) parts[kv.slice(0, i)] = kv.slice(i + 1);
    });
    var freq = RRULE_FREQ[parts.FREQ] || (parts.FREQ || '');
    var every = Number(parts.INTERVAL || 1);
    var out = every > 1 ? '每 ' + every + ' ' + (RRULE_FREQ[parts.FREQ] || '').replace(/^每/, '') : freq;
    if (parts.BYDAY) {
      var days = parts.BYDAY.split(',').map(function (d) {
        var m = /^(-?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(d);
        if (!m) return d;
        var w = WEEK_CN[['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].indexOf(m[2])];
        return w ? (m[1] ? '第' + m[1] + '个周' + w : '周' + w) : d;
      }).join('、');
      if (/^(每天|每周)$/.test(out)) out = '每' + days;
      else out += ' ' + days;
    }
    if (clock && !/每(秒|分钟)/.test(out)) out += ' ' + clock;
    if (parts.COUNT) out += '（共 ' + parts.COUNT + ' 次）';
    else if (parts.UNTIL) out += '（到 ' + String(parts.UNTIL).slice(0, 8) + '）';
    return out;
  }

  function schedRule(it) {
    if (!it) return '';
    switch (it.kind) {
      case 'rrule': return prettyRRule(it.rrule);
      case 'after': return '延时 ' + fmtDur(it.afterSeconds || it.after_seconds || 0);
      case 'at': return '一次性';
      case 'every': return '每 ' + fmtDur(it.everySeconds || it.every_seconds || 0);
      case 'daily': return '每天 ' + String(it.time || (it.daily && it.daily.time) || '').slice(0, 5);
      case 'weekly': return '每周';
      case 'cron': return 'cron ' + (it.expression || (it.cron && it.cron.expression) || '');
      default: return it.kind || '';
    }
  }

  var SCHED_STATUS = { active: '运行中', paused: '已暂停', ended: '已结束' };

  function schedStatus(it) { return SCHED_STATUS[it && it.status] || (it && it.status) || ''; }

  function renderSchedule() {
    var st = S.sched || (S.sched = { filter: null, items: null, error: '', loading: false, total: 0 });
    var frag = document.createDocumentFragment();
    frag.appendChild(panelHeader('定时任务', [
      { icon: 'plus', label: '新建任务', on: function () { schedCreateSheet(); } },
      { icon: 'refresh', label: '刷新', on: function () { st.items = null; renderSchedule(); } },
      { icon: 'more', label: '更多', on: function () { schedMenu(st); } }
    ]));
    frag.appendChild(el('div', 'statline', st.total ? st.total + ' 个任务' + (st.filter === true ? '（仅运行中）' : st.filter === false ? '（仅已停止）' : '（全部）') : '本机所有会话的定时任务'));
    var sc = el('div', 'scroll');
    var box = el('div', 'pane');
    sc.appendChild(box);
    frag.appendChild(sc);
    mount(frag);

    if (st.items === null && !st.loading) {
      st.loading = true;
      box.appendChild(el('div', 'empty', '<span class="spin-sm"></span> 读取中…'));
      var req = {};
      if (st.filter === true || st.filter === false) req.active = st.filter;
      rpc('schedule/list', { request: req }).then(function (v) {
        st.items = (v && v.items) || [];
        st.total = (v && v.total) || 0;
        st.error = '';
      }).catch(function (e) {
        st.items = [];
        st.error = '读取失败：' + e.message;
      }).then(function () {
        st.loading = false;
        if (S.view === 'sched') renderSchedule();
      });
      return;
    }

    box.innerHTML = '';
    if (st.error) box.appendChild(el('div', 'hint', st.error));
    if (!st.items || !st.items.length) {
      box.appendChild(el('div', 'empty', '没有定时任务。点右上角 + 新建，或直接跟模型说“20 分钟后提醒我…”'));
      return;
    }
    st.items.forEach(function (it) {
      var row = el('div', 'row');
      row.appendChild(el('div', 'dot ' + (it.status === 'active' ? 'run' : 'idle')));
      var g = el('div', 'grow');
      g.appendChild(el('div', 't', it.title || '（无标题任务）'));
      var m1 = el('div', 'm');
      m1.appendChild(el('span', null, schedRule(it) + ' · ' + schedStatus(it)));
      g.appendChild(m1);
      var m2 = el('div', 'm');
      var when = it.status === 'ended' ? '已结束' : fmtClock(it.scheduledAt) + '（' + relText(it.scheduledAt) + '）';
      m2.appendChild(el('span', null, when));
      var tgt = it.target && (it.target.sessionId || it.target.kind);
      if (tgt) m2.appendChild(el('span', 'path', String(tgt).slice(0, 14)));
      g.appendChild(m2);
      row.appendChild(g);
      row.addEventListener('click', function () { schedDetail(it, st); });
      box.appendChild(row);
    });
  }

  function schedMenu(st) {
    sheet('定时任务', function (body, close) {
      body.appendChild(sheetRow('新建任务', '到点让某个会话自动发起一轮', function () { close(); schedCreateSheet(); }));
      body.appendChild(el('div', 'sheet-sep', '筛选'));
      body.appendChild(sheetRow('全部', '', function () { close(); st.filter = null; st.items = null; renderSchedule(); }, { active: st.filter === null }));
      body.appendChild(sheetRow('仅运行中', '', function () { close(); st.filter = true; st.items = null; renderSchedule(); }, { active: st.filter === true }));
      body.appendChild(sheetRow('仅已停止 / 已结束', '', function () { close(); st.filter = false; st.items = null; renderSchedule(); }, { active: st.filter === false }));
      body.appendChild(el('div', 'sheet-sep', '清理'));
      body.appendChild(sheetRow('删除所有已结束任务', 'schedule/deleteInactive，不可恢复', function () {
        close();
        rpc('schedule/deleteInactive', {}).then(function (v) {
          toast('已删除 ' + ((v && v.deleted) || 0) + ' 个已结束任务');
          st.items = null;
          if (S.view === 'sched') renderSchedule();
        }).catch(function (e) { toast('失败：' + e.message); });
      }));
    });
  }

  function schedDetail(it, st) {
    sheet(it.title || '定时任务', function (body, close) {
      body.appendChild(el('div', 'sheet-note', it.prompt || '（没有提醒内容）'));
      body.appendChild(sheetRow('规则', schedRule(it), function () {}));
      body.appendChild(sheetRow('状态', schedStatus(it) + (it.scheduledAt && it.status !== 'ended' ? ' · 下次 ' + fmtClock(it.scheduledAt) + '（' + relText(it.scheduledAt) + '）' : ''), function () {}));
      if (it.lastDelivery) body.appendChild(sheetRow('最近投递', fmtClock(it.lastDelivery.deliveredAt || '') + (it.lastDelivery.targetSessionId ? ' · ' + String(it.lastDelivery.targetSessionId).slice(8, 18) : ''), function () {}));
      var tgt = it.target && it.target.sessionId;
      if (tgt) body.appendChild(sheetRow('投递到会话', String(tgt), function () { close(); openSession(tgt, ''); }));
      body.appendChild(sheetRow('立即执行一次', 'schedule/run，不等下次触发', function () {
        close();
        rpc('schedule/run', { request: { id: it.id } }).then(function (v) {
          if (v && v.code === 'schedule_execution_pending') toast('这一轮已经在跑了');
          else toast('已触发');
          st.items = null;
          if (S.view === 'sched') renderSchedule();
        }).catch(function (e) { toast('触发失败：' + e.message); });
      }));
      if (it.status === 'active') {
        body.appendChild(sheetRow('暂停', '暂停后不再触发，可再恢复', function () {
          close(); schedPatch(it, st, { active: false }, '已暂停');
        }));
      } else if (it.status === 'paused') {
        body.appendChild(sheetRow('恢复', '从下一个未来时刻继续', function () {
          close(); schedPatch(it, st, { active: true }, '已恢复');
        }));
      }
      body.appendChild(sheetRow('复制任务 ID', String(it.id), function () { close(); copy(String(it.id)); }));
      body.appendChild(el('div', 'sheet-sep', '危险操作'));
      body.appendChild(sheetRow('删除这个任务', '连同它的投递记录一起删除', function () {
        close();
        rpc('schedule/edit', { request: { id: it.id, action: 'delete' } }).then(function () {
          toast('已删除');
          st.items = null;
          if (S.view === 'sched') renderSchedule();
        }).catch(function (e) { toast('删除失败：' + e.message); });
      }));
    });
  }

  function schedPatch(it, st, patch, okMsg) {
    rpc('schedule/edit', { request: { id: it.id, action: 'update', patch: patch, expectedUpdatedAt: it.updatedAt || null } })
      .then(function (v) {
        if (v && v.code === 'schedule_conflict') { toast('任务刚被改过，已刷新'); }
        else toast(okMsg);
        st.items = null;
        if (S.view === 'sched') renderSchedule();
      }).catch(function (e) { toast('失败：' + e.message); });
  }

  /** Small create form: title + instruction + one timing selector, delivered to this session. */
  function schedCreateSheet() {
    var zone = tz();
    var mode = { v: 'after' };
    sheet('新建定时任务', function (body, close) {
      var titleIn = document.createElement('input');
      titleIn.className = 'terminput'; titleIn.style.width = '100%';
      titleIn.placeholder = '任务名（必填，≤120 字）';
      var promptIn = document.createElement('textarea');
      promptIn.className = 'terminput'; promptIn.style.width = '100%';
      promptIn.style.marginTop = '8px'; promptIn.style.minHeight = '70px';
      promptIn.placeholder = '到点要发给模型的指令';
      var timeIn = document.createElement('input');
      timeIn.className = 'terminput'; timeIn.style.width = '100%';
      timeIn.style.marginTop = '8px';
      timeIn.placeholder = '延时分钟数，例如 30';

      var modes = el('div', 'termkeys');
      modes.style.padding = '8px 0 0';
      [['after', '延时'], ['daily', '每天'], ['cron', 'cron']].forEach(function (m) {
        var b = el('button', 'kbtn', m[1]);
        b.addEventListener('click', function () {
          mode.v = m[0];
          Array.prototype.forEach.call(modes.children, function (c) { c.classList.remove('primary'); });
          b.classList.add('primary');
          timeIn.placeholder = m[0] === 'after' ? '延时分钟数，例如 30'
            : m[0] === 'daily' ? '每天的时刻 HH:MM，例如 08:30'
              : 'cron 表达式，例如 0 9 * * 1-5';
        });
        if (m[0] === 'after') b.classList.add('primary');
        modes.appendChild(b);
      });

      body.appendChild(titleIn);
      body.appendChild(promptIn);
      body.appendChild(modes);
      body.appendChild(timeIn);
      body.appendChild(el('div', 'sheet-note', '时区 ' + zone + ' · 投递到当前会话'));

      var btn = el('button', 'kbtn primary', '创建');
      btn.style.marginTop = '10px'; btn.style.width = '100%';
      btn.addEventListener('click', function () {
        var title = titleIn.value.trim();
        var prompt = promptIn.value.trim();
        var t = timeIn.value.trim();
        if (!title) { toast('任务名必填'); return; }
        if (!prompt) { toast('指令必填'); return; }
        var timing;
        if (mode.v === 'after') {
          var mins = Number(t);
          if (!isFinite(mins) || mins <= 0) { toast('填个正数分钟'); return; }
          timing = { kind: 'after', after_seconds: Math.round(mins * 60) };
        } else if (mode.v === 'daily') {
          if (!/^\d{1,2}:\d{2}$/.test(t)) { toast('时刻要写成 HH:MM'); return; }
          timing = { kind: 'daily', daily: { time: t + ':00', time_zone: zone } };
        } else {
          if (t.split(/\s+/).length < 5) { toast('cron 要 5 段'); return; }
          timing = { kind: 'cron', cron: { expression: t, time_zone: zone } };
        }
        var target = S.cur ? { kind: 'session', sessionId: S.cur.id } : undefined;
        var req = { title: title, prompt: prompt, timing: timing };
        if (target) req.target = target;
        close();
        rpc('schedule/create', { request: req }).then(function () {
          toast('已创建');
          if (S.sched) S.sched.items = null;
          if (S.view === 'sched') renderSchedule();
        }).catch(function (e) { toast('创建失败：' + e.message); });
      });
      body.appendChild(btn);
      setTimeout(function () { try { titleIn.focus(); } catch (e) {} }, 60);
    });
  }

  // ---------- workspaces (工作区 / 置顶 / 归档)
  //
  // The registry only streams: workspace/follow ->
  //   {type:'baseline', value:{items, archivedSessionIds, pinnedSessionIds}}
  //   {type:'upsert'|'remove'|'order'|'archived'|'pinned', ...}
  function wsEnsure() {
    var w = S.ws || (S.ws = { items: [], archived: [], pinned: [], ready: false, error: '', streamId: null });
    if (w.streamId) return w;
    w.streamId = mux().open('workspace/follow', {}, {
      onFrame: function (f) { wsApply(f); },
      onEnd: function () { if (S.ws) S.ws.streamId = null; },
      onError: function (e) { if (S.ws) { S.ws.streamId = null; S.ws.error = (e && e.message) || '工作区订阅失败'; } }
    });
    return w;
  }

  function wsApply(f) {
    var w = S.ws;
    if (!w || !f) return;
    w.ready = true;
    if (f.type === 'baseline') {
      var v = (f.value && f.value.items) ? f.value : (f.items ? f : null);
      if (!v) return;
      w.items = v.items || [];
      w.archived = v.archivedSessionIds || [];
      w.pinned = v.pinnedSessionIds || [];
    } else if (f.type === 'upsert') {
      var i = -1;
      for (var k = 0; k < w.items.length; k++) if (w.items[k].workspaceId === f.workspace.workspaceId) i = k;
      if (i >= 0) w.items[i] = f.workspace; else w.items.push(f.workspace);
    } else if (f.type === 'remove') {
      w.items = w.items.filter(function (x) { return x.workspaceId !== f.workspaceId; });
    } else if (f.type === 'order') {
      var byId = {};
      w.items.forEach(function (x) { byId[x.workspaceId] = x; });
      w.items = (f.workspaceIds || []).map(function (id) { return byId[id]; }).filter(Boolean);
    } else if (f.type === 'archived') {
      w.archived = f.archivedSessionIds || [];
    } else if (f.type === 'pinned') {
      w.pinned = f.pinnedSessionIds || [];
    } else return;
    if (S.view === 'workspace') renderWorkspace();
    else if (S.view === 'sessions') renderSessions();
  }

  function isPinned(sid) { return !!(S.ws && S.ws.pinned.indexOf(sid) >= 0); }
  function isArchived(sid) { return !!(S.ws && S.ws.archived.indexOf(sid) >= 0); }

  function wsPin(sid, on) {
    var m = on ? 'workspace/pinSession' : 'workspace/unpinSession';
    return rpc(m, { request: { sessionId: sid } }).then(function (v) {
      if (S.ws && v && v.pinnedSessionIds) S.ws.pinned = v.pinnedSessionIds;
      toast(on ? '已置顶' : '已取消置顶');
      render();
      return v;
    }).catch(function (e) { toast('操作失败：' + e.message); });
  }

  function wsArchive(sid, on) {
    var m = on ? 'workspace/archiveSession' : 'workspace/unarchiveSession';
    return rpc(m, { request: { sessionId: sid, stopActivity: on ? true : undefined } }).then(function (v) {
      if (S.ws && v && v.archivedSessionIds) S.ws.archived = v.archivedSessionIds;
      toast(on ? '已归档' : '已恢复');
      render();
      return v;
    }).catch(function (e) {
      if (e.code === 'workspace/session-active') toast('会话还在运行，先停止再归档');
      else toast('操作失败：' + e.message);
    });
  }

  function sessionActions(s) {
    var sid = s.sessionId;
    var title = (s.projections && s.projections.values && s.projections.values.title) || (s.blank ? '（新会话）' : '（无标题）');
    sheet(title, function (body, close) {
      body.appendChild(sheetRow('打开', fmtTime(s.updatedAt) + (s.cwd ? ' · ' + baseName(s.cwd) : ''), function () {
        close(); openSession(sid, title);
      }));
      var pinned = isPinned(sid);
      body.appendChild(sheetRow(pinned ? '取消置顶' : '置顶', pinned ? '置顶会让它排在列表最前' : '排到会话列表最前', function () {
        close(); wsPin(sid, !pinned);
      }));
      body.appendChild(sheetRow('归档', '从主列表收起，可在“工作区 → 归档箱”恢复', function () {
        close(); wsArchive(sid, true);
      }));
      body.appendChild(sheetRow('复制会话 ID', String(sid), function () { close(); copy(String(sid)); }));
      body.appendChild(sheetRow('查看工作区', '工作区改名 / 新建 / 删除登记', function () {
        close(); openPanel('workspace');
      }));
    });
  }

  function renderWorkspace() {
    var w = wsEnsure();
    var frag = document.createDocumentFragment();
    frag.appendChild(panelHeader('工作区', [
      { icon: 'refresh', label: '刷新', on: function () { if (w.streamId && S.mux) S.mux.closeStream(w.streamId); w.streamId = null; w.ready = false; wsEnsure(); renderWorkspace(); } },
      { icon: 'plus', label: '登记工作区', on: function () { wsNew(); } }
    ]));
    frag.appendChild(el('div', 'statline', (w.items.length || 0) + ' 个工作区 · ' + (w.pinned.length || 0) + ' 个置顶 · ' + (w.archived.length || 0) + ' 个已归档'));
    var sc = el('div', 'scroll');
    var box = el('div', 'pane');
    sc.appendChild(box);
    frag.appendChild(sc);
    mount(frag);

    if (!w.ready) { box.appendChild(el('div', 'empty', '<span class="spin-sm"></span> 读取工作区…')); return; }
    if (w.error) box.appendChild(el('div', 'hint', w.error));
    if (!w.items.length) box.appendChild(el('div', 'empty', '还没有登记工作区'));
    w.items.forEach(function (it) {
      var row = el('div', 'row');
      row.appendChild(el('div', 'dot idle'));
      var g = el('div', 'grow');
      g.appendChild(el('div', 't', it.title || baseName(it.path)));
      var m = el('div', 'm');
      m.appendChild(el('span', null, (it.sessionIds || []).length + ' 个会话'));
      var p = el('span', 'path', it.path || '');
      m.appendChild(p);
      g.appendChild(m);
      row.appendChild(g);
      row.addEventListener('click', function () { wsDetail(it); });
      attachLongPress(row, function () { wsDetail(it); });
      box.appendChild(row);
    });
    var arch = el('div', 'row');
    arch.appendChild(el('div', 'dot idle'));
    var ag = el('div', 'grow');
    ag.appendChild(el('div', 't', '归档箱'));
    var am = el('div', 'm');
    am.appendChild(el('span', null, (w.archived.length || 0) + ' 个已归档会话'));
    ag.appendChild(am);
    arch.appendChild(ag);
    arch.addEventListener('click', archiveBox);
    box.appendChild(arch);
  }

  function wsNew() {
    var seen = {}, dirs = [];
    S.sessions.forEach(function (s) { if (s.cwd && !seen[s.cwd]) { seen[s.cwd] = 1; dirs.push(s.cwd); } });
    sheet('登记工作区', function (body, close) {
      body.appendChild(el('div', 'sheet-note', '选一个服务器上已存在的目录，登记为工作区（不会改动文件）'));
      dirs.slice(0, 10).forEach(function (d) {
        body.appendChild(sheetRow(baseName(d) || d, d, function () { close(); wsCreate(d); }));
      });
      body.appendChild(sheetRow('其他目录…', '手动输入完整路径', function () {
        var p = prompt('目录（服务器路径，必须已存在）', S.cwd || dirs[0] || '');
        if (!p) return;
        close(); wsCreate(p);
      }));
    });
  }

  function wsCreate(path) {
    rpc('workspace/create', { request: { path: path } }).then(function (v) {
      toast(v && v.created ? '已登记' : '这个目录已经在工作区里了');
      renderWorkspace();
    }).catch(function (e) {
      if (e.code === 'workspace/invalid-path') toast('目录不存在或不能作为工作区');
      else toast('登记失败：' + e.message);
    });
  }

  function wsDetail(it) {
    var n = (it.sessionIds || []).length;
    sheet(it.title || baseName(it.path), function (body, close) {
      body.appendChild(el('div', 'sheet-note', it.path || ''));
      body.appendChild(sheetRow('查看会话（' + n + '）', '这个工作区名下的会话', function () { close(); wsSessions(it); }));
      body.appendChild(sheetRow('在此目录新建会话', it.path || '', function () {
        close(); createSessionIn(it.path);
      }));
      body.appendChild(sheetRow('改名', it.title || '', function () {
        close();
        var t = prompt('工作区名称', it.title || '');
        if (!t || t === it.title) return;
        rpc('workspace/rename', { request: { workspaceId: it.workspaceId, title: t } }).then(function () {
          toast('已改名');
          renderWorkspace();
        }).catch(function (e) {
          if (e.code === 'workspace/name-conflict') toast('这个名字已被别的工区用了');
          else toast('改名失败：' + e.message);
        });
      }));
      body.appendChild(sheetRow('复制目录路径', it.path || '', function () { close(); copy(it.path || ''); }));
      body.appendChild(el('div', 'sheet-sep', '危险操作'));
      body.appendChild(sheetRow('删除工作区登记', '只删登记，不删目录、不删会话', function () {
        close();
        if (!confirm('删除工作区登记「' + (it.title || '') + '」？（不会删除目录与会话）')) return;
        rpc('workspace/delete', { request: { workspaceId: it.workspaceId } }).then(function () {
          toast('已删除登记');
          renderWorkspace();
        }).catch(function (e) { toast('删除失败：' + e.message); });
      }));
    });
  }

  function wsSessions(it) {
    var ids = it.sessionIds || [];
    var byId = {};
    S.sessions.forEach(function (s) { byId[s.sessionId] = s; });
    sheet(it.title || '工作区会话', function (body, close) {
      if (!ids.length) { body.appendChild(el('div', 'empty', '这个工作区还没有会话')); return; }
      ids.forEach(function (sid) {
        var s = byId[sid];
        var title = s ? ((s.projections && s.projections.values && s.projections.values.title) || (s.blank ? '（新会话）' : '（无标题）')) : String(sid).slice(8, 18);
        body.appendChild(sheetRow((isPinned(sid) ? '★ ' : '') + title, s ? fmtTime(s.updatedAt) : '已归档或不在列表里', function () {
          close(); openSession(sid, title);
        }));
      });
    });
  }

  function archiveBox() {
    var w = wsEnsure();
    var byId = {};
    S.sessions.forEach(function (s) { byId[s.sessionId] = s; });
    sheet('归档箱', function (body, close) {
      var ids = (w.archived || []).slice().reverse();
      if (!ids.length) { body.appendChild(el('div', 'empty', '没有已归档的会话')); return; }
      body.appendChild(el('div', 'sheet-note', '归档只影响列表显示；恢复后回到主列表'));
      ids.forEach(function (sid) {
        var s = byId[sid];
        var title = s ? ((s.projections && s.projections.values && s.projections.values.title) || (s.blank ? '（新会话）' : '（无标题）')) : String(sid).slice(8, 18);
        var row = sheetRow(title, s ? fmtTime(s.updatedAt) + (s.cwd ? ' · ' + baseName(s.cwd) : '') : '（不在 session/list 里）', function () {
          wsArchive(sid, false).then(function () { close(); });
        });
        body.appendChild(row);
      });
    });
  }

  // ---------- settings (extra: providers / plugins, read-only)
  // ---------- settings (writable) — the "更多设置" entry from the settings screen
  //
  // Verified 2026-11-07 (dsh 0.2.0-rc.2):
  //   settings/describe()                       -> {writable, hasDocument, namespaces:[...]}
  //     namespace = {ns, schema, value, base?, user?, applies, secrets:[{path,set}], revision}
  //   settings/mutate(ns, ops, expectedRevision) ops = [{op:'set',path,value}|{op:'unset',path}]
  //     expectedRevision may be omitted; a stale one is refused (revision unchanged)
  //   credentials/describe(refs) -> {ref:{configured, source, writable}}
  //   credentials/set(ref, value) | credentials/unset(ref)
  // Credential refs are the `apiKeyEnv` names declared inside the namespace values.
  function collectCredRefs(nss) {
    var seen = {}, rows = [];
    function walk(o, label, ns, depth) {
      if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 3) return;
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        if (k === 'apiKeyEnv' && typeof v === 'string') {
          if (!seen[v]) { seen[v] = 1; rows.push({ ref: v, label: label || v, ns: ns }); }
          return;
        }
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          walk(v, (typeof v.displayName === 'string' && v.displayName) || label || '', ns, depth + 1);
        }
      });
    }
    (nss || []).forEach(function (n) { walk(n.value, '', n.ns, 0); });
    return rows;
  }

  /** Flat editable scalars of one namespace value; arrays and deep objects are skipped. */
  function settingsLeaves(o, path, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 2) return out;
    Object.keys(o).forEach(function (k) {
      var v = o[k], p = path ? path.concat([k]) : [k];
      if (v === null || v === undefined) return;
      var t = typeof v;
      if (t === 'string' || t === 'number' || t === 'boolean') out.push({ path: p, value: v });
      else if (t === 'object' && !Array.isArray(v)) settingsLeaves(v, p, out, depth + 1);
    });
    return out;
  }

  /** A masked single-field prompt; `prompt()` would echo the key on screen. */
  function secretPrompt(title, note, onSave) {
    sheet(title, function (body, close) {
      if (note) body.appendChild(el('div', 'sheet-note', note));
      var inp = document.createElement('input');
      inp.type = 'password';
      inp.className = 'terminput';
      inp.style.width = '100%';
      inp.setAttribute('autocomplete', 'off');
      inp.placeholder = '粘贴密钥后点保存';
      body.appendChild(inp);
      var btn = el('button', 'kbtn primary', '保存');
      btn.style.marginTop = '10px';
      btn.style.width = '100%';
      btn.addEventListener('click', function () {
        var v = inp.value.trim();
        if (!v) { toast('不能为空'); return; }
        close();
        onSave(v);
      });
      body.appendChild(btn);
      setTimeout(function () { try { inp.focus(); } catch (e) {} }, 60);
    });
  }

  function settingsReload() {
    S.settings = null;
    renderMore();
  }

  function renderMore() {
    var st = S.settings;
    var frag = document.createDocumentFragment();
    frag.appendChild(panelHeader('设置', [
      { icon: 'refresh', label: '重新读取', on: settingsReload }
    ]));
    var sc = el('div', 'scroll');
    var box = el('div', 'pane');
    sc.appendChild(box);
    frag.appendChild(sc);
    mount(frag);

    if (!st || st.loading) {
      if (!st) S.settings = { doc: null, plugins: null, creds: null, error: '', loading: true };
      S.settings.loading = true;
      box.appendChild(el('div', 'empty', '<span class="spin-sm"></span> 读取配置…'));
      Promise.all([
        rpc('settings/describe', {}),
        rpc('pluginManager/listPlugins', {}).catch(function (e) { return { error: e.message }; })
      ]).then(function (res) {
        var doc = res[0], plug = res[1];
        var refs = collectCredRefs(doc.namespaces);
        return rpc('credentials/describe', { refs: refs.map(function (r) { return r.ref; }) }).then(function (desc) {
          S.settings = {
            doc: doc,
            plugins: Array.isArray(plug) ? plug : ((plug && (plug.plugins || plug.items || plug.entries)) || []),
            creds: refs.map(function (r) {
              var d = desc && desc[r.ref];
              return { ref: r.ref, label: r.label, ns: r.ns, configured: !!(d && d.configured), source: (d && d.source) || '', writable: !(d && d.writable === false) };
            }),
            error: '',
            loading: false
          };
          if (S.view === 'more') renderMore();
        });
      }).catch(function (e) {
        S.settings = { doc: null, plugins: null, creds: null, error: '读取配置失败：' + e.message, loading: false };
        if (S.view === 'more') renderMore();
      });
      return;
    }

    box.innerHTML = '';
    var doc = st.doc;
    if (st.error) box.appendChild(el('div', 'hint', st.error));
    var h = '<h2>运行配置</h2>';
    h += '<div class="hint">' + (doc.writable ? '本机配置可写' : '配置只读（profile 不接受写入）')
      + ' · ' + doc.namespaces.length + ' 个配置项 · ' + (st.plugins || []).length + ' 个插件</div>';
    box.innerHTML = h;

    var credBox = el('div', 'pane');
    credBox.innerHTML = '<h2>凭据（API Key）</h2>';
    (st.creds || []).forEach(function (c) {
      var row = el('div', 'row');
      row.appendChild(el('div', 'dot ' + (c.configured ? 'run' : 'idle')));
      var g = el('div', 'grow');
      g.appendChild(el('div', 't', c.label || c.ref));
      var m = el('div', 'm');
      m.appendChild(el('span', null, c.ref + ' · ' + (c.configured ? '已设置' : '未设置') + (c.source ? ' · ' + c.source : '')));
      g.appendChild(m);
      row.appendChild(g);
      row.addEventListener('click', function () { credSheet(c); });
      credBox.appendChild(row);
    });
    if (!(st.creds || []).length) credBox.appendChild(el('div', 'hint', '这台机器的配置里没有声明 apiKeyEnv 的凭据'));
    box.appendChild(credBox);

    var nsBox = el('div', 'pane');
    nsBox.innerHTML = '<h2>配置项</h2>';
    doc.namespaces.forEach(function (n) {
      var row = el('div', 'row');
      row.appendChild(el('div', 'dot idle'));
      var g = el('div', 'grow');
      g.appendChild(el('div', 't', n.ns));
      var m = el('div', 'm');
      var bits = ['rev ' + n.revision];
      var uk = n.user ? Object.keys(n.user).length : 0;
      if (uk) bits.push(uk + ' 项用户覆盖');
      if ((n.secrets || []).length) bits.push((n.secrets || []).length + ' 个秘密槽');
      m.appendChild(el('span', null, bits.join(' · ')));
      g.appendChild(m);
      row.appendChild(g);
      row.addEventListener('click', function () { nsDetail(n.ns); });
      nsBox.appendChild(row);
    });
    box.appendChild(nsBox);

    var plugBox = el('div', 'pane');
    plugBox.innerHTML = '<h2>已装插件</h2>';
    if (!(st.plugins || []).length) plugBox.appendChild(el('div', 'hint', '插件清单为空（pluginManager 未启用？）'));
    (st.plugins || []).slice(0, 80).forEach(function (p) {
      var row = el('div', 'row');
      row.appendChild(el('div', 'dot ' + (p.enabled === false ? 'idle' : 'run')));
      var g = el('div', 'grow');
      var title = (p.meta && p.meta.title) || p.entryId || p.moduleName;
      g.appendChild(el('div', 't', title));
      var m = el('div', 'm');
      var bits = [p.enabled === false ? '已禁用' : '启用中'];
      if (p.moduleName) bits.push(p.moduleName);
      if (p.readOnlyReason) bits.push('不可改（' + p.readOnlyReason + '）');
      m.appendChild(el('span', null, bits.join(' · ')));
      g.appendChild(m);
      row.appendChild(g);
      row.addEventListener('click', function () { pluginSheet(p); });
      plugBox.appendChild(row);
    });
    box.appendChild(plugBox);
  }

  function credSheet(c) {
    sheet(c.label || c.ref, function (body, close) {
      body.appendChild(el('div', 'sheet-note', c.ref + (c.source ? ' · 来源：' + c.source : '') + (c.ns ? ' · 配置项 ' + c.ns : '')));
      if (!c.writable) {
        body.appendChild(el('div', 'hint', '这个凭据由环境变量提供，不能在这里改'));
        return;
      }
      body.appendChild(sheetRow(c.configured ? '更新密钥' : '设置密钥', '写入服务器的凭据文件，立即生效', function () {
        close();
        secretPrompt(c.label || c.ref, c.ref, function (v) {
          rpc('credentials/set', { ref: c.ref, value: v }).then(function () {
            toast('已保存，重启相关请求后生效');
            settingsReload();
          }).catch(function (e) { toast('保存失败：' + e.message); });
        });
      }));
      if (c.configured) {
        body.appendChild(sheetRow('清除密钥', '从凭据文件移除这一项', function () {
          close();
          rpc('credentials/unset', { ref: c.ref }).then(function () {
            toast('已清除');
            settingsReload();
          }).catch(function (e) { toast('清除失败：' + e.message); });
        }));
      }
    });
  }

  function nsDetail(name) {
    var st = S.settings;
    var n = st && st.doc && st.doc.namespaces.filter(function (x) { return x.ns === name; })[0];
    if (!n) { toast('配置已变化，请刷新'); return; }
    var leaves = settingsLeaves(n.value).slice(0, 60);
    sheet(name, function (body, close) {
      body.appendChild(el('div', 'sheet-note', 'rev ' + n.revision + ' · ' + n.applies + ' 生效'
        + (n.user && Object.keys(n.user).length ? ' · 已有 ' + Object.keys(n.user).length + ' 项用户覆盖' : '')));
      if ((n.secrets || []).length) {
        body.appendChild(el('div', 'sheet-sep', '秘密槽（状态只读）'));
        n.secrets.forEach(function (s) {
          body.appendChild(sheetRow(s.path.join('.'), s.set ? '已设置' : '未设置', function () {}));
        });
      }
      body.appendChild(el('div', 'sheet-sep', '可编辑字段（' + leaves.length + '）'));
      if (!leaves.length) body.appendChild(el('div', 'hint', '这个配置项没有可以直接编辑的标量字段'));
      leaves.forEach(function (leaf) {
        var label = leaf.path.join('.');
        var v = leaf.value;
        var isBool = typeof v === 'boolean';
        var shown = typeof v === 'string' ? truncate(v, 40) : String(v);
        var row = sheetRow(label, shown + (n.user && leaf.path.length === 1 && Object.prototype.hasOwnProperty.call(n.user, leaf.path[0]) ? ' · 已覆盖' : ''), function () {
          if (isBool) {
            close();
            toggleSetting(name, n.revision, leaf.path, !v, label);
          } else {
            var isNum = typeof v === 'number';
            var input = prompt(label + '（' + (isNum ? '数字' : '文本') + '）', String(v));
            if (input === null) return;
            var out = isNum ? Number(input) : input;
            if (isNum && !isFinite(out)) { toast('要填数字'); return; }
            close();
            mutateSetting(name, n.revision, leaf.path, out);
          }
        });
        body.appendChild(row);
      });
    });
  }

  function mutateSetting(ns, rev, path, value) {
    rpc('settings/mutate', { ns: ns, ops: [{ op: 'set', path: path, value: value }], expectedRevision: rev }).then(function () {
      toast('已保存');
      settingsReload();
    }).catch(function (e) {
      var msg = /conflict|stale/.test(String(e.code || '') + e.message) ? '配置已被改动，已刷新，请重试' : '保存失败：' + e.message;
      toast(msg);
      settingsReload();
    });
  }

  function toggleSetting(ns, rev, path, next, label) {
    sheet('确认修改', function (body, close) {
      body.appendChild(el('div', 'sheet-note', label + ' → ' + (next ? '开' : '关')));
      body.appendChild(sheetRow('确认写入', '立即生效（applies: live）', function () {
        close();
        mutateSetting(ns, rev, path, next);
      }));
      body.appendChild(sheetRow('取消', '', close));
    });
  }

  function pluginSheet(p) {
    var title = (p.meta && p.meta.title) || p.entryId || p.moduleName || '插件';
    sheet(title, function (body, close) {
      body.appendChild(el('div', 'sheet-note', [p.entryId, p.moduleName].filter(Boolean).join('  ·  ')));
      if (p.meta && p.meta.description) body.appendChild(el('div', 'sheet-note', p.meta.description));
      if (p.readOnlyReason) {
        body.appendChild(el('div', 'hint', '这一项不能在这里开关：' + p.readOnlyReason));
        return;
      }
      var next = p.enabled === false;
      body.appendChild(sheetRow(next ? '启用' : '禁用', '写回 profile 的 cordis.patch.yml，立即热生效', function () {
        close();
        rpc('pluginManager/setPluginEnabled', { id: p.entryId, enabled: next }).then(function (v) {
          toast((next ? '已启用' : '已禁用') + ((v && v.warnings && v.warnings.length) ? '（有 ' + v.warnings.length + ' 条警告）' : ''));
          settingsReload();
        }).catch(function (e) { toast('操作失败：' + e.message); });
      }));
    });
  }

  // ---------- skills (技能)
  function renderSkills() {
    if (!needSession()) return;
    var st = S.skills;
    var frag = document.createDocumentFragment();
    frag.appendChild(panelHeader('技能', [
      { icon: 'refresh', label: '刷新', on: function () { S.skills = null; renderSkills(); } }
    ]));
    var sc = el('div', 'scroll');
    var box = el('div', 'pane');
    sc.appendChild(box);
    frag.appendChild(sc);
    mount(frag);

    if (!st) {
      box.appendChild(el('div', 'empty', '<span class="spin-sm"></span> 读取技能…'));
      rpc('skills/list', { request: { sessionId: S.cur.id } }).then(function (v) {
        S.skills = { items: (v && v.skills) || [] };
        if (S.view === 'skills') renderSkills();
      }).catch(function (e) {
        S.skills = { items: [], error: '读取技能失败：' + e.message };
        if (S.view === 'skills') renderSkills();
      });
      return;
    }
    box.innerHTML = '';
    if (st.error) box.appendChild(el('div', 'hint', st.error));
    if (!st.items.length) box.appendChild(el('div', 'empty', '这个会话没有可用的技能'));
    st.items.forEach(function (sk) {
      var row = el('div', 'row');
      row.appendChild(el('div', 'dot idle'));
      var g = el('div', 'grow');
      g.appendChild(el('div', 't', '/' + sk.name));
      var m = el('div', 'm');
      m.appendChild(el('span', null, truncate(String(sk.description || '').replace(/\s+/g, ' '), 90)));
      g.appendChild(m);
      row.appendChild(g);
      row.addEventListener('click', function () {
        sheet('/' + sk.name, function (body, close) {
          if (sk.description) body.appendChild(el('div', 'sheet-note', sk.description));
          if (sk.whenToUse) body.appendChild(el('div', 'sheet-note', '何时用：' + sk.whenToUse));
          if (sk.path) body.appendChild(sheetRow('SKILL.md 路径', sk.path, function () { close(); copy(sk.path); }));
          body.appendChild(sheetRow('复制技能名', '/' + sk.name + '（在对话里让模型用它）', function () { close(); copy(sk.name); }));
        });
      });
      box.appendChild(row);
    });
  }

  function header(title, sub, actions, leading) {
    var h = el('div', 'hdr');
    (leading || []).forEach(function (a) {
      var b = el('button', 'iconbtn');
      b.setAttribute('aria-label', a.label);
      if (ICONS[a.icon]) b.appendChild(icon(a.icon, 19)); else b.textContent = a.icon;
      b.addEventListener('click', a.on);
      h.appendChild(b);
    });
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
      if (S.term && S.term.term) { try { S.term.term.options.theme = termTheme(); } catch (e) {} }
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
    pass.type = 'password';
    pass.value = S.loginPass || S.pass || '';
    pass.placeholder = '访问密码';
    pass.addEventListener('input', function () { S.loginPass = pass.value; });
    pass.addEventListener('focus', function () { try { pass.select(); } catch (e) {} });
    inner.appendChild(pass);
    var err = el('div', 'err-box'); err.hidden = true; inner.appendChild(err);
    var go = el('button', 'btn', '登录'); go.style.width = '100%';
    setTimeout(function () { try { if (!pass.value) pass.focus(); } catch (e) {} }, 60);
    go.addEventListener('click', function () {
      S.pass = pass.value; S.loginPass = pass.value; lsSet(K.pass, S.pass);
      go.disabled = true; go.textContent = '登录中…';
      login(S.server, S.pass).then(function () {
        S.authed = true;
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
    S.authed = false;
    if (S.cur && S.cur.followId && S.mux) S.mux.closeStream(S.cur.followId);
    if (S.mux) { S.mux.closed = true; try { S.mux.ws && S.mux.ws.close(); } catch (e) {} S.mux = null; }
    S.muxReady = false;
    S.forwardId = null;
    S.clientId = '';
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
    if (S.drawer) { closeDrawer(); return 'nav'; }
    if (S.term) { closeTermPage(); return 'nav'; }
    if (S.view === 'chat') { leaveChat(); return 'nav'; }
    if (S.view === 'files' || S.view === 'jobs' || S.view === 'goal' || S.view === 'more' || S.view === 'trajectory' || S.view === 'info') { closePanel(); return 'nav'; }
    if (S.view === 'sched' || S.view === 'workspace' || S.view === 'skills') { closePanel(); return 'nav'; }
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
  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('.codecopy') : null;
    if (!b) return;
    var block = b.closest('.codeblock');
    var code = block && block.querySelector('code');
    copy(code ? code.textContent : '');
  });

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
    loadSessions().then(function () {
      // Authenticated: now it is safe to open the live streams.
      mux();
      attachForwardedEvents();
      render();
    }).catch(function (e) {
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
    chatRefs: chatRefs, renderChat: renderChat, setRendered: function (n) { renderedCount = n; },
    // test hooks (used by test/harness*.mjs)
    open: function (id, title) { openSession(id, title); },
    openTerminal: openTerminal,
    termState: function () { return S.term; },
    termWrite: termWrite,
    wsState: function () { return S.ws; },
    settingsState: function () { return S.settings; },
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    skillsState: function () { return S.skills; },
    mutateSetting: mutateSetting,
    pluginSheet: pluginSheet,
    nsDetail: nsDetail,
    schedState: function () { return S.sched; },
    sessionActions: sessionActions,
    archiveBox: archiveBox,
    wsPin: wsPin,
    wsArchive: wsArchive,
    closeTermPage: closeTermPage,
    panel: function (k) { openPanel(k); },
    send: function (text) { return sendPrompt(text, []); },
    list: function () { return loadSessions(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();


