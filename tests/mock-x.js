// 테스트용 모의 X 화면(SPA). 실제 X 의 화면 구조(data-testid) 중 실행기가 쓰는 부분만 흉내 냅니다.
(() => {
  const DB = window.DB = {
    me: 'me',
    tweets: {},          // id -> { id, author, text, liked, rtByMe, deleted, retweetOf }
    bookmarks: [],       // id 목록
    transientOnce: new Set(),
    noDeleteMenu: false,
    keepStale: false,    // true 면 이동 직후 이전 화면을 routeDelay 동안 그대로 둡니다
    routeDelay: 300,
    loggedIn: true,
    batch: 4,
    rlOnce: new Set(),   // 이 ID 의 삭제/취소 요청이 한 번은 429(Too Many Requests)로 실패
    srvFail: new Set(),  // 이 ID 의 삭제/취소 요청은 서버가 항상 거부(200 + errors)
    srvFailOnce: new Set(),
    srvGone: new Set(),      // 서버: 이미 없음(코드 144)
    srvBlockOnce: new Set(), // 서버: 자동화 의심 차단(코드 226) 한 번
    srvAuthOnce: new Set(),  // 서버: 401 한 번
    offlineOnce: new Set(),  // 이 ID 요청 때 인터넷이 잠깐(offlineMs) 끊김
    offlineMs: 1500,
    offline: false,
    timelineCap: 0,          // >0 이면 목록을 한 번에 이 개수까지만 보여 줌(다시 불러오면 다음 것)
    statusHidden: false, // true 면 화면에서 숨겨진 항목은 게시물 화면에서도 '없음'으로 보임(가장 나쁜 경우)
    client: {},          // 화면(클라이언트 저장소)에만 반영된 상태: id -> { deleted, liked, rtByMe, unbm } — 새로고침하면 사라짐
    keep: false,
    log: [],
  };
  // 새로고침 검증용: 서버 상태를 sessionStorage 에 보존
  try {
    if (sessionStorage.getItem('mockKeep') === '1') {
      const saved = JSON.parse(sessionStorage.getItem('mockServer') || '{}');
      Object.assign(DB, saved, { keep: true });
    }
  } catch (e) { /* 무시 */ }
  function save() {
    if (!DB.keep) return;
    try { sessionStorage.setItem('mockServer', JSON.stringify({ me: DB.me, tweets: DB.tweets, bookmarks: DB.bookmarks, log: DB.log })); } catch (e) { /* 무시 */ }
  }
  window.__mockSave = save;
  // 테스트 편의: 내 게시물 여러 개 만들기(최신순)
  window.__mkPosts = (ids) => ids.forEach((id, i) => { DB.tweets[id] = { id, author: DB.me, date: '2023-05-' + String(28 - i).padStart(2, '0') }; });
  try { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => !DB.offline }); } catch (e) { /* 무시 */ }
  const C = (id) => (DB.client[id] = DB.client[id] || {});
  const view = (t) => Object.assign({}, t, DB.client[t.id] || {});

  // 실제 X 와 같은 형식의 요청: POST /i/api/graphql/<queryId>/<작업이름>, 성공 시에만 서버 상태 반영
  function mutate(op, id, varName, apply) {
    let q = '';
    if (DB.rlOnce.has(id)) { DB.rlOnce.delete(id); q = '?rl=1'; DB.log.push('429:' + id); }
    else if (DB.srvFail.has(id)) { q = '?fail=1'; DB.log.push('srvfail:' + id); }
    else if (DB.srvFailOnce.has(id)) { DB.srvFailOnce.delete(id); q = '?fail=1'; DB.log.push('srvfail:' + id); }
    else if (DB.srvGone.has(id)) { q = '?gone=1'; DB.log.push('gone:' + id); }
    else if (DB.srvBlockOnce.has(id)) { DB.srvBlockOnce.delete(id); q = '?block=1'; DB.log.push('block:' + id); }
    else if (DB.srvAuthOnce.has(id)) { DB.srvAuthOnce.delete(id); q = '?auth=1'; DB.log.push('auth:' + id); }
    else if (DB.offlineOnce.has(id)) {
      DB.offlineOnce.delete(id); q = '?net=1'; DB.log.push('offline:' + id);
      DB.offline = true;
      window.dispatchEvent(new Event('offline'));
      setTimeout(() => { DB.offline = false; window.dispatchEvent(new Event('online')); }, DB.offlineMs);
    }
    const x = new XMLHttpRequest();
    x.open('POST', '/i/api/graphql/mockQ/' + op + q);
    x.setRequestHeader('content-type', 'application/json');
    x.onloadend = () => {
      let ok = false;
      try { const j = JSON.parse(x.responseText); ok = x.status === 200 && !j.errors; } catch (e) { ok = false; }
      if (ok) { apply(); save(); }
    };
    x.send(JSON.stringify({ variables: { [varName]: id }, queryId: 'mockQ' }));
  }

  const nav = document.getElementById('nav');
  const col = document.getElementById('col');
  const h = (tag, attrs, html) => {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v));
    if (html != null) e.innerHTML = html;
    return e;
  };

  function renderNav() {
    nav.innerHTML = DB.loggedIn ? '<a data-testid="AppTabBar_Profile_Link" href="/' + DB.me + '">프로필</a>' : '<a href="/login">로그인</a>';
  }

  // t: 서버 상태 객체, src: 화면에 표시할 상태(기본은 화면 저장소 반영)
  function article(t, focal, opts) {
    opts = opts || {};
    const v = opts.server ? t : view(t);
    const a = h('article', { 'data-testid': 'tweet', 'data-id': t.id, style: 'display:block;min-height:260px;border-bottom:1px solid #ccc' });
    // 스레드에서 앞 게시물과 이어지는 선(프로필 사진 위) + 프로필 사진
    if (opts.lineAbove) a.appendChild(h('div', { style: 'width:2px;height:8px;background:rgb(51,54,57);margin-left:19px' }));
    a.appendChild(h('div', { 'data-testid': 'Tweet-User-Avatar', style: 'width:40px;height:40px;background:#888' }));
    const dt = (t.date || '2024-01-01') + 'T00:00:00.000Z';
    if (v.rtByMe && t.author !== DB.me && !focal) a.appendChild(h('div', { 'data-testid': 'socialContext' }, '내가 재게시함'));
    a.appendChild(h('div', { 'data-testid': 'User-Name' },
      '<a href="/' + t.author + '">' + t.author + '</a> <a href="/' + t.author + '/status/' + t.id + '"><time datetime="' + dt + '">' + dt.slice(0, 10) + '</time></a>'));
    // 실제 X처럼: 답글이 앞 글 없이 단독으로 보이면 '○○ 님에게 보내는 답글' 표시가 붙습니다.
    const labelTo = t.replyLabel || (t.replyTo && !opts.lineAbove && !focal && DB.tweets[t.replyTo] ? DB.tweets[t.replyTo].author : null);
    if (labelTo) a.appendChild(h('div', {}, '<a href="/' + labelTo + '">@' + labelTo + '</a> 님에게 보내는 답글'));
    a.appendChild(h('div', { 'data-testid': 'tweetText' }, t.text || ('글 ' + t.id)));
    if (t.quote && DB.tweets[t.quote]) {
      const q = DB.tweets[t.quote];
      a.appendChild(h('div', { class: 'quote' }, '<div data-testid="User-Name"><a href="/' + q.author + '">' + q.author + '</a></div><div>' + (q.text || '인용') + '</div>'));
    }
    const bmOn = DB.bookmarks.includes(t.id) && !(DB.client[t.id] && DB.client[t.id].unbm && !opts.server);
    const g = h('div', { role: 'group' });
    const caret = h('button', { 'data-testid': 'caret' }, '⋯');
    const like = h('button', { 'data-testid': v.liked ? 'unlike' : 'like' }, '♥');
    const rt = h('button', { 'data-testid': v.rtByMe ? 'unretweet' : 'retweet' }, '⟳');
    const bmk = h('button', { 'data-testid': bmOn ? 'removeBookmark' : 'bookmark' }, '🔖');
    g.append(caret, like, rt, bmk);
    a.appendChild(g);

    caret.addEventListener('click', () => openMenu(t));
    like.addEventListener('click', () => {
      if (like.getAttribute('data-testid') !== 'unlike') return;
      C(t.id).liked = false; // 화면에 먼저 반영
      like.setAttribute('data-testid', 'like');
      mutate('UnfavoriteTweet', t.id, 'tweet_id', () => { t.liked = false; DB.log.push('unlike:' + t.id); });
    });
    rt.addEventListener('click', () => {
      if (rt.getAttribute('data-testid') !== 'unretweet') return;
      const menu = h('div', { role: 'menu', id: 'menu' });
      const item = h('div', { role: 'menuitem', 'data-testid': 'unretweetConfirm' }, '<span>재게시 취소</span>');
      item.addEventListener('click', () => {
        menu.remove();
        C(t.id).rtByMe = false;
        rt.setAttribute('data-testid', 'retweet');
        if (/\/reposts\/?$/.test(location.pathname)) a.remove();
        mutate('DeleteRetweet', t.id, 'source_tweet_id', () => { t.rtByMe = false; DB.log.push('unretweet:' + t.id); });
      });
      menu.appendChild(item);
      document.body.appendChild(menu);
    });
    bmk.addEventListener('click', () => {
      if (bmk.getAttribute('data-testid') !== 'removeBookmark') return;
      C(t.id).unbm = true;
      bmk.setAttribute('data-testid', 'bookmark');
      if (/^\/i\/history\/?$/.test(location.pathname)) setTimeout(() => a.remove(), 80);
      mutate('DeleteBookmark', t.id, 'tweet_id', () => { DB.bookmarks = DB.bookmarks.filter((x) => x !== t.id); DB.log.push('unbookmark:' + t.id); });
    });
    return a;
  }

  function closeMenu() { const m = document.getElementById('menu'); if (m) m.remove(); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  function openMenu(t) {
    closeMenu();
    const menu = h('div', { role: 'menu', id: 'menu' });
    const items = [];
    if (t.author === DB.me) {
      if (!DB.noDeleteMenu) items.push(['삭제하기', 'rgb(244, 33, 46)', () => openDeleteDialog(t)]);
      items.push(['내 프로필 메인에 올리기', 'rgb(15, 20, 25)', () => {}]);
    } else {
      items.push(['@' + t.author + ' 님 팔로우하기', 'rgb(15, 20, 25)', () => {}]);
      items.push(['게시물 신고하기', 'rgb(15, 20, 25)', () => {}]);
    }
    items.forEach(([label, color, fn]) => {
      const it = h('div', { role: 'menuitem' }, '<span style="color:' + color + '">' + label + '</span>');
      it.addEventListener('click', () => { closeMenu(); fn(); });
      menu.appendChild(it);
    });
    setTimeout(() => document.body.appendChild(menu), 120);
  }

  function openDeleteDialog(t) {
    const d = h('div', { role: 'dialog', id: 'dlg' });
    const ok = h('button', { 'data-testid': 'confirmationSheetConfirm' }, '삭제하기');
    const no = h('button', { 'data-testid': 'confirmationSheetCancel' }, '취소');
    ok.addEventListener('click', () => {
      d.remove();
      // 실제 X처럼 서버 결과와 상관없이 화면에서 먼저 지웁니다.
      C(t.id).deleted = true;
      if (/\/status\//.test(location.pathname)) col.innerHTML = '<div>게시물을 삭제했습니다</div>';
      else document.querySelectorAll('article[data-id="' + t.id + '"]').forEach((x) => x.remove());
      mutate('DeleteTweet', t.id, 'tweet_id', () => { t.deleted = true; DB.log.push('delete:' + t.id); });
    });
    no.addEventListener('click', () => d.remove());
    d.append(ok, no);
    setTimeout(() => document.body.appendChild(d), 150);
  }

  function errorPage(msg) {
    col.innerHTML = '';
    col.appendChild(h('div', { 'data-testid': 'error-detail' }, msg));
  }

  function renderRoute() {
    const p = location.pathname;
    let m;
    if ((m = /^\/(?:i|[^/]+)\/status\/(\d+)/.exec(p))) {
      const id = m[1];
      if (DB.transientOnce.has(id)) { DB.transientOnce.delete(id); DB.log.push('transient:' + id); return errorPage('문제가 발생했습니다. 다시 시도하세요.'); }
      const t = DB.tweets[id];
      const hiddenHere = DB.statusHidden && DB.client[id] && DB.client[id].deleted;
      if (!t || t.deleted || hiddenHere) return errorPage('이 페이지는 존재하지 않습니다. 다른 페이지를 검색해 보세요.');
      const shown = t.retweetOf ? DB.tweets[t.retweetOf] : t;
      history.replaceState({}, '', '/' + shown.author + '/status/' + shown.id);
      col.innerHTML = '';
      col.appendChild(article(shown, true, { server: !DB.statusHidden }));
      // 답글(다른 사람 글)도 함께 보입니다.
      col.appendChild(article({ id: shown.id + '7', author: 'bob', text: '답글', liked: true }, false));
      return;
    }
    if (/^\/i\/(bookmarks|history)\/?$/.test(p)) {
      if (p !== '/i/history') history.replaceState({}, '', '/i/history');
      col.innerHTML = '<div>북마크 · 마음에 들어요</div>';
      const bms = DB.bookmarks.filter((id) => !(DB.client[id] && DB.client[id].unbm));
      bms.forEach((id) => col.appendChild(article(DB.tweets[id] || (DB.tweets[id] = { id, author: 'alice', text: '북마크 ' + id }), false)));
      if (!bms.length) col.appendChild(h('div', {}, '나중을 위해 게시물 저장'));
      return;
    }
    if (p === '/i/history/likes') {
      col.innerHTML = '<div>마음에 들어요</div>';
      const list = Object.values(DB.tweets).filter((t) => { const v = view(t); return v.liked && !v.deleted; }).sort(byNewest);
      return lazy(list.map((t) => () => article(t, false)));
    }
    if ((m = /^\/([^/]+)\/reposts\/?$/.exec(p)) && m[1].toLowerCase() === DB.me) {
      col.innerHTML = '<div>프로필 ' + DB.me + ' · 재게시</div>';
      const list = Object.values(DB.tweets).filter((t) => { const v = view(t); return !v.deleted && !t.retweetOf && v.rtByMe; }).sort(byNewest);
      return lazy(list.map((t) => () => article(t, false)));
    }
    if ((m = /^\/([^/]+)(\/with_replies)?\/?$/.exec(p)) && m[1].toLowerCase() === DB.me && p !== '/home') {
      const replies = !!m[2];
      col.innerHTML = '<div>프로필 ' + DB.me + (replies ? ' · 답글' : ' · 게시물') + '</div>';
      const list = Object.values(DB.tweets).filter((t) => !view(t).deleted && !t.retweetOf && (
        t.author === DB.me && (replies || (!t.replyTo && !t.replyLabel && !t.hideOnPosts)))).sort(byNewest);
      const makers = [];
      list.forEach((t) => {
        const threaded = replies && t.replyTo && DB.tweets[t.replyTo] && !view(DB.tweets[t.replyTo]).deleted;
        if (threaded) makers.push(() => article(DB.tweets[t.replyTo], false));
        makers.push(() => article(t, false, { lineAbove: threaded }));
      });
      return lazy(makers);
    }
    col.innerHTML = '<div>홈 타임라인</div>';
  }

  const byNewest = (a, b) => ((b.date || '') + b.id).localeCompare((a.date || '') + a.id);
  let pending = [];
  function lazy(makers) {
    pending = DB.timelineCap > 0 ? makers.slice(0, DB.timelineCap) : makers.slice();
    more();
  }
  function more() {
    pending.splice(0, DB.batch || 4).forEach((mk) => col.appendChild(mk()));
  }
  window.addEventListener('scroll', () => {
    if (pending.length && window.innerHeight + window.scrollY >= document.body.scrollHeight - 300) setTimeout(more, 150);
  });

  let timer = null;
  function onRoute() {
    closeMenu();
    pending = [];
    if (!DB.keepStale) col.innerHTML = '<div role="progressbar">로딩</div>';
    clearTimeout(timer);
    timer = setTimeout(renderRoute, DB.routeDelay);
  }
  window.addEventListener('popstate', onRoute);
  window.__mockRender = () => { renderNav(); renderRoute(); };
  renderNav();
  renderRoute();
})();
