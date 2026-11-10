/* X 정리 도구 — 화면 로직. 모든 처리는 브라우저 안에서만 이루어집니다. */
(function () {
  'use strict';

  const X = window.XClean;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const fmt = (n) => Number(n).toLocaleString('ko-KR');
  const pad = (n) => String(n).padStart(2, '0');
  const PAGE_SIZE = 100;
  const KIND_LABEL = X.KIND_LABEL;

  const state = {
    tweetMap: new Map(),
    likeMap: new Map(),
    tweets: [],
    likes: [],
    tOver: new Map(), // id -> 직접 바꾼 선택(true/false)
    lOver: new Map(),
    tView: 'match', tPage: 0,
    lView: 'match', lPage: 0,
    tab: 'tweets',
  };

  /* ------------------------------------------------------------------ 공통 */

  let toastTimer;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3800);
  }

  function debounce(fn, ms) {
    let id;
    return function () { clearTimeout(id); id = setTimeout(fn, ms); };
  }

  function download(name, mime, text) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const stamp = () => { const d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); };

  function fmtDate(ts) {
    if (ts == null) return '-';
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function parseDateInput(v, endOfDay) {
    if (!v) return null;
    const [y, m, d] = v.split('-').map(Number);
    if (!y || !m || !d) return null;
    return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime();
  }

  /* ------------------------------------------------------- 1. 파일 불러오기 */

  const statusList = $('#load-status');

  function addStatus(text, cls) {
    const li = document.createElement('li');
    li.className = cls || '';
    li.textContent = text;
    statusList.appendChild(li);
    return li;
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    for (const f of files) {
      const busy = addStatus(f.name + ' 읽는 중…', 'busy');
      try {
        const res = await X.loadFile(f, (m) => { busy.textContent = m; });
        X.mergeTweets(state.tweetMap, res.headers);   // 본문 없는 헤더 먼저
        X.mergeTweets(state.tweetMap, res.tweets);    // 본문 있는 항목이 우선
        X.mergeLikes(state.likeMap, res.likes);
        busy.remove();
        if (!res.sources.length) {
          addStatus(f.name + ': 게시물·좋아요 데이터를 찾지 못했습니다.', 'err');
        }
        for (const s of res.sources) {
          const label = s.kind === 'likes' ? '좋아요' : s.kind === 'headers' ? '게시물 목록(본문 없음)' : '게시물';
          addStatus(s.name + ' — ' + label + ' ' + fmt(s.count) + '개', 'ok');
        }
      } catch (e) {
        busy.remove();
        addStatus(f.name + ': ' + (e && e.message ? e.message : '읽을 수 없는 파일입니다.'), 'err');
      }
    }
    state.tweets = Array.from(state.tweetMap.values()).sort((a, b) => (b.ts == null ? -1 : b.ts) - (a.ts == null ? -1 : a.ts));
    state.likes = Array.from(state.likeMap.values());
    state.tOver.clear(); state.lOver.clear();
    state.tPage = 0; state.lPage = 0;
    recomputeTweets(); recomputeLikes();
    renderTweets(); renderLikes(); updateExport();
    if (state.tweets.length || state.likes.length) {
      addStatus('합계 — 게시물·답글 ' + fmt(state.tweets.length) + '개, 좋아요 ' + fmt(state.likes.length) + '개', 'ok');
      toast('아카이브를 불러왔습니다.');
    }
  }

  const fileInput = $('#file-input');
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files);
    await handleFiles(files);
    fileInput.value = '';
  });
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { handleFiles(e.dataTransfer && e.dataTransfer.files); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  drop.tabIndex = 0;

  /* ------------------------------------------------------------------ 탭 */

  function selectTab(name) {
    state.tab = name;
    document.querySelectorAll('.tabs [role="tab"]').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === name));
    });
    ['tweets', 'likes', 'bookmarks'].forEach((n) => { $('#panel-' + n).hidden = n !== name; });
  }
  document.querySelectorAll('.tabs [role="tab"]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

  /* ----------------------------------------------------- 2-1. 게시물·답글 */

  function readTweetFilter() {
    return {
      kinds: {
        original: $('#k-original').checked, reply: $('#k-reply').checked,
        retweet: $('#k-retweet').checked, unknown: $('#k-unknown').checked,
      },
      from: parseDateInput($('#f-from').value, false),
      to: parseDateInput($('#f-to').value, true),
      include: X.splitWords($('#f-include').value),
      exclude: X.splitWords($('#f-exclude').value),
      keepFav: Number($('#f-keepfav').value) || 0,
      protect: X.parseProtectList($('#f-protect').value),
    };
  }

  function recomputeTweets() {
    const f = readTweetFilter();
    for (const t of state.tweets) {
      t._match = X.tweetMatches(t, f);
      t._sel = state.tOver.has(t.id) ? state.tOver.get(t.id) : t._match;
    }
  }

  function countTweets() {
    let match = 0; let sel = 0;
    for (const t of state.tweets) { if (t._match) match++; if (t._sel) sel++; }
    return { match, sel };
  }

  function visibleTweets() {
    const v = state.tView;
    return state.tweets.filter((t) => (v === 'all' ? true : v === 'match' ? t._match : !t._match));
  }

  function setTweetSel(t, val) {
    t._sel = val;
    if (val === t._match) state.tOver.delete(t.id); else state.tOver.set(t.id, val);
    updateTweetSummary();
    updateExport();
  }

  function updateTweetSummary() {
    const { match, sel } = countTweets();
    const total = state.tweets.length;
    const el = $('#tw-summary');
    if (!total) { el.textContent = ''; $('#tab-tweets-count').textContent = ''; return; }
    el.textContent = '';
    el.append('전체 ' + fmt(total) + '개 중 삭제할 항목 ' + fmt(sel) + '개');
    const manual = state.tOver.size;
    if (manual) {
      const s = document.createElement('span');
      s.className = 'muted';
      s.textContent = '  (필터 해당 ' + fmt(match) + '개, 직접 조정 ' + fmt(manual) + '개)';
      el.appendChild(s);
    }
    $('#tab-tweets-count').textContent = fmt(sel);
  }

  function renderTweets() {
    updateTweetSummary();
    const list = visibleTweets();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.tPage >= pages) state.tPage = pages - 1;
    const body = $('#tw-body');
    body.textContent = '';
    const slice = list.slice(state.tPage * PAGE_SIZE, (state.tPage + 1) * PAGE_SIZE);
    const frag = document.createDocumentFragment();
    for (const t of slice) frag.appendChild(tweetRow(t));
    body.appendChild(frag);

    const empty = $('#tw-empty');
    if (!state.tweets.length) { empty.hidden = false; empty.textContent = '아카이브를 불러오면 목록이 표시됩니다.'; }
    else if (!list.length) { empty.hidden = false; empty.textContent = '조건에 해당하는 항목이 없습니다.'; }
    else empty.hidden = true;

    $('#tw-page').textContent = list.length ? (state.tPage + 1) + ' / ' + pages + ' 쪽 · ' + fmt(list.length) + '개' : '';
    $('#tw-prev').disabled = state.tPage <= 0;
    $('#tw-next').disabled = state.tPage >= pages - 1;
    $('#tw-all').checked = slice.length > 0 && slice.every((t) => t._sel);
  }

  function tweetRow(t) {
    const tr = document.createElement('tr');
    tr.className = t._sel ? '' : 'off';
    const c0 = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t._sel;
    cb.setAttribute('aria-label', '삭제 대상으로 선택');
    cb.addEventListener('change', () => { setTweetSel(t, cb.checked); tr.className = cb.checked ? '' : 'off'; });
    c0.appendChild(cb);
    const c1 = document.createElement('td'); c1.className = 'date'; c1.textContent = fmtDate(t.ts);
    const c2 = document.createElement('td'); c2.className = 'kind'; c2.textContent = KIND_LABEL[t.kind] || t.kind;
    const c3 = document.createElement('td'); c3.className = 'text';
    c3.textContent = t.noText ? '(본문 없음 — 아카이브 헤더 파일)' : t.text.replace(/\s+/g, ' ');
    c3.title = t.text;
    const c4 = document.createElement('td'); c4.className = 'fav'; c4.textContent = t.fav ? fmt(t.fav) : '';
    tr.append(c0, c1, c2, c3, c4);
    return tr;
  }

  function onTweetFilterChange() {
    state.tPage = 0;
    recomputeTweets();
    renderTweets();
    updateExport();
  }
  const onTweetFilterDebounced = debounce(onTweetFilterChange, 200);
  ['#k-original', '#k-reply', '#k-retweet', '#k-unknown', '#f-from', '#f-to', '#f-keepfav'].forEach((s) => {
    $(s).addEventListener('change', onTweetFilterChange);
    $(s).addEventListener('input', onTweetFilterDebounced);
  });
  ['#f-include', '#f-exclude', '#f-protect'].forEach((s) => $(s).addEventListener('input', onTweetFilterDebounced));

  document.querySelectorAll('input[name="tw-view"]').forEach((r) => r.addEventListener('change', () => {
    state.tView = r.value; state.tPage = 0; renderTweets();
  }));
  $('#tw-prev').addEventListener('click', () => { state.tPage--; renderTweets(); });
  $('#tw-next').addEventListener('click', () => { state.tPage++; renderTweets(); });
  $('#tw-all').addEventListener('change', (e) => {
    const list = visibleTweets().slice(state.tPage * PAGE_SIZE, (state.tPage + 1) * PAGE_SIZE);
    for (const t of list) {
      t._sel = e.target.checked;
      if (t._sel === t._match) state.tOver.delete(t.id); else state.tOver.set(t.id, t._sel);
    }
    renderTweets(); updateExport();
  });
  $('#tw-reset-over').addEventListener('click', () => { state.tOver.clear(); recomputeTweets(); renderTweets(); updateExport(); });

  function setFilterForm(opts) {
    $('#k-original').checked = opts.original !== false;
    $('#k-reply').checked = opts.reply !== false;
    $('#k-retweet').checked = opts.retweet !== false;
    $('#k-unknown').checked = opts.unknown !== false;
    $('#f-from').value = opts.from || '';
    $('#f-to').value = opts.to || '';
    $('#f-include').value = opts.include || '';
    $('#f-exclude').value = opts.exclude || '';
    $('#f-keepfav').value = opts.keepFav || '';
    $('#f-protect').value = opts.protect || '';
    state.tOver.clear();
    onTweetFilterChange();
  }
  $('#p-reset').addEventListener('click', () => setFilterForm({}));
  $('#p-reply').addEventListener('click', () => setFilterForm({ original: false, retweet: false, unknown: false }));
  $('#p-year').addEventListener('click', () => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    setFilterForm({ to: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) });
  });

  /* ---------------------------------------------------------- 2-2. 좋아요 */

  function readLikeFilter() {
    return { include: X.splitWords($('#l-include').value), exclude: X.splitWords($('#l-exclude').value) };
  }
  function recomputeLikes() {
    const f = readLikeFilter();
    for (const l of state.likes) {
      l._match = X.likeMatches(l, f);
      l._sel = state.lOver.has(l.id) ? state.lOver.get(l.id) : l._match;
    }
  }
  function visibleLikes() {
    const v = state.lView;
    return state.likes.filter((l) => (v === 'all' ? true : v === 'match' ? l._match : !l._match));
  }
  function updateLikeSummary() {
    const total = state.likes.length;
    const el = $('#lk-summary');
    if (!total) { el.textContent = ''; $('#tab-likes-count').textContent = ''; return; }
    let sel = 0; let match = 0;
    for (const l of state.likes) { if (l._sel) sel++; if (l._match) match++; }
    el.textContent = '전체 ' + fmt(total) + '개 중 취소할 항목 ' + fmt(sel) + '개';
    if (state.lOver.size) {
      const s = document.createElement('span');
      s.className = 'muted';
      s.textContent = '  (필터 해당 ' + fmt(match) + '개, 직접 조정 ' + fmt(state.lOver.size) + '개)';
      el.appendChild(s);
    }
    $('#tab-likes-count').textContent = fmt(sel);
  }
  function setLikeSel(l, val) {
    l._sel = val;
    if (val === l._match) state.lOver.delete(l.id); else state.lOver.set(l.id, val);
    updateLikeSummary(); updateExport();
  }
  function renderLikes() {
    updateLikeSummary();
    const list = visibleLikes();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.lPage >= pages) state.lPage = pages - 1;
    const body = $('#lk-body');
    body.textContent = '';
    const slice = list.slice(state.lPage * PAGE_SIZE, (state.lPage + 1) * PAGE_SIZE);
    const frag = document.createDocumentFragment();
    for (const l of slice) {
      const tr = document.createElement('tr');
      tr.className = l._sel ? '' : 'off';
      const c0 = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = l._sel; cb.setAttribute('aria-label', '취소 대상으로 선택');
      cb.addEventListener('change', () => { setLikeSel(l, cb.checked); tr.className = cb.checked ? '' : 'off'; });
      c0.appendChild(cb);
      const c1 = document.createElement('td'); c1.className = 'text';
      c1.textContent = l.text ? l.text.replace(/\s+/g, ' ') : '(내용 없음)';
      c1.title = l.text;
      const c2 = document.createElement('td');
      const a = document.createElement('a');
      a.href = X.statusUrl(l.id); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '열기';
      c2.appendChild(a);
      tr.append(c0, c1, c2);
      frag.appendChild(tr);
    }
    body.appendChild(frag);
    const empty = $('#lk-empty');
    if (!state.likes.length) { empty.hidden = false; empty.textContent = '좋아요 데이터가 없습니다. like.js 를 불러와 주세요.'; }
    else if (!list.length) { empty.hidden = false; empty.textContent = '조건에 해당하는 항목이 없습니다.'; }
    else empty.hidden = true;
    $('#lk-page').textContent = list.length ? (state.lPage + 1) + ' / ' + pages + ' 쪽 · ' + fmt(list.length) + '개' : '';
    $('#lk-prev').disabled = state.lPage <= 0;
    $('#lk-next').disabled = state.lPage >= pages - 1;
    $('#lk-all').checked = slice.length > 0 && slice.every((l) => l._sel);
  }
  const onLikeFilter = debounce(() => { state.lPage = 0; recomputeLikes(); renderLikes(); updateExport(); }, 200);
  ['#l-include', '#l-exclude'].forEach((s) => $(s).addEventListener('input', onLikeFilter));
  document.querySelectorAll('input[name="lk-view"]').forEach((r) => r.addEventListener('change', () => {
    state.lView = r.value; state.lPage = 0; renderLikes();
  }));
  $('#lk-prev').addEventListener('click', () => { state.lPage--; renderLikes(); });
  $('#lk-next').addEventListener('click', () => { state.lPage++; renderLikes(); });
  $('#lk-all').addEventListener('change', (e) => {
    const list = visibleLikes().slice(state.lPage * PAGE_SIZE, (state.lPage + 1) * PAGE_SIZE);
    for (const l of list) {
      l._sel = e.target.checked;
      if (l._sel === l._match) state.lOver.delete(l.id); else state.lOver.set(l.id, l._sel);
    }
    renderLikes(); updateExport();
  });
  $('#lk-reset-over').addEventListener('click', () => { state.lOver.clear(); recomputeLikes(); renderLikes(); updateExport(); });

  /* ----------------------------------------------------- 3. 백업 · 작업 파일 */

  const selectedTweets = () => state.tweets.filter((t) => t._sel);
  const selectedLikes = () => state.likes.filter((l) => l._sel);

  function updateExport() {
    const nt = selectedTweets().length;
    const nl = selectedLikes().length;
    const bm = $('#bm-all').checked;
    const parts = ['게시물·답글 ' + fmt(nt) + '개', '좋아요 ' + fmt(nl) + '개', '북마크 ' + (bm ? '전체 삭제' : '그대로 둠')];
    const sum = $('#export-summary');
    sum.textContent = parts.join(' · ');
    const items = nt + nl;
    const note = $('#export-note');
    if (items > 0) {
      const minutes = Math.max(1, Math.round((items * 0.75) / 60));
      note.textContent = '보통 속도 기준으로 대략 ' + fmt(minutes) + '분 걸립니다. 요청 한도에 걸리면 자동으로 기다리므로 더 길어질 수 있습니다.';
    } else {
      note.textContent = bm ? '' : '정리할 항목을 2단계에서 선택해 주세요.';
    }
    const hasBackup = items > 0;
    $('#btn-backup-json').disabled = !hasBackup;
    $('#btn-backup-csv').disabled = !hasBackup;
    $('#btn-job').disabled = !((items > 0 || bm) && $('#ack').checked);
  }

  $('#bm-all').addEventListener('change', updateExport);
  $('#ack').addEventListener('change', updateExport);

  $('#btn-backup-json').addEventListener('click', () => {
    const data = X.buildBackup(selectedTweets(), selectedLikes());
    download('x-backup-' + stamp() + '.json', 'application/json', JSON.stringify(data, null, 2));
    toast('백업 파일을 저장했습니다.');
  });
  $('#btn-backup-csv').addEventListener('click', () => {
    const csv = X.buildCsv(selectedTweets(), selectedLikes());
    download('x-backup-' + stamp() + '.csv', 'text/csv;charset=utf-8', '﻿' + csv);
    toast('백업 파일을 저장했습니다.');
  });
  $('#btn-job').addEventListener('click', () => {
    const job = X.buildJob({ tweets: selectedTweets(), likes: selectedLikes(), bookmarksAll: $('#bm-all').checked });
    download('xclean-job-' + stamp() + '.json', 'application/json', JSON.stringify(job));
    toast('작업 파일을 저장했습니다. 4단계로 진행해 주세요.');
  });

  /* ---------------------------------------------------------- 4. 실행기 */

  let runnerSrc = null;
  async function getRunner() {
    if (runnerSrc) return runnerSrc;
    const r = await fetch('runner.js', { cache: 'no-cache' });
    if (!r.ok) throw new Error('runner.js 를 불러오지 못했습니다 (' + r.status + ').');
    runnerSrc = await r.text();
    return runnerSrc;
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 아래 대체 방식 */ }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  $('#btn-copy-runner').addEventListener('click', async () => {
    try {
      const src = await getRunner();
      const ok = await copyText(src);
      if (ok) toast('실행기를 복사했습니다. x.com 탭의 콘솔에 붙여 넣어 주세요.');
      else toast('복사하지 못했습니다. 아래 \'코드 직접 확인하기\'에서 전체 선택 후 복사해 주세요.', true);
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#runner-details').addEventListener('toggle', async (e) => {
    if (!e.target.open || $('#runner-src').textContent) return;
    try { $('#runner-src').textContent = await getRunner(); } catch (err) { $('#runner-src').textContent = err.message; }
  });

  /* ------------------------------------------------------------------ 시작 */

  selectTab('tweets');
  renderTweets();
  renderLikes();
  updateExport();
})();
