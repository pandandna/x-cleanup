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
    rlOnce: new Set(),   // 이 ID 를 삭제할 때 한 번은 429(Too Many Requests)로 실패
    log: [],
  };

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

  function article(t, focal) {
    const a = h('article', { 'data-testid': 'tweet', 'data-id': t.id, style: 'display:block;min-height:260px;border-bottom:1px solid #ccc' });
    const dt = (t.date || '2024-01-01') + 'T00:00:00.000Z';
    if (t.rtByMe && t.author !== DB.me && !focal) a.appendChild(h('div', { 'data-testid': 'socialContext' }, '내가 재게시함'));
    a.appendChild(h('div', { 'data-testid': 'User-Name' },
      '<a href="/' + t.author + '">' + t.author + '</a> <a href="/' + t.author + '/status/' + t.id + '"><time datetime="' + dt + '">' + dt.slice(0, 10) + '</time></a>'));
    a.appendChild(h('div', { 'data-testid': 'tweetText' }, t.text || ('글 ' + t.id)));
    if (t.quote && DB.tweets[t.quote]) {
      const q = DB.tweets[t.quote];
      a.appendChild(h('div', { class: 'quote' }, '<div data-testid="User-Name"><a href="/' + q.author + '">' + q.author + '</a></div><div>' + (q.text || '인용') + '</div>'));
    }
    const g = h('div', { role: 'group' });
    const caret = h('button', { 'data-testid': 'caret' }, '⋯');
    const like = h('button', { 'data-testid': t.liked ? 'unlike' : 'like' }, '♥');
    const rt = h('button', { 'data-testid': t.rtByMe ? 'unretweet' : 'retweet' }, '⟳');
    const bmk = h('button', { 'data-testid': DB.bookmarks.includes(t.id) ? 'removeBookmark' : 'bookmark' }, '🔖');
    g.append(caret, like, rt, bmk);
    a.appendChild(g);

    caret.addEventListener('click', () => openMenu(t));
    like.addEventListener('click', () => {
      setTimeout(() => {
        t.liked = !t.liked;
        like.setAttribute('data-testid', t.liked ? 'unlike' : 'like');
        DB.log.push((t.liked ? 'like:' : 'unlike:') + t.id);
      }, 150);
    });
    rt.addEventListener('click', () => {
      if (!t.rtByMe) return;
      const menu = h('div', { role: 'menu', id: 'menu' });
      const item = h('div', { role: 'menuitem', 'data-testid': 'unretweetConfirm' }, '<span>재게시 취소</span>');
      item.addEventListener('click', () => {
        menu.remove();
        setTimeout(() => { t.rtByMe = false; rt.setAttribute('data-testid', 'retweet'); DB.log.push('unretweet:' + t.id); }, 150);
      });
      menu.appendChild(item);
      document.body.appendChild(menu);
    });
    bmk.addEventListener('click', () => {
      if (bmk.getAttribute('data-testid') !== 'removeBookmark') return;
      setTimeout(() => {
        DB.bookmarks = DB.bookmarks.filter((x) => x !== t.id);
        DB.log.push('unbookmark:' + t.id);
        bmk.setAttribute('data-testid', 'bookmark');
        if (/^\/i\/history/.test(location.pathname)) a.remove();
      }, 120);
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
      if (DB.rlOnce.has(t.id)) {
        DB.rlOnce.delete(t.id);
        DB.log.push('429:' + t.id);
        const x = new XMLHttpRequest();
        x.open('POST', '/i/api/graphql/mockQid/DeleteTweet?rl=1');
        x.send('{}');
        return; // 삭제되지 않음
      }
      setTimeout(() => {
        t.deleted = true;
        DB.log.push('delete:' + t.id);
        if (/\/status\//.test(location.pathname)) col.innerHTML = '<div>게시물을 삭제했습니다</div>';
        else document.querySelectorAll('article[data-id="' + t.id + '"]').forEach((x) => x.remove());
      }, 200);
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
      if (!t || t.deleted) return errorPage('이 페이지는 존재하지 않습니다. 다른 페이지를 검색해 보세요.');
      const shown = t.retweetOf ? DB.tweets[t.retweetOf] : t;
      history.replaceState({}, '', '/' + shown.author + '/status/' + shown.id);
      col.innerHTML = '';
      col.appendChild(article(shown, true));
      // 답글(다른 사람 글)도 함께 보입니다.
      col.appendChild(article({ id: shown.id + '7', author: 'bob', text: '답글', liked: true }, false));
      return;
    }
    if (/^\/i\/(bookmarks|history)\/?$/.test(p)) {
      if (p !== '/i/history') history.replaceState({}, '', '/i/history');
      col.innerHTML = '<div>북마크 · 마음에 들어요</div>';
      DB.bookmarks.forEach((id) => col.appendChild(article(DB.tweets[id] || { id, author: 'alice', text: '북마크 ' + id }, false)));
      if (!DB.bookmarks.length) col.appendChild(h('div', {}, '나중을 위해 게시물 저장'));
      return;
    }
    if (p === '/i/history/likes') {
      col.innerHTML = '<div>마음에 들어요</div>';
      const list = Object.values(DB.tweets).filter((t) => t.liked && !t.deleted).sort(byNewest);
      return lazy(list.map((t) => () => article(t, false)));
    }
    if ((m = /^\/([^/]+)(\/with_replies)?\/?$/.exec(p)) && m[1].toLowerCase() === DB.me && p !== '/home') {
      const replies = !!m[2];
      col.innerHTML = '<div>프로필 ' + DB.me + (replies ? ' · 답글' : ' · 게시물') + '</div>';
      const list = Object.values(DB.tweets).filter((t) => !t.deleted && !t.retweetOf && (
        (t.author === DB.me && (replies || !t.replyTo)) || (t.rtByMe && t.author !== DB.me && !replies))).sort(byNewest);
      const makers = [];
      list.forEach((t) => {
        if (replies && t.replyTo && DB.tweets[t.replyTo]) makers.push(() => article(DB.tweets[t.replyTo], false));
        makers.push(() => article(t, false));
      });
      return lazy(makers);
    }
    col.innerHTML = '<div>홈 타임라인</div>';
  }

  const byNewest = (a, b) => ((b.date || '') + b.id).localeCompare((a.date || '') + a.id);
  let pending = [];
  function lazy(makers) {
    pending = makers.slice();
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
