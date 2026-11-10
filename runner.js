/*! X 정리 실행기 v1
 *
 *  x.com 에 로그인된 탭의 개발자 도구 콘솔에 붙여 넣어 실행합니다.
 *  - 사이트에서 만든 작업 파일(.json)을 읽어, 로그인된 브라우저 세션으로 X 웹이 쓰는 요청을 보냅니다.
 *  - x.com 외의 서버로는 아무것도 전송하지 않습니다.
 *  - X 의 자동화 정책에 위배될 수 있어 계정이 제한되거나 정지될 수 있습니다.
 */
(() => {
  'use strict';

  const prev = window.__xcleanRunner;
  if (prev && typeof prev.destroy === 'function') {
    try { prev.destroy(); } catch (e) { /* 무시 */ }
  }

  const VERSION = 1;
  const HOST_OK = /(^|\.)(x|twitter)\.com$/i.test(location.hostname);

  const XP = XMLHttpRequest.prototype;
  const NATIVE = { fetch: window.fetch, open: XP.open, send: XP.send, setHeader: XP.setRequestHeader };
  const nativeFetch = (input, init) => NATIVE.fetch.call(window, input, init);

  // X 웹 클라이언트가 공개적으로 쓰는 값입니다. 번들에서 찾은 값/실제 요청에서 배운 값이 있으면 그쪽이 우선합니다.
  const BEARER_FALLBACK = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  // 아래 기본값은 시간이 지나면 바뀔 수 있습니다. (번들 탐색 → 실제 요청 학습 순으로 갱신됩니다.)
  const FALLBACK_QID = { DeleteTweet: 'VaenaVgh5q5ih7kvyVjgtg', UnfavoriteTweet: 'ZYKSe-w7KEslx3JhSIk5LA', BookmarksAllDelete: 'skiACZKC1GDYli-M8RzEPQ' };
  const OPS = Object.keys(FALLBACK_QID);

  const SPEEDS = { safe: [1000, 2000, '안전 (건당 1~2초)'], normal: [500, 1000, '보통 (건당 0.5~1초)'], fast: [200, 400, '빠름 (건당 0.2~0.4초)'] };
  const FAIL_LIMIT = 8;
  const GONE_LIMIT = 25;

  /* ------------------------------------------------------------------ 상태 */

  const S = {
    job: null,
    running: false, paused: false, stop: false, confirming: false, mode: null, // mode: 'delete' | 'bm'
    include: { tweets: true, likes: true, bookmarks: true },
    speed: 'normal',
    progress: { tweets: 0, likes: 0, bookmarks: 0 },
    stats: { ok: 0, gone: 0, fail: 0 },
    failed: [],
    consecFail: 0,
    consecGone: 0,
    rateWaits: 0,
    note: '',
    bmCount: 0,
  };

  const learned = { auth: null, ops: {} }; // 페이지가 실제로 보낸 요청에서 배운 값
  const found = {};                         // 번들에서 찾은 queryId
  let foundBearer = null;
  const goodMode = {};                      // op -> 'direct' | 'learned'
  const collector = { active: false, map: new Map() };

  /* ------------------------------------------------- 요청 가로채기(학습 전용) */

  const GQL = /\/i\/api\/graphql\/([^/?]+)\/([A-Za-z0-9_]+)/;
  const BOOKMARKS_RE = /\/i\/api\/graphql\/[^/]+\/Bookmarks(?:\?|$)/;

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => { out[k.toLowerCase()] = v; });
    else if (Array.isArray(h)) h.forEach((p) => { out[String(p[0]).toLowerCase()] = p[1]; });
    else Object.keys(h).forEach((k) => { out[k.toLowerCase()] = h[k]; });
    return out;
  }

  function learn(url, headers) {
    const m = GQL.exec(String(url));
    if (!m) return;
    const h = headersToObject(headers);
    const firstTime = !learned.ops[m[2]];
    learned.ops[m[2]] = { queryId: m[1], headers: h };
    if (h.authorization) learned.auth = h.authorization;
    if (firstTime && OPS.indexOf(m[2]) >= 0) log('X 화면의 요청 형식을 학습했습니다: ' + m[2]);
  }

  window.fetch = function (input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : ((input && input.url) || String(input)); } catch (e) { /* 무시 */ }
    try { if (GQL.test(url)) learn(url, (init && init.headers) || (input && input.headers)); } catch (e) { /* 무시 */ }
    const p = NATIVE.fetch.call(window, input, init);
    if (collector.active && BOOKMARKS_RE.test(url)) {
      p.then((r) => r.clone().json()).then((j) => collectFromJson(j)).catch(() => {});
    }
    return p;
  };
  XP.open = function (method, url) {
    this.__xc = { url: String(url), headers: {} };
    return NATIVE.open.apply(this, arguments);
  };
  XP.setRequestHeader = function (k, v) {
    if (this.__xc) this.__xc.headers[String(k).toLowerCase()] = v;
    return NATIVE.setHeader.apply(this, arguments);
  };
  XP.send = function () {
    const c = this.__xc;
    if (c) {
      try { if (GQL.test(c.url)) learn(c.url, c.headers); } catch (e) { /* 무시 */ }
      if (collector.active && BOOKMARKS_RE.test(c.url)) {
        this.addEventListener('load', () => { try { collectFromJson(JSON.parse(this.responseText)); } catch (e) { /* 무시 */ } });
      }
    }
    return NATIVE.send.apply(this, arguments);
  };

  /* ------------------------------------------------ queryId · 인증 정보 찾기 */

  function scanText(text) {
    for (const op of OPS) {
      if (found[op]) continue;
      const m = new RegExp('queryId:"([A-Za-z0-9_-]{10,40})",operationName:"' + op + '"').exec(text)
        || new RegExp('operationName:"' + op + '",queryId:"([A-Za-z0-9_-]{10,40})"').exec(text);
      if (m) found[op] = m[1];
    }
    if (!foundBearer) {
      const b = /"(AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]{30,})"/.exec(text);
      if (b) foundBearer = 'Bearer ' + b[1];
    }
  }

  const scriptScore = (u) => (/\/(main|api)[.\w-]*\.js/.test(u) ? 2 : 0) + (/twimg\.com/.test(u) ? 1 : 0);

  async function discover() {
    const urls = new Set();
    document.querySelectorAll('script[src]').forEach((s) => urls.add(s.src));
    try {
      performance.getEntriesByType('resource').forEach((r) => { if (/\.js(\?|$)/.test(r.name)) urls.add(r.name); });
    } catch (e) { /* 무시 */ }
    const list = Array.from(urls).filter((u) => /^https:\/\//.test(u)).sort((a, b) => scriptScore(b) - scriptScore(a));
    let n = 0;
    for (const u of list) {
      if (OPS.every((op) => found[op]) && foundBearer) break;
      if (n++ >= 40) break;
      try {
        const r = await nativeFetch(u, { credentials: 'omit' });
        if (r.ok) scanText(await r.text());
      } catch (e) { /* CORS 등으로 못 읽으면 건너뜁니다 */ }
    }
    const got = OPS.filter((op) => found[op]).length;
    log('요청 정보 확인: ' + got + '/' + OPS.length + (got < OPS.length ? ' (나머지는 기본값 사용)' : ''));
  }

  const queryIdFor = (op) => (learned.ops[op] && learned.ops[op].queryId) || found[op] || FALLBACK_QID[op];
  const csrf = () => { const m = /(?:^|;\s*)ct0=([^;]+)/.exec(document.cookie); return m ? decodeURIComponent(m[1]) : ''; };

  function baseHeaders() {
    return {
      authorization: learned.auth || foundBearer || BEARER_FALLBACK,
      'content-type': 'application/json',
      'x-csrf-token': csrf(),
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': (document.documentElement.lang || 'en').split('-')[0],
    };
  }

  /* ----------------------------------------------------------- 요청 보내기 */

  async function post(op, qid, variables, headers) {
    let res;
    try {
      res = await nativeFetch(location.origin + '/i/api/graphql/' + qid + '/' + op, {
        method: 'POST', credentials: 'include', headers, body: JSON.stringify({ variables, queryId: qid }),
      });
    } catch (e) {
      return { kind: 'fail', status: 0, msg: '네트워크 오류: ' + (e && e.message) };
    }
    const status = res.status;
    let body = null;
    try { body = await res.json(); } catch (e) { /* 본문 없음 */ }
    if (status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset'));
      return { kind: 'ratelimit', status, resetAt: reset ? reset * 1000 : null };
    }
    const errs = body && Array.isArray(body.errors) ? body.errors : [];
    const msg = errs.map((e) => (e && (e.message || e.code)) || '').filter(Boolean).join('; ');
    if (status === 200 && body && body.data && errs.length === 0) return { kind: 'ok', status };
    // '이미 없음'은 HTTP 200 안에서 대상 게시물이 없다고 명시한 경우에만 인정합니다.
    // (잘못된 queryId 등으로 나온 404 "page does not exist" 를 성공으로 오인하지 않기 위함)
    if (status === 200 && /no status found|tweet.{0,30}(not found|deleted)|already (deleted|unliked|removed)|was deleted/i.test(msg)) {
      return { kind: 'gone', status, msg };
    }
    if (status === 401 || status === 403 || /csrf|authenticat|forbidden|denied/i.test(msg)) {
      return { kind: 'auth', status, msg: msg || ('HTTP ' + status) };
    }
    return { kind: 'fail', status, msg: msg || ('HTTP ' + status) };
  }

  // 직접 만든 헤더로 먼저 시도하고, 실패하면 페이지가 실제로 보낸 요청에서 배운 헤더로 다시 시도합니다.
  async function callOp(op, variables) {
    const qid = queryIdFor(op);
    const learnedH = learned.ops[op] && learned.ops[op].headers;
    const order = goodMode[op] === 'learned' ? ['learned', 'direct'] : ['direct', 'learned'];
    let last = null;
    for (const m of order) {
      if (m === 'learned' && !learnedH) continue;
      const headers = m === 'direct' ? baseHeaders()
        : Object.assign({ 'content-type': 'application/json' }, learnedH, { 'x-csrf-token': csrf() });
      const r = await post(op, qid, variables, headers);
      if (r.kind === 'ok' || r.kind === 'gone') { goodMode[op] = m; return r; }
      if (r.kind === 'ratelimit') return r;
      last = r;
    }
    return last;
  }

  /* ------------------------------------------------------------- 진행/저장 */

  const storeKey = () => 'xclean:v1:' + (S.job ? S.job.id : 'none');
  function persist() {
    try {
      localStorage.setItem(storeKey(), JSON.stringify({ progress: S.progress, stats: S.stats, failed: S.failed.slice(-2000) }));
    } catch (e) { /* 저장소를 못 쓰면 이어하기만 불가 */ }
  }
  function restore() {
    try {
      const raw = localStorage.getItem(storeKey());
      if (!raw) return false;
      const d = JSON.parse(raw);
      S.progress = Object.assign({ tweets: 0, likes: 0, bookmarks: 0 }, d.progress);
      S.stats = Object.assign({ ok: 0, gone: 0, fail: 0 }, d.stats);
      S.failed = Array.isArray(d.failed) ? d.failed : [];
      return true;
    } catch (e) { return false; }
  }
  function clearProgress() {
    try { localStorage.removeItem(storeKey()); } catch (e) { /* 무시 */ }
    S.progress = { tweets: 0, likes: 0, bookmarks: 0 };
    S.stats = { ok: 0, gone: 0, fail: 0 };
    S.failed = [];
  }

  const randDelay = () => { const r = SPEEDS[S.speed]; return r[0] + Math.random() * (r[1] - r[0]); };

  async function sleep(ms, tick) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (S.stop) return;
      if (tick) tick(Math.ceil((end - Date.now()) / 1000));
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(1, end - Date.now()))));
    }
  }
  async function waitResume() {
    while (S.paused && !S.stop) await new Promise((r) => setTimeout(r, 200));
  }

  async function rateWait(r) {
    S.rateWaits++;
    let ms = r.resetAt ? Math.max(3000, r.resetAt - Date.now() + 1500) : 60000 * Math.pow(2, S.rateWaits - 1);
    ms = Math.min(ms, 16 * 60000);
    log('요청 한도에 도달했습니다. 약 ' + Math.ceil(ms / 1000) + '초 기다립니다.');
    await sleep(ms, (left) => { S.note = '한도 대기 중… ' + left + '초'; render(); });
    S.note = '';
    render();
  }

  function pauseWith(msg) {
    S.paused = true;
    log(msg);
    render();
  }

  /* ---------------------------------------------------------- 삭제 실행 */

  function stagesFor(job) {
    const out = [];
    if (S.include.tweets && job.tweets.length) {
      out.push({ key: 'tweets', ids: job.tweets, op: 'DeleteTweet', label: '게시물·답글 삭제', vars: (id) => ({ tweet_id: id, dark_request: false }) });
    }
    if (S.include.likes && job.likes.length) {
      out.push({ key: 'likes', ids: job.likes, op: 'UnfavoriteTweet', label: '좋아요 취소', vars: (id) => ({ tweet_id: id }) });
    }
    return out;
  }

  const totalWork = () => {
    if (!S.job) return 0;
    let n = 0;
    if (S.include.tweets) n += S.job.tweets.length;
    if (S.include.likes) n += S.job.likes.length;
    if (S.include.bookmarks && S.job.bookmarksAll) n += 1;
    return n;
  };
  const doneWork = () => {
    if (!S.job) return 0;
    let n = 0;
    if (S.include.tweets) n += Math.min(S.progress.tweets, S.job.tweets.length);
    if (S.include.likes) n += Math.min(S.progress.likes, S.job.likes.length);
    if (S.include.bookmarks && S.job.bookmarksAll) n += Math.min(S.progress.bookmarks, 1);
    return n;
  };

  async function runList(st) {
    S.consecFail = 0;
    S.consecGone = 0;
    log(st.label + ' 시작 (' + (st.ids.length - S.progress[st.key]) + '개 남음)');
    while (S.progress[st.key] < st.ids.length) {
      if (S.stop) return;
      if (S.paused) { await waitResume(); continue; }
      const i = S.progress[st.key];
      const id = st.ids[i];
      const r = await callOp(st.op, st.vars(id));

      if (r.kind === 'ratelimit') { await rateWait(r); continue; }
      if (r.kind === 'auth') {
        pauseWith('인증 오류(' + r.status + '): ' + r.msg + ' — X 탭에 로그인되어 있는지 확인하고, 화면을 새로고침하지 말고 \'재개\'를 눌러 주세요.');
        continue;
      }
      if (r.kind === 'ok' || r.kind === 'gone') {
        S.rateWaits = 0;
        S.consecFail = 0;
        if (r.kind === 'ok') { S.stats.ok++; S.consecGone = 0; } else { S.stats.gone++; S.consecGone++; }
      } else {
        S.stats.fail++;
        S.consecFail++;
        S.failed.push({ stage: st.key, id, status: r.status, message: r.msg });
        log('실패 ' + id + ': ' + r.msg);
      }
      S.progress[st.key] = i + 1;
      persist();
      render();

      if (S.consecFail >= FAIL_LIMIT) {
        // 구조적 문제일 가능성이 높으므로, 방금 실패 처리한 항목을 되돌려 다시 시도할 수 있게 합니다.
        const n = S.consecFail;
        S.failed.splice(S.failed.length - n, n);
        S.stats.fail -= n;
        S.progress[st.key] -= n;
        S.consecFail = 0;
        persist();
        pauseWith('연속 ' + n + '회 실패했습니다 (마지막 오류: ' + r.msg + '). X 화면에서 게시물 1개를 직접 삭제하거나 좋아요 1개를 직접 취소하면 실행기가 요청 형식을 학습합니다. 그런 다음 \'재개\'를 눌러 주세요.');
        continue;
      }
      if (S.consecGone >= GONE_LIMIT) {
        S.consecGone = 0;
        pauseWith('연속 ' + GONE_LIMIT + '개가 \'이미 없음\'으로 응답했습니다. 이미 지운 항목일 수 있지만, X 화면에서 실제로 지워졌는지 확인한 뒤 \'재개\'를 눌러 주세요.');
        continue;
      }
      await sleep(randDelay());
    }
  }

  async function runBookmarksAll() {
    log('북마크 전체 삭제 요청');
    for (;;) {
      if (S.stop) return;
      if (S.paused) { await waitResume(); continue; }
      const r = await callOp('BookmarksAllDelete', {});
      if (r.kind === 'ratelimit') { await rateWait(r); continue; }
      if (r.kind === 'ok' || r.kind === 'gone') {
        S.progress.bookmarks = 1;
        log('북마크를 모두 삭제했습니다.');
      } else {
        S.stats.fail++;
        S.failed.push({ stage: 'bookmarks', id: '-', status: r.status, message: r.msg });
        log('북마크 삭제 실패: ' + r.msg);
      }
      break;
    }
    persist();
    render();
  }

  async function startDelete() {
    const job = S.job;
    S.mode = 'delete';
    S.running = true; S.paused = false; S.stop = false; S.confirming = false;
    render();
    await ready;
    if (!csrf()) {
      log('로그인 정보(ct0 쿠키)를 찾지 못했습니다. X 에 로그인된 탭인지 확인해 주세요.');
      finish('중단: 로그인 필요');
      return;
    }
    for (const st of stagesFor(job)) {
      if (S.stop) break;
      await runList(st);
    }
    if (!S.stop && S.include.bookmarks && job.bookmarksAll && S.progress.bookmarks < 1) await runBookmarksAll();
    if (S.stop) finish('중지했습니다. 같은 작업 파일을 다시 선택하면 이어서 진행할 수 있습니다.');
    else finish('완료: 삭제/취소 ' + S.stats.ok + '개, 이미 없음 ' + S.stats.gone + '개, 실패 ' + S.stats.fail + '개');
  }

  function finish(msg) {
    S.running = false; S.paused = false; S.mode = null; S.note = '';
    persist();
    log(msg);
    render();
  }

  /* ---------------------------------------------------------- 북마크 백업 */

  function addBookmark(b) {
    const old = collector.map.get(b.id);
    if (!old) { collector.map.set(b.id, b); return; }
    if (!old.text && b.text) old.text = b.text;
    if (!old.user && b.user) old.user = b.user;
    if (!old.createdAt && b.createdAt) old.createdAt = b.createdAt;
  }

  function findScreenName(node) {
    try {
      const r = node.core && node.core.user_results && node.core.user_results.result;
      return (r && ((r.core && r.core.screen_name) || (r.legacy && r.legacy.screen_name))) || '';
    } catch (e) { return ''; }
  }

  // 응답 JSON 에서 트윗을 찾되, 찾은 트윗 안쪽(인용·리트윗 원본)은 내려가지 않습니다.
  function collectFromJson(node, depth) {
    const d = depth || 0;
    if (!node || typeof node !== 'object' || d > 40) return;
    if (Array.isArray(node)) { node.forEach((n) => collectFromJson(n, d + 1)); return; }
    if (typeof node.rest_id === 'string' && node.legacy && typeof node.legacy.full_text === 'string') {
      addBookmark({ id: node.rest_id, user: findScreenName(node), text: node.legacy.full_text, createdAt: node.legacy.created_at || null });
      return;
    }
    for (const k in node) collectFromJson(node[k], d + 1);
  }

  function scanDom() {
    document.querySelectorAll('article').forEach((a) => {
      const link = Array.from(a.querySelectorAll('a[href*="/status/"]')).find((x) => x.querySelector('time'));
      if (!link) return;
      let path = '';
      try { path = new URL(link.href, location.origin).pathname; } catch (e) { return; }
      const m = /^\/([^/]+)\/status\/(\d+)/.exec(path);
      if (!m) return;
      const textEl = a.querySelector('[data-testid="tweetText"]');
      const timeEl = link.querySelector('time');
      addBookmark({ id: m[2], user: m[1], text: textEl ? textEl.innerText : '', createdAt: timeEl ? timeEl.getAttribute('datetime') : null });
    });
  }

  function download(name, mime, text) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);

  async function backupBookmarks() {
    if (S.running) return;
    if (!/^\/i\/bookmarks/.test(location.pathname)) {
      log('북마크 페이지로 이동한 뒤 다시 눌러 주세요. (왼쪽 메뉴의 \'북마크\'를 클릭하세요. 주소창으로 이동하거나 새로고침하면 실행기가 사라집니다.)');
      return;
    }
    S.mode = 'bm'; S.running = true; S.stop = false; S.paused = false;
    collector.active = true; collector.map.clear();
    log('북마크 수집을 시작합니다. 화면이 자동으로 아래로 스크롤됩니다.');
    render();
    scanDom();
    window.scrollTo(0, 0);
    await sleep(600);
    let idle = 0; let last = -1;
    while (!S.stop && idle < 8) {
      scanDom();
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      await sleep(900);
      scanDom();
      S.bmCount = collector.map.size;
      S.note = '북마크 수집 중… ' + S.bmCount + '개';
      render();
      if (collector.map.size === last) idle++; else { idle = 0; last = collector.map.size; }
    }
    collector.active = false;
    const list = Array.from(collector.map.values());
    if (list.length) {
      download('x-bookmarks-backup-' + stamp() + '.json', 'application/json', JSON.stringify({
        format: 'xclean-bookmarks', version: 1, exportedAt: new Date().toISOString(),
        bookmarks: list.map((b) => ({ id: b.id, url: 'https://x.com/' + (b.user || 'i') + '/status/' + b.id, user: b.user, createdAt: b.createdAt, text: b.text })),
      }, null, 2));
    }
    S.running = false; S.mode = null; S.note = '';
    log(list.length ? '북마크 ' + list.length + '개를 파일로 저장했습니다.' : '수집된 북마크가 없습니다.');
    render();
  }

  /* ------------------------------------------------------------------ UI */

  const ui = {};
  let host = null;

  function el(tag, style, props, kids) {
    const e = document.createElement(tag);
    if (style) Object.assign(e.style, style);
    if (props) Object.keys(props).forEach((k) => { if (k === 'text') e.textContent = props[k]; else e[k] = props[k]; });
    if (kids) kids.forEach((c) => e.appendChild(c));
    return e;
  }

  function btn(label, onClick, tone) {
    const bg = tone === 'danger' ? '#f4212e' : tone === 'primary' ? '#1d9bf0' : '#2f3b45';
    const b = el('button', {
      background: bg, color: '#fff', border: '0', borderRadius: '8px', padding: '7px 12px', font: 'inherit', fontWeight: '600', cursor: 'pointer',
    }, { type: 'button', text: label });
    b.addEventListener('click', onClick);
    return b;
  }
  function setEnabled(b, on) { b.disabled = !on; b.style.opacity = on ? '1' : '0.4'; b.style.cursor = on ? 'pointer' : 'not-allowed'; }
  const show = (e, on, display) => { e.style.display = on ? (display || '') : 'none'; };
  const fmt = (n) => Number(n).toLocaleString('ko-KR');

  function log(msg) {
    if (!ui.log) return;
    const line = el('div', { padding: '1px 0', wordBreak: 'break-all' }, { text: new Date().toTimeString().slice(0, 8) + '  ' + msg });
    ui.log.appendChild(line);
    while (ui.log.childNodes.length > 80) ui.log.removeChild(ui.log.firstChild);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function buildUi() {
    host = document.createElement('div');
    host.id = 'xclean-runner-host';
    host.style.all = 'initial';
    Object.assign(host.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647', display: 'block' });
    const root = host.attachShadow({ mode: 'open' });

    const panel = el('div', {
      width: '360px', maxWidth: 'calc(100vw - 32px)', background: '#0f1419', color: '#e7e9ea',
      font: '13px/1.5 system-ui, -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
      border: '1px solid #38444d', borderRadius: '12px', boxShadow: '0 8px 30px rgba(0,0,0,.55)', overflow: 'hidden',
    });

    // 머리글
    const head = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', background: '#16202a', borderBottom: '1px solid #38444d' });
    head.appendChild(el('strong', { fontSize: '14px' }, { text: 'X 정리 실행기' }));
    const headBtns = el('div', { display: 'flex', gap: '6px' });
    const minBtn = btn('–', () => { show(ui.body, ui.body.style.display === 'none', 'flex'); }, 'neutral');
    const closeBtn = btn('✕', () => destroy(), 'neutral');
    minBtn.title = '접기/펼치기'; closeBtn.title = '닫기 (진행 중이면 중지됩니다)';
    minBtn.style.padding = closeBtn.style.padding = '2px 9px';
    headBtns.appendChild(minBtn); headBtns.appendChild(closeBtn);
    head.appendChild(headBtns);
    panel.appendChild(head);

    const body = el('div', { padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' });
    ui.body = body;
    panel.appendChild(body);

    ui.hostWarn = el('div', { color: '#ff7b72', display: 'none' }, { text: 'x.com 또는 twitter.com 탭에서만 사용할 수 있습니다.' });
    body.appendChild(ui.hostWarn);

    // 작업 파일 선택
    ui.fileInput = el('input', { display: 'none' }, { type: 'file', accept: '.json,application/json' });
    const pick = el('label', {
      display: 'block', textAlign: 'center', padding: '9px', border: '1px dashed #536471', borderRadius: '8px', cursor: 'pointer', color: '#8ecdf8',
    }, { text: '작업 파일(.json) 선택' }, [ui.fileInput]);
    ui.pick = pick;
    ui.fileInput.addEventListener('change', onFile);
    body.appendChild(pick);

    ui.summary = el('div', { color: '#9ba7b0', whiteSpace: 'pre-line' });
    body.appendChild(ui.summary);

    // 포함 항목
    ui.opts = el('div', { display: 'flex', flexDirection: 'column', gap: '3px' });
    body.appendChild(ui.opts);

    // 속도
    ui.speedRow = el('div', { display: 'flex', alignItems: 'center', gap: '8px' });
    ui.speedRow.appendChild(el('span', null, { text: '속도' }));
    ui.speed = el('select', { flex: '1', background: '#16202a', color: '#e7e9ea', border: '1px solid #38444d', borderRadius: '6px', padding: '5px', font: 'inherit' });
    Object.keys(SPEEDS).forEach((k) => ui.speed.appendChild(el('option', null, { value: k, text: SPEEDS[k][2] })));
    ui.speed.value = S.speed;
    ui.speed.addEventListener('change', () => { S.speed = ui.speed.value; });
    ui.speedRow.appendChild(ui.speed);
    body.appendChild(ui.speedRow);

    // 버튼
    ui.btnRow = el('div', { display: 'flex', gap: '6px', flexWrap: 'wrap' });
    ui.start = btn('시작', onStartClick, 'primary');
    ui.pause = btn('일시정지', onPauseClick, 'neutral');
    ui.stopBtn = btn('중지', () => { S.stop = true; S.paused = false; log('중지 요청'); render(); }, 'danger');
    ui.btnRow.appendChild(ui.start); ui.btnRow.appendChild(ui.pause); ui.btnRow.appendChild(ui.stopBtn);
    body.appendChild(ui.btnRow);

    // 시작 확인
    ui.confirm = el('div', { display: 'none', border: '1px solid #f4212e', borderRadius: '8px', padding: '9px', background: '#2a1517' });
    ui.confirmText = el('div', { marginBottom: '8px', whiteSpace: 'pre-line' });
    ui.confirm.appendChild(ui.confirmText);
    const cRow = el('div', { display: 'flex', gap: '6px' });
    ui.confirmYes = btn('되돌릴 수 없음을 이해했습니다. 시작', () => startDelete(), 'danger');
    ui.confirmNo = btn('취소', () => { S.confirming = false; render(); }, 'neutral');
    cRow.appendChild(ui.confirmYes); cRow.appendChild(ui.confirmNo);
    ui.confirm.appendChild(cRow);
    body.appendChild(ui.confirm);

    // 진행률
    ui.barWrap = el('div', { height: '8px', background: '#2f3b45', borderRadius: '4px', overflow: 'hidden' });
    ui.bar = el('div', { height: '100%', width: '0%', background: '#1d9bf0' });
    ui.barWrap.appendChild(ui.bar);
    body.appendChild(ui.barWrap);
    ui.progressText = el('div', { color: '#e7e9ea' });
    body.appendChild(ui.progressText);

    // 기록
    ui.log = el('div', {
      maxHeight: '120px', overflowY: 'auto', background: '#0a0e12', border: '1px solid #26323c', borderRadius: '6px',
      padding: '6px 8px', fontSize: '11px', color: '#9ba7b0', fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    });
    body.appendChild(ui.log);

    // 보조 기능
    ui.extra = el('div', { display: 'flex', gap: '6px', flexWrap: 'wrap' });
    ui.bmBackup = btn('북마크 백업', () => backupBookmarks(), 'neutral');
    ui.failSave = btn('실패 목록 저장', () => {
      download('xclean-failed-' + stamp() + '.json', 'application/json', JSON.stringify(S.failed, null, 2));
    }, 'neutral');
    ui.resetProg = btn('진행 기록 지우기', () => { if (!S.running) { clearProgress(); log('진행 기록을 지웠습니다.'); render(); } }, 'neutral');
    ui.extra.appendChild(ui.bmBackup); ui.extra.appendChild(ui.failSave); ui.extra.appendChild(ui.resetProg);
    body.appendChild(ui.extra);

    root.appendChild(panel);
    document.documentElement.appendChild(host);
  }

  function onStartClick() {
    if (!S.job || S.running) return;
    if (totalWork() === 0) { log('실행할 항목이 없습니다. 항목을 선택해 주세요.'); return; }
    if (doneWork() >= totalWork()) { log('이미 완료된 작업입니다. 다시 하려면 \'진행 기록 지우기\'를 누르세요.'); return; }
    S.confirming = true;
    render();
  }
  function onPauseClick() {
    if (!S.running || S.mode !== 'delete') return;
    S.paused = !S.paused;
    log(S.paused ? '일시정지' : '재개');
    render();
  }

  async function onFile() {
    const f = ui.fileInput.files && ui.fileInput.files[0];
    ui.fileInput.value = '';
    if (!f || S.running) return;
    try {
      const job = validateJob(JSON.parse(await f.text()));
      S.job = job;
      S.include = { tweets: job.tweets.length > 0, likes: job.likes.length > 0, bookmarks: job.bookmarksAll };
      S.progress = { tweets: 0, likes: 0, bookmarks: 0 };
      S.stats = { ok: 0, gone: 0, fail: 0 };
      S.failed = [];
      const resumed = restore();
      log('작업 파일을 불러왔습니다' + (resumed ? ' (이전 진행 기록을 이어받았습니다)' : '') + '.');
      buildOpts();
    } catch (e) {
      S.job = null;
      log('작업 파일 오류: ' + e.message);
    }
    S.confirming = false;
    render();
  }

  function validateJob(o) {
    if (!o || o.format !== 'xclean-job' || o.version !== 1) throw new Error('X 정리 도구에서 만든 작업 파일이 아닙니다.');
    const clean = (a) => (Array.isArray(a) ? a.map(String).filter((s) => /^\d{1,25}$/.test(s)) : []);
    return {
      id: String(o.id || '').replace(/[^0-9a-f]/gi, '').slice(0, 24) || 'nojob',
      createdAt: o.createdAt || '',
      tweets: clean(o.tweets), likes: clean(o.likes), bookmarksAll: !!o.bookmarksAll,
    };
  }

  function buildOpts() {
    ui.opts.textContent = '';
    const mk = (key, label, count) => {
      const cb = el('input', { margin: '0 6px 0 0' }, { type: 'checkbox', checked: S.include[key] && count > 0, disabled: count === 0 });
      cb.addEventListener('change', () => { S.include[key] = cb.checked; render(); });
      ui.opts.appendChild(el('label', { display: 'flex', alignItems: 'center', opacity: count ? '1' : '0.5' }, null, [cb, el('span', null, { text: label })]));
    };
    mk('tweets', '게시물·답글 삭제 (' + fmt(S.job.tweets.length) + '개)', S.job.tweets.length);
    mk('likes', '좋아요 취소 (' + fmt(S.job.likes.length) + '개)', S.job.likes.length);
    mk('bookmarks', '북마크 전체 삭제', S.job.bookmarksAll ? 1 : 0);
  }

  function render() {
    if (!host) return;
    show(ui.hostWarn, !HOST_OK);
    show(ui.pick, HOST_OK && !S.running, 'block');
    const loaded = !!S.job;
    show(ui.opts, loaded, 'flex');
    show(ui.speedRow, loaded, 'flex');

    if (loaded) {
      const d = S.job.createdAt ? new Date(S.job.createdAt) : null;
      ui.summary.textContent = '작업 파일: ' + (d && !isNaN(d) ? d.toLocaleString('ko-KR') + ' 생성' : S.job.id);
    } else {
      ui.summary.textContent = '사이트에서 만든 작업 파일을 선택해 주세요.';
    }

    const total = totalWork();
    const done = doneWork();
    const pct = total ? Math.round((done / total) * 100) : 0;
    ui.bar.style.width = pct + '%';
    let t = '';
    if (loaded) {
      t = fmt(done) + ' / ' + fmt(total) + ' (' + pct + '%)  ·  삭제/취소 ' + fmt(S.stats.ok) + '  ·  이미 없음 ' + fmt(S.stats.gone) + '  ·  실패 ' + fmt(S.stats.fail);
    }
    if (S.note) t = (t ? t + '\n' : '') + S.note;
    ui.progressText.style.whiteSpace = 'pre-line';
    ui.progressText.textContent = t;
    show(ui.barWrap, loaded);

    const busy = S.running;
    setEnabled(ui.start, HOST_OK && loaded && !busy && !S.confirming && total > 0);
    setEnabled(ui.pause, busy && S.mode === 'delete');
    ui.pause.textContent = S.paused ? '재개' : '일시정지';
    setEnabled(ui.stopBtn, busy);
    show(ui.confirm, S.confirming && !busy);
    if (S.confirming) {
      const parts = [];
      if (S.include.tweets && S.job.tweets.length) parts.push('게시물·답글 ' + fmt(S.job.tweets.length - Math.min(S.progress.tweets, S.job.tweets.length)) + '개 삭제');
      if (S.include.likes && S.job.likes.length) parts.push('좋아요 ' + fmt(S.job.likes.length - Math.min(S.progress.likes, S.job.likes.length)) + '개 취소');
      if (S.include.bookmarks && S.job.bookmarksAll && S.progress.bookmarks < 1) parts.push('북마크 전체 삭제');
      ui.confirmText.textContent = parts.join('\n') + '\n\n삭제는 되돌릴 수 없습니다. 백업을 받으셨는지 확인해 주세요.\n실행 중에는 이 탭을 새로고침하거나 닫지 마세요.';
    }
    setEnabled(ui.bmBackup, HOST_OK && !busy);
    show(ui.failSave, S.failed.length > 0);
    show(ui.resetProg, loaded && !busy && (done > 0 || S.stats.fail > 0));
  }

  /* ------------------------------------------------------------ 시작/종료 */

  function destroy() {
    S.stop = true; S.paused = false;
    collector.active = false;
    window.fetch = NATIVE.fetch;
    XP.open = NATIVE.open; XP.send = NATIVE.send; XP.setRequestHeader = NATIVE.setHeader;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    if (window.__xcleanRunner && window.__xcleanRunner.version === VERSION) delete window.__xcleanRunner;
  }
  window.__xcleanRunner = { version: VERSION, destroy };

  buildUi();
  let ready = Promise.resolve();
  if (HOST_OK) {
    ready = discover().catch(() => {});
  } else {
    log('이 탭(' + location.hostname + ')에서는 실행할 수 없습니다.');
  }
  render();
  log('실행기 v' + VERSION + ' 준비됨. 작업 파일을 선택해 주세요.');
})();
