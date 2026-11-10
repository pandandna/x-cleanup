/*! X 정리 실행기 v2 (화면 조작 방식)
 *
 *  x.com 에 로그인된 탭의 개발자 도구 콘솔에 붙여 넣어 실행합니다.
 *  - 사이트에서 만든 작업 파일(.json)을 읽어, X 화면의 버튼을 사람이 누르는 순서대로 자동으로 누릅니다.
 *    (게시물 페이지 이동 → ⋯ → 삭제하기 → 확인 / 하트 버튼 / 북마크 버튼)
 *  - X 의 비공개 요청을 직접 만들지 않으며, x.com 외의 서버로는 아무것도 전송하지 않습니다.
 *  - X 의 자동화 정책에 위배될 수 있어 계정이 제한되거나 정지될 수 있습니다.
 */
(() => {
  'use strict';

  const prev = window.__xcleanRunner;
  if (prev && typeof prev.destroy === 'function') {
    try { prev.destroy(); } catch (e) { /* 무시 */ }
  }

  const VERSION = 2;
  const HOST_OK = /(^|\.)(x|twitter)\.com$/i.test(location.hostname);

  // 항목 사이 대기 시간(밀리초). 화면 이동·클릭 자체에도 1~3초가 걸립니다.
  const SPEEDS = { safe: [2500, 4500, '안전 (항목 사이 2.5~4.5초)'], normal: [1200, 2500, '보통 (항목 사이 1.2~2.5초)'], fast: [600, 1200, '빠름 (항목 사이 0.6~1.2초)'] };
  const FAIL_LIMIT = 5;       // 연속 실패 시 일시정지
  const GONE_LIMIT = 30;      // 연속 '이미 없음' 시 일시정지
  const TRANSIENT_LIMIT = 4;  // '문제가 발생했습니다' 화면이 연속으로 나올 때 일시정지
  const PAGE_TIMEOUT = 15000;
  // 테스트용: 대기 시간 배율(기본 1)
  const TS = Number(window.__xcleanTimeScale) > 0 ? Number(window.__xcleanTimeScale) : 1;

  /* ------------------------------------------------------------------ 상태 */

  const S = {
    job: null,
    running: false, paused: false, stop: false, confirming: false, mode: null, // mode: 'delete' | 'bm'
    include: { tweets: true, likes: true, bookmarks: true },
    speed: 'normal',
    dry: false,          // 시험 실행: 확인 창까지만 열고 취소
    stash: null,
    progress: { tweets: 0, likes: 0, bookmarks: 0 },
    stats: { ok: 0, gone: 0, fail: 0 },
    failed: [],
    consecFail: 0,
    consecGone: 0,
    transient: 0,
    note: '',
    bmCount: 0,
  };

  const bm = { map: new Map() };

  /* ------------------------------------------------------------ 화면 도우미 */

  const tick = (ms) => new Promise((r) => setTimeout(r, ms));

  async function sleep(ms, onTick) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (S.stop) return;
      if (onTick) onTick(Math.ceil((end - Date.now()) / 1000));
      await tick(Math.min(250, Math.max(1, end - Date.now())));
    }
  }

  // 조건이 참(값)이 될 때까지 기다립니다. 중지되거나 시간이 지나면 null.
  async function waitFor(fn, timeout, step) {
    const end = Date.now() + (timeout || 8000);
    for (;;) {
      if (S.stop) return null;
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() >= end) return null;
      await tick(step || 150);
    }
  }

  // 새로고침 없이 X 화면 안에서 주소를 바꿉니다(실행기가 사라지지 않도록).
  function go(path) {
    if (location.pathname === path) return;
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }

  function press(el) {
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* 무시 */ }
    el.click();
  }

  function closeMenus() {
    const ev = () => new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
    try { (document.activeElement || document.body).dispatchEvent(ev()); } catch (e) { /* 무시 */ }
    try { document.dispatchEvent(ev()); } catch (e) { /* 무시 */ }
  }

  const statusIdOf = (path) => { const m = /\/status\/(\d+)/.exec(path || ''); return m ? m[1] : null; };

  // 해당 게시물 ID 의 '본문' article (시간 링크가 그 ID 를 가리키는 것)
  function focalArticle(id) {
    if (!id) return null;
    const arts = document.querySelectorAll('article');
    for (const a of arts) {
      const links = a.querySelectorAll('a[href*="/status/' + id + '"]');
      for (const l of links) {
        if (l.querySelector('time') && statusIdOf(l.getAttribute('href')) === id) return a;
      }
    }
    return null;
  }

  const primaryText = () => {
    const pc = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main') || document.body;
    return (pc && pc.innerText) || '';
  };

  const TRANSIENT_RE = /문제가 발생|다시 시도|something went wrong|try reloading|try again|retry|rate limit|too many requests|一時的|エラーが発生/i;
  const GONE_RE = /존재하지 않|삭제되었|삭제된 게시물|사용할 수 없|볼 수 없|doesn.t exist|does not exist|was deleted|has been deleted|unavailable|no longer available|このページは存在しません|削除されました/i;

  // 게시물 페이지 상태: {kind:'article', el} | {kind:'gone'} | {kind:'transient'} | null(아직 로딩 중)
  function pageState(id) {
    const cur = statusIdOf(location.pathname);
    const a = focalArticle(id) || (cur && cur !== id ? focalArticle(cur) : null);
    if (a) return { kind: 'article', el: a };
    if (document.querySelectorAll('article').length === 0 || document.querySelector('[data-testid="error-detail"]')) {
      const t = primaryText();
      const err = document.querySelector('[data-testid="error-detail"]');
      const et = (err && err.innerText) || '';
      if (TRANSIENT_RE.test(et)) return { kind: 'transient', msg: et.slice(0, 80) };
      if (err || GONE_RE.test(t)) {
        if (GONE_RE.test(et) || GONE_RE.test(t)) return { kind: 'gone', msg: (et || t).replace(/\s+/g, ' ').slice(0, 60) };
        if (TRANSIENT_RE.test(t)) return { kind: 'transient', msg: t.slice(0, 80) };
        return { kind: 'gone', msg: (et || '오류 화면').replace(/\s+/g, ' ').slice(0, 60) };
      }
    }
    return null;
  }

  async function openStatus(id) {
    // 같은 게시물을 다시 시도하는 경우(오류 화면 뒤) 주소가 같아 화면이 새로 그려지지 않으므로, 홈을 거쳐 다시 엽니다.
    if (statusIdOf(location.pathname) === id) {
      go('/home');
      await waitFor(() => location.pathname === '/home' && !focalArticle(id) && !document.querySelector('[data-testid="error-detail"]'), 4000);
    }
    const t0 = Date.now();
    go('/i/status/' + id);
    // 오류/없음 판정은 이동 직후 이전 화면이 잠깐 남아 있을 수 있으므로 1.8초가 지난 뒤에만 인정합니다.
    const st = await waitFor(() => {
      const s = pageState(id);
      if (!s) return null;
      if (s.kind === 'article') return s;
      return Date.now() - t0 >= 1800 ? s : null;
    }, PAGE_TIMEOUT, 200);
    if (!st) {
      if (S.stop) return null;
      // 삭제된 게시물 자리(묘비 표시)만 있고 답글만 보이는 경우
      if (document.querySelector('[data-testid*="tombstone" i]') || GONE_RE.test(primaryText().slice(0, 400))) {
        return { kind: 'gone', msg: '게시물을 볼 수 없음' };
      }
      return { kind: 'fail', msg: '게시물 화면이 열리지 않았습니다(시간 초과)' };
    }
    // 화면이 다 그려지도록 잠깐 더 기다립니다.
    if (st.kind === 'article') await tick(350);
    return st;
  }

  function myProfilePath() {
    const a = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    return a ? (a.getAttribute('href') || '').toLowerCase() : '';
  }
  function isMine(art) {
    const me = myProfilePath();
    if (!me) return null; // 알 수 없음
    const links = art.querySelectorAll('[data-testid="User-Name"] a[href]');
    for (const l of links) if ((l.getAttribute('href') || '').toLowerCase() === me) return true;
    return false;
  }

  const DELETE_RE = /^(삭제|delete|削除|eliminar|supprimer|löschen|excluir|elimina|usuń|sil|удалить|hapus|xóa)/i;
  function isRed(el) {
    const node = el.querySelector('span') || el;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(node).color || '');
    return !!m && +m[1] > 190 && +m[2] < 90 && +m[3] < 90;
  }
  const menuItems = () => Array.from(document.querySelectorAll('[role="menuitem"]'));
  function findDeleteItem() {
    const items = menuItems();
    return items.find((m) => DELETE_RE.test((m.innerText || m.textContent || '').trim()))
      || items.find((m) => m.getAttribute('data-testid') === 'delete')
      || items.find((m) => isRed(m) && !/block|차단|report|신고/i.test(m.innerText || ''))
      || null;
  }

  /* ----------------------------------------------------------- 항목 처리 */

  // 반환: {kind:'ok'|'gone'|'fail'|'transient', msg}
  async function deleteTweet(id) {
    const st = await openStatus(id);
    if (!st || st.kind !== 'article') return st || { kind: 'fail', msg: '중지됨' };
    const art = st.el;
    const mine = isMine(art);

    if (mine !== false) {
      const caret = art.querySelector('[data-testid="caret"]');
      if (caret) {
        press(caret);
        const item = await waitFor(() => (menuItems().length ? findDeleteItem() || 'none' : null), 5000);
        if (item && item !== 'none') {
          press(item);
          const ok = await waitFor(() => document.querySelector('[data-testid="confirmationSheetConfirm"]'), 5000);
          if (!ok) { closeMenus(); return { kind: 'fail', msg: '삭제 확인 창이 나타나지 않았습니다' }; }
          if (S.dry) {
            const cancel = document.querySelector('[data-testid="confirmationSheetCancel"]');
            if (cancel) press(cancel); else closeMenus();
            await waitFor(() => !document.querySelector('[data-testid="confirmationSheetConfirm"]') || null, 4000);
            return { kind: 'ok', msg: '시험: 삭제 확인 창까지 확인' };
          }
          press(ok);
          const done = await waitFor(() => !art.isConnected || !focalArticle(id) || null, 10000);
          if (done) return { kind: 'ok' };
          return { kind: 'fail', msg: '삭제 후에도 게시물이 남아 있습니다' };
        }
        closeMenus();
        await tick(300);
        if (mine === true) return { kind: 'fail', msg: '메뉴에서 \'삭제하기\'를 찾지 못했습니다' };
      }
    }

    // 내 게시물이 아니면 리트윗(재게시) 기록입니다 → 재게시 취소
    const un = art.querySelector('[data-testid="unretweet"]');
    if (un) {
      if (S.dry) return { kind: 'ok', msg: '시험: 재게시 취소 버튼 확인' };
      press(un);
      const c = await waitFor(() => document.querySelector('[data-testid="unretweetConfirm"]'), 5000);
      if (!c) { closeMenus(); return { kind: 'fail', msg: '재게시 취소 메뉴가 나타나지 않았습니다' }; }
      press(c);
      const done = await waitFor(() => art.querySelector('[data-testid="retweet"]') || !art.isConnected, 8000);
      return done ? { kind: 'ok' } : { kind: 'fail', msg: '재게시 취소가 확인되지 않았습니다' };
    }
    return { kind: 'gone', msg: '내 게시물이 아니거나 이미 재게시를 취소함' };
  }

  async function unlikeTweet(id) {
    const st = await openStatus(id);
    if (!st || st.kind !== 'article') return st || { kind: 'fail', msg: '중지됨' };
    const art = st.el;
    const un = art.querySelector('[data-testid="unlike"]');
    if (!un) {
      if (art.querySelector('[data-testid="like"]')) return { kind: 'gone', msg: '이미 좋아요가 취소됨' };
      return { kind: 'fail', msg: '좋아요 버튼을 찾지 못했습니다' };
    }
    if (S.dry) return { kind: 'ok', msg: '시험: 좋아요 취소 버튼 확인' };
    press(un);
    const done = await waitFor(() => art.querySelector('[data-testid="like"]') || !art.isConnected, 8000);
    return done ? { kind: 'ok' } : { kind: 'fail', msg: '좋아요 취소가 확인되지 않았습니다' };
  }

  /* ------------------------------------------------------------- 진행/저장 */

  const storeKey = () => 'xclean:v2:' + (S.job ? S.job.id : 'none');
  function persist() {
    if (S.dry) return; // 시험 실행은 진행 기록에 남기지 않습니다
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

  const randDelay = () => { const r = SPEEDS[S.speed]; return (r[0] + Math.random() * (r[1] - r[0])) * TS; };

  async function waitResume() {
    while (S.paused && !S.stop) await tick(200);
  }

  function pauseWith(msg) {
    S.paused = true;
    log(msg);
    render();
  }

  async function transientWait() {
    S.transient++;
    const ms = Math.min(30000 * Math.pow(2, S.transient - 1), 8 * 60000) * TS;
    log('X 화면에 오류(일시적 제한일 수 있음)가 표시되었습니다. 약 ' + Math.ceil(ms / 1000) + '초 기다린 뒤 다시 시도합니다.');
    await sleep(ms, (left) => { S.note = '대기 중… ' + left + '초'; render(); });
    S.note = '';
    render();
  }

  /* ---------------------------------------------------------- 실행 */

  function stagesFor(job) {
    const out = [];
    if (S.include.tweets && job.tweets.length) out.push({ key: 'tweets', ids: job.tweets, label: '게시물·답글 삭제', fn: deleteTweet });
    if (S.include.likes && job.likes.length) out.push({ key: 'likes', ids: job.likes, label: '좋아요 취소', fn: unlikeTweet });
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
    S.transient = 0;
    log(st.label + ' 시작 (' + (st.ids.length - S.progress[st.key]) + '개 남음)');
    while (S.progress[st.key] < st.ids.length) {
      if (S.stop) return;
      if (S.paused) { await waitResume(); continue; }
      const i = S.progress[st.key];
      const id = st.ids[i];
      S.note = '처리 중: ' + id;
      render();
      let r;
      try { r = await st.fn(id); } catch (e) { r = { kind: 'fail', msg: '스크립트 오류: ' + (e && e.message) }; }
      if (S.stop) return;
      if (!r) continue;

      if (r.kind === 'transient') {
        if (S.transient >= TRANSIENT_LIMIT) {
          S.transient = 0;
          pauseWith('X 오류 화면이 계속 나타납니다(' + (r.msg || '') + '). 잠시(30분 이상) 쉬었다가 \'재개\'를 눌러 주세요.');
        } else {
          await transientWait();
        }
        continue;
      }
      S.transient = 0;
      S.note = '';
      if (r.kind === 'ok' || r.kind === 'gone') {
        S.consecFail = 0;
        if (r.kind === 'ok') { S.stats.ok++; S.consecGone = 0; } else { S.stats.gone++; S.consecGone++; }
      } else {
        S.stats.fail++;
        S.consecFail++;
        S.failed.push({ stage: st.key, id, message: r.msg });
        log('실패 ' + id + ': ' + r.msg);
      }
      S.progress[st.key] = i + 1;
      persist();
      render();

      if (S.consecFail >= FAIL_LIMIT) {
        // 화면 구조가 바뀌었거나 제한에 걸린 경우일 가능성이 높으므로, 방금 실패한 항목들을 되돌립니다.
        const n = S.consecFail;
        S.failed.splice(S.failed.length - n, n);
        S.stats.fail -= n;
        S.progress[st.key] -= n;
        S.consecFail = 0;
        persist();
        pauseWith('연속 ' + n + '회 실패했습니다 (마지막: ' + r.msg + '). X 화면을 직접 확인해 보시고, 문제가 없으면 \'재개\'를 눌러 주세요.');
        continue;
      }
      if (S.consecGone >= GONE_LIMIT) {
        S.consecGone = 0;
        pauseWith('연속 ' + GONE_LIMIT + '개가 \'이미 없음\'이었습니다. 이미 지운 항목일 수 있습니다. 확인 후 \'재개\'를 눌러 주세요.');
        continue;
      }
      await sleep(randDelay());
    }
    S.note = '';
  }

  const BM_PATH_RE = /^\/i\/(bookmarks|history)\/?$/;

  async function openBookmarks() {
    go('/i/bookmarks');
    return waitFor(() => BM_PATH_RE.test(location.pathname) && (document.querySelector('article') || primaryText().length > 20), PAGE_TIMEOUT, 200);
  }

  async function runBookmarksAll() {
    log('북마크 해제 시작');
    if (!(await openBookmarks())) {
      if (!S.stop) {
        S.stats.fail++;
        S.failed.push({ stage: 'bookmarks', id: '-', message: '북마크 화면이 열리지 않았습니다' });
        log('북마크 화면이 열리지 않았습니다.');
      }
      return;
    }
    await tick(1200);
    if (S.dry) {
      const n = await waitFor(() => document.querySelectorAll('article [data-testid="removeBookmark"]').length, 4000) || 0;
      S.progress.bookmarks = 1;
      S.stats.ok += n;
      log('시험: 화면에 보이는 북마크 ' + n + '개의 해제 버튼을 확인했습니다.');
      render();
      return;
    }
    let removed = 0; let idle = 0;
    while (!S.stop) {
      if (S.paused) { await waitResume(); continue; }
      if (!BM_PATH_RE.test(location.pathname)) { await openBookmarks(); await tick(800); }
      const b = document.querySelector('article [data-testid="removeBookmark"]');
      if (!b) {
        idle++;
        if (idle > 4) break;
        window.scrollBy(0, Math.round(window.innerHeight * 0.9));
        await sleep(1200);
        continue;
      }
      idle = 0;
      press(b);
      await waitFor(() => !b.isConnected || b.getAttribute('data-testid') !== 'removeBookmark' || null, 5000);
      removed++;
      S.note = '북마크 ' + removed + '개 해제';
      render();
      await sleep(Math.max(400, randDelay() / 2));
    }
    if (S.stop) return;
    S.progress.bookmarks = 1;
    S.stats.ok += removed;
    S.note = '';
    log('북마크 ' + removed + '개를 해제했습니다.');
    persist();
    render();
  }

  async function startDelete() {
    const job = S.job;
    S.mode = 'delete';
    S.running = true; S.paused = false; S.stop = false; S.confirming = false;
    if (S.dry) {
      S.stash = { progress: S.progress, stats: S.stats, failed: S.failed };
      S.progress = { tweets: 0, likes: 0, bookmarks: 0 };
      S.stats = { ok: 0, gone: 0, fail: 0 };
      S.failed = [];
      log('시험 실행을 시작합니다. 실제로 지우지 않고 확인 창까지만 열었다가 취소합니다.');
    }
    render();
    if (!myProfilePath()) {
      log('로그인된 X 화면이 아닌 것 같습니다. 로그인 후 홈 화면에서 다시 실행해 주세요.');
      finish('중단: 로그인 필요');
      return;
    }
    if (document.hidden) log('주의: 이 탭이 화면에 보이지 않으면 브라우저가 속도를 크게 늦춥니다. 이 탭을 띄워 두세요.');
    for (const st of stagesFor(job)) {
      if (S.stop) break;
      await runList(st);
    }
    if (!S.stop && S.include.bookmarks && job.bookmarksAll && S.progress.bookmarks < 1) await runBookmarksAll();
    if (S.dry) {
      const r = S.stats;
      if (S.stop) finish('시험 실행을 중지했습니다.');
      else finish('시험 실행 완료: 처리 가능 ' + r.ok + '개, 이미 없음 ' + r.gone + '개, 실패 ' + r.fail + '개 (실제로 지운 것은 없습니다)');
      return;
    }
    if (S.stop) finish('중지했습니다. 같은 작업 파일을 다시 선택하면 이어서 진행할 수 있습니다.');
    else finish('완료: 삭제/취소 ' + S.stats.ok + '개, 이미 없음 ' + S.stats.gone + '개, 실패 ' + S.stats.fail + '개');
  }

  function finish(msg) {
    S.running = false; S.paused = false; S.mode = null; S.note = '';
    persist();
    log(msg);
    if (S.stash) {
      // 시험 실행 결과는 기록에 남기고, 실제 진행 상황은 원래대로 되돌립니다.
      if (S.dry) S.failed.forEach((f) => log('시험 실패 ' + f.id + ': ' + f.message));
      S.progress = S.stash.progress; S.stats = S.stash.stats; S.failed = S.stash.failed; S.stash = null;
    }
    render();
  }

  /* ---------------------------------------------------------- 북마크 백업 */

  function scanDom() {
    document.querySelectorAll('article').forEach((a) => {
      const link = Array.from(a.querySelectorAll('a[href*="/status/"]')).find((x) => x.querySelector('time'));
      if (!link) return;
      let path = '';
      try { path = new URL(link.href, location.origin).pathname; } catch (e) { return; }
      const m = /^\/([^/]+)\/status\/(\d+)/.exec(path);
      if (!m || bm.map.has(m[2])) return;
      const textEl = a.querySelector('[data-testid="tweetText"]');
      const timeEl = link.querySelector('time');
      bm.map.set(m[2], { id: m[2], user: m[1], text: textEl ? textEl.innerText : '', createdAt: timeEl ? timeEl.getAttribute('datetime') : null });
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
    S.mode = 'bm'; S.running = true; S.stop = false; S.paused = false;
    bm.map.clear();
    log('북마크 화면으로 이동해 수집합니다. 화면이 자동으로 스크롤됩니다.');
    render();
    if (!(await openBookmarks())) {
      S.running = false; S.mode = null;
      log('북마크 화면이 열리지 않았습니다.');
      render();
      return;
    }
    await sleep(1500);
    window.scrollTo(0, 0);
    await sleep(600);
    let idle = 0; let last = -1;
    while (!S.stop && idle < 8) {
      scanDom();
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      await sleep(1000);
      scanDom();
      S.bmCount = bm.map.size;
      S.note = '북마크 수집 중… ' + S.bmCount + '개';
      render();
      if (bm.map.size === last) idle++; else { idle = 0; last = bm.map.size; }
    }
    const list = Array.from(bm.map.values());
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

    ui.fileInput = el('input', { display: 'none' }, { type: 'file', accept: '.json,application/json' });
    const pick = el('label', {
      display: 'block', textAlign: 'center', padding: '9px', border: '1px dashed #536471', borderRadius: '8px', cursor: 'pointer', color: '#8ecdf8',
    }, { text: '작업 파일(.json) 선택' }, [ui.fileInput]);
    ui.pick = pick;
    ui.fileInput.addEventListener('change', onFile);
    body.appendChild(pick);

    ui.summary = el('div', { color: '#9ba7b0', whiteSpace: 'pre-line' });
    body.appendChild(ui.summary);

    ui.opts = el('div', { display: 'flex', flexDirection: 'column', gap: '3px' });
    body.appendChild(ui.opts);

    ui.speedRow = el('div', { display: 'flex', alignItems: 'center', gap: '8px' });
    ui.speedRow.appendChild(el('span', null, { text: '속도' }));
    ui.speed = el('select', { flex: '1', background: '#16202a', color: '#e7e9ea', border: '1px solid #38444d', borderRadius: '6px', padding: '5px', font: 'inherit' });
    Object.keys(SPEEDS).forEach((k) => ui.speed.appendChild(el('option', null, { value: k, text: SPEEDS[k][2] })));
    ui.speed.value = S.speed;
    ui.speed.addEventListener('change', () => { S.speed = ui.speed.value; });
    ui.speedRow.appendChild(ui.speed);
    body.appendChild(ui.speedRow);

    ui.dry = el('input', { margin: '0 6px 0 0' }, { type: 'checkbox', checked: S.dry });
    ui.dry.addEventListener('change', () => { S.dry = ui.dry.checked; S.confirming = false; render(); });
    ui.dryRow = el('label', { display: 'flex', alignItems: 'center', color: '#8ecdf8' }, null, [ui.dry, el('span', null, { text: '시험 실행 (지우지 않고 확인 창까지만 열고 취소)' })]);
    body.appendChild(ui.dryRow);

    ui.btnRow = el('div', { display: 'flex', gap: '6px', flexWrap: 'wrap' });
    ui.start = btn('시작', onStartClick, 'primary');
    ui.pause = btn('일시정지', onPauseClick, 'neutral');
    ui.stopBtn = btn('중지', () => { S.stop = true; S.paused = false; log('중지 요청'); render(); }, 'danger');
    ui.btnRow.appendChild(ui.start); ui.btnRow.appendChild(ui.pause); ui.btnRow.appendChild(ui.stopBtn);
    body.appendChild(ui.btnRow);

    ui.confirm = el('div', { display: 'none', border: '1px solid #f4212e', borderRadius: '8px', padding: '9px', background: '#2a1517' });
    ui.confirmText = el('div', { marginBottom: '8px', whiteSpace: 'pre-line' });
    ui.confirm.appendChild(ui.confirmText);
    const cRow = el('div', { display: 'flex', gap: '6px' });
    ui.confirmYes = btn('되돌릴 수 없음을 이해했습니다. 시작', () => startDelete(), 'danger');
    ui.confirmNo = btn('취소', () => { S.confirming = false; render(); }, 'neutral');
    cRow.appendChild(ui.confirmYes); cRow.appendChild(ui.confirmNo);
    ui.confirm.appendChild(cRow);
    body.appendChild(ui.confirm);

    ui.barWrap = el('div', { height: '8px', background: '#2f3b45', borderRadius: '4px', overflow: 'hidden' });
    ui.bar = el('div', { height: '100%', width: '0%', background: '#1d9bf0' });
    ui.barWrap.appendChild(ui.bar);
    body.appendChild(ui.barWrap);
    ui.progressText = el('div', { color: '#e7e9ea' });
    body.appendChild(ui.progressText);

    ui.log = el('div', {
      maxHeight: '120px', overflowY: 'auto', background: '#0a0e12', border: '1px solid #26323c', borderRadius: '6px',
      padding: '6px 8px', fontSize: '11px', color: '#9ba7b0', fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    });
    body.appendChild(ui.log);

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
    if (S.dry) { startDelete(); return; }
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
    mk('bookmarks', '북마크 전체 해제', S.job.bookmarksAll ? 1 : 0);
  }

  function render() {
    if (!host) return;
    show(ui.hostWarn, !HOST_OK);
    show(ui.pick, HOST_OK && !S.running, 'block');
    const loaded = !!S.job;
    show(ui.opts, loaded, 'flex');
    show(ui.speedRow, loaded, 'flex');
    show(ui.dryRow, loaded, 'flex');
    ui.dry.disabled = S.running;
    ui.start.textContent = S.dry ? '시험 실행' : '시작';

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
      t = fmt(done) + ' / ' + fmt(total) + ' (' + pct + '%)  ·  ' + (S.dry && S.stash ? '처리 가능 ' : '삭제/취소 ') + fmt(S.stats.ok) + '  ·  이미 없음 ' + fmt(S.stats.gone) + '  ·  실패 ' + fmt(S.stats.fail);
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
      if (S.include.bookmarks && S.job.bookmarksAll && S.progress.bookmarks < 1) parts.push('북마크 전체 해제');
      ui.confirmText.textContent = parts.join('\n') + '\n\n삭제는 되돌릴 수 없습니다. 백업을 받으셨는지 확인해 주세요.\n실행 중에는 이 탭을 새로고침하거나 닫지 말고, 화면에 띄워 두세요.\n(실행기가 X 화면을 자동으로 이동하며 버튼을 누릅니다.)';
    }
    setEnabled(ui.bmBackup, HOST_OK && !busy);
    show(ui.failSave, S.failed.length > 0);
    show(ui.resetProg, loaded && !busy && (done > 0 || S.stats.fail > 0));
  }

  /* ------------------------------------------------------------ 시작/종료 */

  function destroy() {
    S.stop = true; S.paused = false;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    if (window.__xcleanRunner && window.__xcleanRunner.version === VERSION) delete window.__xcleanRunner;
  }
  window.__xcleanRunner = { version: VERSION, destroy };

  buildUi();
  if (!HOST_OK) log('이 탭(' + location.hostname + ')에서는 실행할 수 없습니다.');
  render();
  log('실행기 v' + VERSION + ' 준비됨 (화면 조작 방식). 작업 파일을 선택해 주세요.');
})();
