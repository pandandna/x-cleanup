'use strict';
// 실행: node tests/e2e-runner.cjs
// 모의 X 화면(tests/mock-x.js, https://x.com 요청을 Playwright 가 가로채 제공)에서 runner.js 를 실제로 실행해 검증합니다.
// 실제 X 서버와는 통신하지 않습니다.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const runnerSrc = fs.readFileSync(path.resolve(__dirname, '..', 'runner.js'), 'utf8');
const mockSrc = fs.readFileSync(path.resolve(__dirname, 'mock-x.js'), 'utf8');
const shell = '<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body>'
  + '<nav id="nav"></nav><main><div data-testid="primaryColumn" id="col"></div></main>'
  + '<script src="/static/mock-x.js"></script></body></html>';

const results = [];
const ok = (name) => { results.push(name); console.log('  ✓', name); };

const panelText = (page) => page.evaluate(() => document.getElementById('xclean-runner-host').shadowRoot.textContent);
const waitPanel = (page, re, timeout) => page.waitForFunction((src) => {
  const h = document.getElementById('xclean-runner-host');
  return !!h && new RegExp(src).test(h.shadowRoot.textContent);
}, re.source, { timeout: timeout || 60000 });

async function openX(page, setup, url) {
  await page.goto(url || 'https://x.com/home');
  await page.waitForFunction(() => !!window.DB);
  await page.evaluate(setup);
  await page.evaluate(() => window.__mockRender());
}
async function inject(page) {
  await page.evaluate(() => { window.__xcleanTimeScale = 0.01; });
  await page.addScriptTag({ content: runnerSrc });
  await page.waitForSelector('#xclean-runner-host', { state: 'attached' });
}
async function upload(page, job) {
  await page.locator('#xclean-runner-host input[type=file]').setInputFiles({ name: 'job.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(job)) });
  await waitPanel(page, /작업 파일을 불러왔습니다/);
}
const btn = (page, name) => page.getByRole('button', { name, exact: true });
async function startConfirmed(page, speed) {
  await page.locator('#xclean-runner-host select').nth(1).selectOption(speed || 'fast');
  await btn(page, '시작').click();
  await waitPanel(page, /되돌릴 수 없습니다/);
  await btn(page, '되돌릴 수 없음을 이해했습니다. 시작').click();
}
const mkJob = (id, tweets, likes, bookmarksAll) => ({ format: 'xclean-job', version: 1, id, createdAt: new Date().toISOString(), tweets, likes: likes || [], bookmarksAll: !!bookmarksAll });
const dbLog = (page) => page.evaluate(() => window.DB.log.slice());

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.route('https://x.com/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/static/mock-x.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: mockSrc });
    if (u.pathname.startsWith('/i/api/')) {
      if (u.searchParams.get('rl') === '1') {
        return route.fulfill({ status: 429, contentType: 'application/json', headers: { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900) }, body: '{"errors":[{"code":88,"message":"Rate limit exceeded"}]}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: shell });
  });
  await ctx.route('https://example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p>other site</p>' }));

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  /* ---- 1. 전체 흐름 */
  await openX(page, () => {
    const T = (id, author, extra) => { window.DB.tweets[id] = Object.assign({ id, author }, extra || {}); };
    T('101', 'me'); T('102', 'me'); T('103', 'me');
    T('301', 'carol', { rtByMe: true }); T('300', 'me', { retweetOf: '301' }); // 300 = 내 재게시 기록, 실제로는 301 이 보임
    T('400', 'dave');                                 // 내 글 아님, 재게시도 안 함
    T('501', 'erin', { liked: true }); T('502', 'erin', { liked: false });
    T('601', 'alice'); T('602', 'alice'); T('603', 'alice');
    window.DB.bookmarks = ['601', '602', '603'];
    window.DB.transientOnce = new Set(['103']);
  });
  await inject(page);
  await waitPanel(page, /실행기 v3 준비됨/);
  ok('실행기 v3 패널 표시');
  await upload(page, mkJob('aaaaaaaaaaaa', ['900', '101', '102', '300', '400', '103'], ['501', '502', '503'], true));
  await startConfirmed(page, 'fast');
  await waitPanel(page, /완료: 삭제\/취소 8개, 이미 없음 4개, 실패 0개/, 90000);
  const log1 = await dbLog(page);
  assert.deepEqual(log1, ['delete:101', 'delete:102', 'unretweet:301', 'transient:103', 'delete:103', 'unlike:501', 'unbookmark:601', 'unbookmark:602', 'unbookmark:603']);
  ok('삭제 → 재게시 취소 → (일시 오류 후 재시도) → 좋아요 취소 → 북마크 해제 순서와 결과');
  ok('없는 게시물(900, 503)·남의 글(400)·이미 취소된 좋아요(502)는 \'이미 없음\' 처리, 답글의 좋아요는 건드리지 않음');
  assert.equal(await page.evaluate(() => window.DB.tweets['1017'] === undefined), true);
  assert.ok(!log1.some((x) => /unlike:\d+7$/.test(x)));

  /* ---- 2. 이전 화면(오류)이 남아 있는 동안 다음 항목을 '이미 없음'으로 오판하지 않음 */
  await openX(page, () => {
    window.DB.tweets['104'] = { id: '104', author: 'me' };
    window.DB.keepStale = true; window.DB.routeDelay = 1200;
  });
  await inject(page);
  await upload(page, mkJob('bbbbbbbbbbbb', ['901', '104'], [], false));
  await startConfirmed(page, 'fast');
  await waitPanel(page, /완료: 삭제\/취소 1개, 이미 없음 1개, 실패 0개/, 60000);
  assert.deepEqual(await dbLog(page), ['delete:104']);
  ok('이동 직후 남아 있는 이전 오류 화면 때문에 오판하지 않음');

  /* ---- 3. 연속 실패 시 일시정지 + 되돌림, 원인 해결 후 재개 */
  await openX(page, () => {
    for (let i = 0; i < 6; i++) window.DB.tweets['11' + i] = { id: '11' + i, author: 'me' };
    window.DB.noDeleteMenu = true;
  });
  await inject(page);
  await upload(page, mkJob('cccccccccccc', ['110', '111', '112', '113', '114', '115'], [], false));
  await startConfirmed(page, 'fast');
  await waitPanel(page, /연속 5회 실패했습니다/, 90000);
  let txt = await panelText(page);
  assert.match(txt, /0 \/ 6 \(0%\).*실패 0/);
  ok('연속 5회 실패 → 일시정지, 실패 처리 되돌림 (0/6, 실패 0)');
  await page.evaluate(() => { window.DB.noDeleteMenu = false; });
  await btn(page, '재개').click();
  await waitPanel(page, /완료: 삭제\/취소 6개, 이미 없음 0개, 실패 0개/, 90000);
  assert.equal((await dbLog(page)).filter((x) => x.startsWith('delete:')).length, 6);
  ok('재개 후 같은 항목부터 다시 처리해 모두 완료');

  /* ---- 4. 중지 → 다시 붙여넣기 → 이어서 진행 (중복 처리 없음) */
  await openX(page, () => {
    for (let i = 0; i < 5; i++) window.DB.tweets['12' + i] = { id: '12' + i, author: 'me' };
    window.DB.routeDelay = 500;
  });
  await inject(page);
  const job4 = mkJob('dddddddddddd', ['120', '121', '122', '123', '124'], [], false);
  await upload(page, job4);
  await startConfirmed(page, 'safe');
  await page.waitForFunction(() => window.DB.log.length >= 2, null, { timeout: 60000 });
  await btn(page, '중지').click();
  await waitPanel(page, /중지했습니다/, 60000);
  const doneBefore = (await dbLog(page)).length;
  await page.evaluate(() => document.getElementById('xclean-runner-host').shadowRoot.querySelector('button[title^="닫기"]').click());
  await inject(page);
  await upload(page, job4);
  assert.match(await panelText(page), /이전 진행 기록을 이어받았습니다/);
  await startConfirmed(page, 'fast');
  await waitPanel(page, /완료: 삭제\/취소 \d+개, 이미 없음 \d+개, 실패 0개/, 60000);
  const log4 = await dbLog(page);
  assert.deepEqual(log4, ['delete:120', 'delete:121', 'delete:122', 'delete:123', 'delete:124']);
  assert.ok(doneBefore >= 2 && doneBefore < 5);
  ok('중지 후 다시 붙여넣어도 진행 기록을 이어받아 중복 없이 완료');

  /* ---- 4-1. 시험 실행: 아무것도 지우지 않음, 이후 실제 실행은 처음부터 */
  await openX(page, () => {
    window.DB.tweets['140'] = { id: '140', author: 'me' };
    window.DB.tweets['501'] = { id: '501', author: 'erin', liked: true };
    window.DB.tweets['801'] = { id: '801', author: 'alice' }; window.DB.tweets['802'] = { id: '802', author: 'alice' };
    window.DB.bookmarks = ['801', '802'];
  });
  await inject(page);
  const job41 = mkJob('ffffffffffff', ['140', '900'], ['501'], true);
  await upload(page, job41);
  await page.locator('#xclean-runner-host input[type=checkbox]').last().check();
  await btn(page, '시험 실행').click();
  await waitPanel(page, /시험 실행 완료: 처리 가능 4개, 이미 없음 1개, 실패 0개 \(실제로 지운 것은 없습니다\)/, 60000);
  assert.deepEqual(await dbLog(page), []);
  assert.equal(await page.evaluate(() => !window.DB.tweets['140'].deleted && window.DB.tweets['501'].liked && window.DB.bookmarks.length === 2 && !document.getElementById('dlg')), true);
  assert.match(await panelText(page), /0 \/ 4 \(0%\)  ·  삭제\/취소 0/);
  ok('시험 실행: 확인 창까지 열고 취소, 실제 변경 0건, 진행 기록 0으로 유지');
  await page.locator('#xclean-runner-host input[type=checkbox]').last().uncheck();
  await startConfirmed(page, 'fast');
  await waitPanel(page, /완료: 삭제\/취소 4개, 이미 없음 1개, 실패 0개/, 60000);
  assert.deepEqual(await dbLog(page), ['delete:140', 'unlike:501', 'unbookmark:801', 'unbookmark:802']);
  ok('시험 실행 뒤 실제 실행은 처음부터 정상 처리');


  /* ---- D. 바로 정리 (작업 파일 없이) */
  const setupDirect = () => {
    const T = (id, author, extra) => { window.DB.tweets[id] = Object.assign({ id, author }, extra || {}); };
    T('3001', 'me', { date: '2024-03-01' }); T('3002', 'me', { date: '2023-06-01' }); T('3003', 'me', { date: '2022-01-01' });
    T('3101', 'bob', { date: '2022-12-31' }); T('3004', 'me', { date: '2023-01-01', replyTo: '3101' });
    T('3102', 'carol', { date: '2022-05-01', rtByMe: true, quote: '3001' }); // 내 글을 인용한 남의 글을 내가 재게시
    T('3201', 'erin', { date: '2023-01-01', liked: true }); T('3202', 'erin', { date: '2025-01-01', liked: true });
    for (let i = 10; i < 20; i++) T('34' + i, 'fran', { date: '2021-0' + ((i % 9) + 1) + '-01', liked: true });
    T('3501', 'alice'); T('3502', 'alice'); window.DB.bookmarks = ['3501', '3502'];
    T('3005', 'me', { date: '2022-02-01', rtByMe: true }); // 내 글을 내가 재게시 → 게시물 탭에서 삭제됨(원글 삭제 시 재게시도 사라짐)
    T('3103', 'gina', { date: '2021-01-01', rtByMe: true }); T('3104', 'hank', { date: '2021-01-02', rtByMe: true });
  };
  const setDirect = async (o) => {
    const cb = (txt) => page.locator('#xclean-runner-host label', { hasText: txt }).first().locator('input');
    const map = [['posts', '내 게시물 삭제'], ['replies', '내 답글 삭제'], ['reposts', '재게시 취소'], ['likes', '좋아요 취소 (마음에'], ['bms', '북마크 전체 해제']];
    for (const [k, txt] of map) await cb(txt)[o[k] ? 'check' : 'uncheck']();
    await page.locator('#xclean-runner-host input[type=date]').fill(o.before || '');
  };
  const ALL = { posts: true, replies: true, reposts: true, likes: true };

  // D1. 전체
  await openX(page, setupDirect, 'https://x.com/home');
  await inject(page);
  assert.equal(await page.locator('#xclean-runner-host select').first().inputValue(), 'direct');
  await setDirect(Object.assign({}, ALL, { bms: true }));
  await startConfirmed(page, 'fast');
  await waitPanel(page, /바로 정리 완료: 삭제\/취소 22개, 실패 0개/, 120000);
  const logD1 = await dbLog(page);
  assert.deepEqual(logD1.filter((x) => x.startsWith('delete:')).sort(), ['delete:3001', 'delete:3002', 'delete:3003', 'delete:3004', 'delete:3005']);
  assert.deepEqual(logD1.filter((x) => x.startsWith('unretweet:')), ['unretweet:3102', 'unretweet:3104', 'unretweet:3103']);
  assert.ok(logD1.indexOf('unretweet:3102') > logD1.indexOf('delete:3004'));
  assert.equal(logD1.filter((x) => x.startsWith('unlike:')).length, 12);
  assert.deepEqual(logD1.filter((x) => x.startsWith('unbookmark:')).sort(), ['unbookmark:3501', 'unbookmark:3502']);
  assert.ok(!logD1.includes('delete:3101') && !logD1.includes('delete:3102'));
  ok('바로 정리: 프로필 게시물·답글 삭제, 재게시 탭(/reposts)에서 재게시 취소, 좋아요 12개(스크롤로 추가 로딩) 취소, 북마크 해제');
  ok('답글 화면의 남의 글, 내 글을 인용한 남의 글은 삭제하지 않음');


  // D4. 게시물 / 답글 / 재게시를 각각 따로
  const setupKinds = () => {
    const T = (id, author, extra) => { window.DB.tweets[id] = Object.assign({ id, author }, extra || {}); };
    T('4001', 'me', { date: '2023-01-06' }); T('4002', 'me', { date: '2023-01-05' });
    T('4101', 'bob', { date: '2023-01-04' }); T('4003', 'me', { date: '2023-01-04', replyTo: '4101' }); // 스레드형 답글(선)
    T('4004', 'me', { date: '2023-01-03', replyLabel: 'carl' });                                     // '님에게 보내는 답글' 표시
    T('4005', 'me', { date: '2023-01-05', replyTo: '4002' });                                        // 내 글에 이어 쓴 답글
    T('4102', 'dina', { date: '2023-01-02', rtByMe: true });
    T('4006', 'me', { date: '2020-01-01', hideOnPosts: true }); // 실제 X처럼 '게시물' 탭에 안 나오고 '답글' 탭에만 나오는 오래된 게시물
  };
  const kinds = async (opt) => {
    await openX(page, setupKinds);
    await inject(page);
    await setDirect(opt);
    await startConfirmed(page, 'fast');
    await waitPanel(page, /바로 정리 완료: 삭제\/취소 \d+개, 실패 0개/, 120000);
    const l = await dbLog(page);
    return { del: l.filter((x) => x.startsWith('delete:')).map((x) => x.slice(7)).sort(), rt: l.filter((x) => x.startsWith('unretweet:')).map((x) => x.slice(10)) };
  };
  let k = await kinds({ replies: true });
  assert.deepEqual(k, { del: ['4003', '4004', '4005'], rt: [] });
  ok('답글만 체크: 스레드형 답글·표시형 답글·내 글에 이어 쓴 답글만 삭제, 게시물·재게시는 그대로');
  k = await kinds({ posts: true });
  assert.deepEqual(k, { del: ['4001', '4002', '4006'], rt: [] });
  ok('게시물만 체크: 게시물만 삭제(게시물 탭에 안 나오는 오래된 게시물은 답글 탭에서 찾아 삭제), 답글·재게시는 그대로');
  k = await kinds({ reposts: true });
  assert.deepEqual(k, { del: [], rt: ['4102'] });
  ok('재게시만 체크: 재게시만 취소, 게시물·답글은 그대로');

  // D2. 날짜 기준
  await openX(page, setupDirect, 'https://x.com/home');
  await inject(page);
  await setDirect(Object.assign({}, ALL, { before: '2023-07-01' }));
  await startConfirmed(page, 'fast');
  await waitPanel(page, /바로 정리 완료: 삭제\/취소 \d+개, 실패 0개/, 120000);
  const logD2 = await dbLog(page);
  assert.deepEqual(logD2.filter((x) => x.startsWith('delete:')).sort(), ['delete:3002', 'delete:3003', 'delete:3004', 'delete:3005']);
  assert.deepEqual(logD2.filter((x) => x.startsWith('unretweet:')), ['unretweet:3102', 'unretweet:3104', 'unretweet:3103']);
  assert.ok(logD2.includes('unlike:3201') && !logD2.includes('unlike:3202'));
  assert.equal(logD2.filter((x) => x.startsWith('unlike:')).length, 11);
  assert.ok(!logD2.some((x) => x.startsWith('unbookmark:')));
  ok('바로 정리 날짜 기준: 2023-07-01 이전 것만 처리, 이후 것과 북마크는 그대로');

  // D3. 시험 실행
  await openX(page, setupDirect, 'https://x.com/home');
  await inject(page);
  await setDirect(Object.assign({}, ALL, { bms: true }));
  await page.locator('#xclean-runner-host input[type=checkbox]').last().check();
  await btn(page, '시험 실행').click();
  await waitPanel(page, /시험 실행 완료: 처리 가능 \d+개, 실패 0개 \(실제로 지운 것은 없습니다\)/, 120000);
  assert.deepEqual(await dbLog(page), []);
  assert.equal(await page.evaluate(() => !document.getElementById('dlg') && Object.values(window.DB.tweets).every((t) => !t.deleted) && window.DB.bookmarks.length === 2), true);
  ok('바로 정리 시험 실행: 실제 변경 0건');


  /* ---- R. 요청 한도(429) → 알림 + 해제 예정 시각까지 대기 → 자동 재개 */
  const alertShown = () => page.evaluate(() => getComputedStyle(document.getElementById('xclean-runner-host').shadowRoot.querySelector('[role=alert]')).display);
  // R1. 작업 파일 방식 (모의 응답의 해제 시각 = 900초 뒤, 테스트 배율 0.01 → 약 9초 대기)
  await openX(page, () => {
    window.DB.tweets['160'] = { id: '160', author: 'me' }; window.DB.tweets['161'] = { id: '161', author: 'me' };
    window.DB.rlOnce = new Set(['160']);
  });
  await inject(page);
  await upload(page, mkJob('a1a1a1a1a1a1', ['160', '161'], [], false));
  await startConfirmed(page, 'fast');
  await waitPanel(page, /요청 한도 초과\(429\) — .*자동 재개 예정/, 60000);
  let txt429 = await panelText(page);
  assert.match(txt429, /429 Too Many Requests/);
  assert.match(txt429, /한도가 풀리는 예정 시각\(.*\)에 자동으로 이어서 진행합니다/);
  assert.match(txt429, /남은 시간: \d+초/);
  assert.match(txt429, /0 \/ 2 \(0%\).*실패 0/);
  assert.equal(await alertShown(), 'block');
  assert.equal(await page.evaluate(() => [...document.getElementById('xclean-runner-host').shadowRoot.querySelectorAll('button')].find((b) => b.textContent === '일시정지') !== undefined), true);
  await page.waitForTimeout(3000);
  assert.deepEqual(await dbLog(page), ['429:160']);
  ok('429 발생 시 알림과 남은 시간 표시, 대기 중에는 진행하지 않고 일시정지 상태도 아님');
  await waitPanel(page, /완료: 삭제\/취소 2개, 이미 없음 0개, 실패 0개/, 60000);
  assert.deepEqual(await dbLog(page), ['429:160', 'delete:160', 'delete:161']);
  assert.match(await panelText(page), /대기가 끝나 자동으로 이어서 진행합니다/);
  assert.equal(await alertShown(), 'none');
  ok('해제 예정 시각이 지나면 버튼을 누르지 않아도 자동 재개, 같은 항목부터 처리해 완료');

  // R2. 바로 정리 방식 + '지금 다시 시도'로 대기 건너뛰기
  await openX(page, () => {
    window.DB.tweets['3601'] = { id: '3601', author: 'me', date: '2023-01-02' };
    window.DB.tweets['3602'] = { id: '3602', author: 'me', date: '2023-01-01' };
    window.DB.rlOnce = new Set(['3601']);
  });
  await inject(page);
  await setDirect({ posts: true });
  await startConfirmed(page, 'fast');
  await waitPanel(page, /요청 한도 초과\(429\) — .*자동 재개 예정/, 60000);
  assert.deepEqual(await dbLog(page), ['429:3601']);
  await btn(page, '기다리지 않고 지금 다시 시도').click();
  await waitPanel(page, /대기를 건너뛰고 다시 시도합니다/, 10000);
  await waitPanel(page, /바로 정리 완료: 삭제\/취소 2개, 실패 0개/, 120000);
  assert.deepEqual((await dbLog(page)).filter((x) => x.startsWith('delete:')).sort(), ['delete:3601', 'delete:3602']);
  ok('바로 정리에서도 429 시 대기 후 이어서 진행, 대기 건너뛰기 버튼 동작');

  // R3. 대기 중 중지
  await openX(page, () => { window.DB.tweets['170'] = { id: '170', author: 'me' }; window.DB.rlOnce = new Set(['170']); });
  await inject(page);
  await upload(page, mkJob('a2a2a2a2a2a2', ['170'], [], false));
  await startConfirmed(page, 'fast');
  await waitPanel(page, /자동 재개 예정/, 60000);
  await btn(page, '중지').click();
  await waitPanel(page, /중지했습니다/, 10000);
  assert.equal(await alertShown(), 'none');
  assert.deepEqual(await dbLog(page), ['429:170']);
  ok('대기 중 중지하면 즉시 멈추고 알림도 사라짐');

  /* ---- 5. 북마크 백업 */
  await openX(page, () => {
    window.DB.tweets['701'] = { id: '701', author: 'alice', text: '북마크 글 701' };
    window.DB.tweets['702'] = { id: '702', author: 'bob', text: '북마크 글 702' };
    window.DB.bookmarks = ['701', '702'];
  });
  await inject(page);
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await btn(page, '북마크 백업').click();
  const d = await dl;
  const bk = JSON.parse(fs.readFileSync(await d.path(), 'utf8'));
  assert.equal(bk.format, 'xclean-bookmarks');
  assert.deepEqual(bk.bookmarks.map((b) => b.id).sort(), ['701', '702']);
  assert.equal(bk.bookmarks.find((b) => b.id === '701').text, '북마크 글 701');
  assert.equal(await page.evaluate(() => location.pathname), '/i/history');
  assert.deepEqual(await page.evaluate(() => window.DB.bookmarks), ['701', '702']);
  ok('북마크 백업: 북마크 화면으로 자동 이동해 2개 저장, 북마크는 그대로 유지');

  /* ---- 6. 로그인 안 된 화면 */
  await openX(page, () => { window.DB.loggedIn = false; });
  await inject(page);
  await upload(page, mkJob('eeeeeeeeeeee', ['130'], [], false));
  await startConfirmed(page, 'fast');
  await waitPanel(page, /중단: 로그인 필요/);
  ok('로그인 안 된 화면에서는 시작하지 않음');

  /* ---- 7. x.com 이 아닌 사이트 */
  await page.goto('https://example.com/');
  await inject(page);
  txt = await panelText(page);
  assert.match(txt, /x\.com 또는 twitter\.com 탭에서만/);
  assert.equal(await page.evaluate(() => [...document.getElementById('xclean-runner-host').shadowRoot.querySelectorAll('label')].find((l) => /작업 파일\(\.json\) 선택/.test(l.textContent)).style.display), 'none');
  assert.equal(await page.evaluate(() => [...document.getElementById('xclean-runner-host').shadowRoot.querySelectorAll('button')].find((b) => b.textContent === '시작').disabled), true);
  ok('x.com 이 아닌 탭에서는 작업 파일 선택 숨김, 시작 불가');

  /* ---- 8. 중복 붙여넣기 / 닫기 */
  await openX(page, () => {});
  await inject(page);
  await inject(page);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#xclean-runner-host').length), 1);
  await page.evaluate(() => window.__xcleanRunner.destroy());
  assert.equal(await page.evaluate(() => document.querySelectorAll('#xclean-runner-host').length), 0);
  ok('중복 붙여넣기는 하나만 유지, 닫으면 패널 제거');

  assert.deepEqual(pageErrors, []);
  ok('페이지 오류 0건');

  await browser.close();
  console.log('\n실행기 E2E 통과: ' + results.length + ' 항목');
})().catch((e) => { console.error(e); process.exit(1); });
