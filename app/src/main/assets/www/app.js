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
    if (S.view === 'chat' && S.cur) return renderChatView();
    return renderSessions();
  }

  // ---------- sessions list
  function renderSessions() {
    var wrap = document.createDocumentFragment();
    wrap.appendChild(header('DSH', S.sessions.length ? S.sessions.length + ' 个会话' : '连接中…', [
      { icon: '＋', label: '新会话', on: newSession },
      { icon: '⚙', label: '设置', on: function () { S.view = 'settings'; render(); } }
    ]));

    var sc = el('div', 'scroll');
    if (!S.sessions.length) {
      var e = el('div', 'empty');
      e.innerHTML = S.lastError ? esc(S.lastError) : '<span class="spin-sm"></span>&nbsp; 正在读取会话…';
      sc.appendChild(e);
    }
    var lastCwd = null;
    S.sessions.forEach(function (s) {
      var cwd = s.cwd || '(未知工作区)';
      if (cwd !== lastCwd) {
        lastCwd = cwd;
        sc.appendChild(el('div', 'group-label', baseName(cwd) || cwd));
      }
      sc.appendChild(sessionRow(s));
    });
    // pull-to-refresh-ish: refresh when scrolled to top
    sc.addEventListener('scroll', function () {
      if (sc.scrollTop <= 0 && Date.now() - (renderSessions._last || 0) > 4000) {
        renderSessions._last = Date.now();
        loadSessions().catch(function (e) { if (e.code === 'unauthenticated') showLogin(); });
      }
    });
    wrap.appendChild(sc);
    mount(wrap);
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
    var cwd = S.cwd || (S.sessions[0] && S.sessions[0].cwd) || '';
    if (!cwd) { toast('请先在设置里填写默认工作目录'); S.view = 'settings'; render(); return; }
    toast('正在新建…');
    rpc('session/create', { request: { cwd: cwd } }).then(function (v) {
      return loadSessions().then(function () { openSession(v.sessionId, '（新会话）'); });
    }).catch(function (e) { toast('新建失败：' + e.message); });
  }

  // ---------- chat
  var chatRefs = { log: null, liveNode: null, liveBody: null };
  var renderedCount = 0;

  function renderChatView() {
    var cur = S.cur;
    var frag = document.createDocumentFragment();
    var title = cur.projections.title || cur.title || '会话';
    frag.appendChild(header(title, (cur.header && baseName(cur.header.cwd)) || '', [
      { icon: '←', label: '返回', on: function () { leaveChat(); } },
      { icon: '⋯', label: '菜单', on: function () { chatMenu(); } }
    ]));
    var log = el('div', 'scroll log');
    frag.appendChild(log);
    frag.appendChild(composer());
    mount(frag);
    chatRefs.log = log;
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

  function pickModel() {
    rpc('session/modelCatalog', {}).then(function (cat) {
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
      node = el('div', 'msg assistant');
      var blocks = item.blocks || [];
      var html = '';
      var textSeen = false;
      blocks.forEach(function (b) {
        if (b.type === 'reasoning') {
          html += '<details class="think"><summary>思考过程 · ' + fmtBytes(byteLen(b.text || '')) + '</summary>' + md(b.text || '') + '</details>';
        } else if (b.type === 'text') {
          textSeen = true;
          html += md(b.text || '');
        } else if (b.type === 'tool-call') {
          html += '';
        }
      });
      if (!textSeen) html += '';
      node.innerHTML = html;
      if (!node.innerHTML.trim()) { node.innerHTML = '<span style="color:var(--fg-faint)">（无文本输出）</span>'; }
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
    if (!args || typeof args !== 'object') return '';
    var keys = ['command', 'description', 'path', 'file_path', 'pattern', 'query', 'url', 'prompt', 'text'];
    for (var i = 0; i < keys.length; i++) if (args[keys[i]]) return truncate(String(args[keys[i]]).replace(/\s+/g, ' '), 60);
    var k = Object.keys(args)[0];
    return k ? k + '=' + truncate(String(args[k]).replace(/\s+/g, ' '), 40) : '';
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
    plus.textContent = '＋';
    plus.addEventListener('click', function () { file.click(); });

    line.appendChild(plus); line.appendChild(ta); line.appendChild(send);
    box.appendChild(line);
    box.appendChild(file);

    composerRefs = { ta: ta, send: send, chips: chips, box: box };

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
    if (perms && perms.currentValue) chips.appendChild(el('span', 'chip', perms.currentValue));
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
      send.textContent = '■';
      send.disabled = false;
    } else {
      send.classList.remove('stop');
      send.textContent = '↑';
      send.disabled = !(ta && ta.value.trim()) && !S.pending.length;
    }
  }

  // ---------- header helper
  function header(title, sub, actions) {
    var h = el('div', 'hdr');
    var t = el('h1');
    t.textContent = title;
    if (sub) { var s = el('span', 'sub'); s.textContent = ' ' + sub; t.appendChild(s); }
    h.appendChild(t);
    (actions || []).forEach(function (a) {
      var b = el('button', 'iconbtn');
      b.textContent = a.icon;
      b.setAttribute('aria-label', a.label);
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
    mux();
  }

  /** Android back button: chat → list → settings → exit. */
  function goBack() {
    if (S.view === 'chat') { leaveChat(); return 'nav'; }
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
    loadSessions().catch(function (e) {
      if (e.code === 'unauthenticated') showLogin();
      else { S.lastError = '连不上服务器：' + e.message; render(); }
    });
    setInterval(function () {
      if (S.view === 'sessions' && document.visibilityState === 'visible') loadSessions().catch(function () {});
    }, 6000);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.view === 'sessions') loadSessions().catch(function () {});
  });

  window.__DSHM__ = { state: S, rpc: rpc, md: md, login: login, back: goBack };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

