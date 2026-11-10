'use strict';
// 실행: node tests/e2e-runner.cjs
// 모의 x.com(https://x.com 요청을 Playwright 가 가로채 응답)에서 runner.js 를 실제로 실행해 동작을 검증합니다.
// 실제 X 서버와는 통신하지 않습니다.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const runnerSrc = fs.readFileSync(path.resolve(__dirname, '..', 'runner.js'), 'utf8');
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAMOCKTOKENMOCKTOKENMOCKTOKENMOCKTOKEN';
const QID = { DeleteTweet: 'QID_DEL_1234567', UnfavoriteTweet: 'QID_UNLIKE_12345', BookmarksAllDelete: 'QID_BMALL_123456', Bookmarks: 'BMQID_LIST_0001' };

const srv = {};
function resetSrv() {
  Object.assign(srv, {
    bundleDel: QID.DeleteTweet, csrf: 'csrf123',
    gone: new Set(), fail: new Set(), rate: new Set(), rateDone: new Set(), calls: [],
  });
}
resetSrv();

const bundle = () => `!function(){var a={queryId:"${srv.bundleDel}",operationName:"DeleteTweet",operationType:"mutation",metadata:{}};`
  + `var b={queryId:"${QID.UnfavoriteTweet}",operationName:"UnfavoriteTweet",operationType:"mutation"};`
  + `var c={queryId:"${QID.BookmarksAllDelete}",operationName:"BookmarksAllDelete",operationType:"mutation"};var t="${TOKEN}";}();`;

const homeHtml = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><script src="/static/main.abc.js"></script></head><body><main>mock x</main></body></html>';
const bookmarksHtml = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><script src="/static/main.abc.js"></script></head><body>'
  + '<article><a href="/alice/status/5001"><time datetime="2024-01-02T03:04:05.000Z">1월 2일</time></a><div data-testid="tweetText">북마크 글 5001</div></article>'
  + '<article><a href="/alice/status/5002"><time datetime="2024-01-03T03:04:05.000Z">1월 3일</time></a><div data-testid="tweetText">북마크 글 5002</div></article>'
  + '</body></html>';

const json = (route, status, body, headers) => route.fulfill({ status, contentType: 'application/json', headers: headers || {}, body: JSON.stringify(body) });

const bookmarksListJson = {
  data: { bookmark_timeline_v2: { timeline: { instructions: [{ entries: [
    { content: { itemContent: { tweet_results: { result: { rest_id: '5002', core: { user_results: { result: { core: { screen_name: 'alice' } } } }, legacy: { full_text: '북마크 글 5002', created_at: 'Wed Jan 03 03:04:05 +0000 2024' } } } } } },
    { content: { itemContent: { tweet_results: { result: { __typename: 'TweetWithVisibilityResults', tweet: {
      rest_id: '5003', core: { user_results: { result: { legacy: { screen_name: 'carol' } } } },
      legacy: { full_text: '북마크 글 5003', created_at: 'Thu Jan 04 03:04:05 +0000 2024' },
      quoted_status_result: { result: { rest_id: '5999', legacy: { full_text: '인용된 글(북마크 아님)' } } },
    } } } } } },
  ] }] } } },
};

async function handleGql(route, req, u) {
  const parts = u.pathname.split('/'); // ['', 'i', 'api', 'graphql', qid, op]
  const qid = parts[4]; const op = parts[5];
  const headers = req.headers();
  const body = req.postData() ? JSON.parse(req.postData()) : {};
  const id = body.variables && body.variables.tweet_id;
  srv.calls.push({ op, qid, id, headers, body });
  if (op === 'Bookmarks') return json(route, 200, bookmarksListJson);
  if (qid !== QID[op]) return json(route, 404, { errors: [{ code: 34, message: 'Sorry, that page does not exist' }] });
  if (headers['x-csrf-token'] !== srv.csrf || headers.authorization !== 'Bearer ' + TOKEN) {
    return json(route, 403, { errors: [{ code: 353, message: 'This request requires a matching csrf cookie and header.' }] });
  }
  if (op === 'DeleteTweet') {
    if (srv.rate.has(id) && !srv.rateDone.has(id)) {
      srv.rateDone.add(id);
      return json(route, 429, {}, { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 2) });
    }
    if (srv.gone.has(id)) return json(route, 200, { errors: [{ message: 'No status found with that ID.' }] });
    if (srv.fail.has(id)) return json(route, 500, { errors: [{ message: 'Internal error' }] });
    return json(route, 200, { data: { delete_tweet: { tweet_results: {} } } });
  }
  if (op === 'UnfavoriteTweet') return json(route, 200, { data: { unfavorite_tweet: 'Done' } });
  if (op === 'BookmarksAllDelete') return json(route, 200, { data: { bookmark_all_delete: 'Done' } });
  return json(route, 400, { errors: [{ message: 'unknown op' }] });
}

const results = [];
const ok = (name) => { results.push(name); console.log('  ✓', name); };

const panelText = (page) => page.evaluate(() => document.getElementById('xclean-runner-host').shadowRoot.textContent);
const waitPanel = (page, re, timeout) => page.waitForFunction((src) => {
  const h = document.getElementById('xclean-runner-host');
  return !!h && new RegExp(src).test(h.shadowRoot.textContent);
}, re.source, { timeout: timeout || 30000 });

async function openRunner(page, url) {
  await page.goto(url || 'https://x.com/home');
  await page.addScriptTag({ content: runnerSrc });
  await page.waitForSelector('#xclean-runner-host', { state: 'attached' });
}
async function upload(page, job) {
  await page.locator('#xclean-runner-host input[type=file]').setInputFiles({ name: 'job.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(job)) });
  await waitPanel(page, /작업 파일을 불러왔습니다/);
}
const btn = (page, name) => page.getByRole('button', { name, exact: true });
async function startConfirmed(page, speed) {
  await page.locator('#xclean-runner-host select').selectOption(speed || 'fast');
  await btn(page, '시작').click();
  await waitPanel(page, /되돌릴 수 없습니다/);
  await btn(page, '되돌릴 수 없음을 이해했습니다. 시작').click();
}
const mkJob = (id, tweets, likes, bookmarksAll) => ({ format: 'xclean-job', version: 1, id, createdAt: new Date().toISOString(), tweets, likes: likes || [], bookmarksAll: !!bookmarksAll });
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
const delCalls = () => srv.calls.filter((c) => c.op === 'DeleteTweet');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.addCookies([{ name: 'ct0', value: 'csrf123', url: 'https://x.com' }]);
  await ctx.route('https://x.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === '/static/main.abc.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle() });
    if (u.pathname.startsWith('/i/api/graphql/')) return handleGql(route, req, u);
    if (u.pathname === '/i/bookmarks') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: bookmarksHtml });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: homeHtml });
  });
  await ctx.route('https://example.com/**', (route) => {
    const isJs = new URL(route.request().url()).pathname.startsWith('/static/');
    return route.fulfill({ status: 200, contentType: isJs ? 'text/javascript' : 'text/html; charset=utf-8', body: isJs ? '/* empty */' : homeHtml });
  });

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  /* ---- 1. 기본 실행: 성공 / 이미 없음 / 실패 / 요청 한도 / 좋아요 / 북마크 전체 */
  resetSrv();
  srv.gone = new Set(['1002']); srv.fail = new Set(['1003']); srv.rate = new Set(['1004']);
  const job1 = mkJob('aaaaaaaaaaaa', range(1001, 1006), ['2001', '2002'], true);
  await openRunner(page);
  await waitPanel(page, /요청 정보 확인: 3\/3/);
  ok('번들에서 queryId 3개 + 인증 토큰 찾기');
  await upload(page, job1);
  await startConfirmed(page, 'fast');
  await waitPanel(page, /완료: 삭제\/취소 6개, 이미 없음 1개, 실패 1개/, 40000);

  const seq = srv.calls.map((c) => c.op + ':' + (c.id || ''));
  assert.deepEqual(seq, [
    'DeleteTweet:1001', 'DeleteTweet:1002', 'DeleteTweet:1003', 'DeleteTweet:1004', 'DeleteTweet:1004', 'DeleteTweet:1005', 'DeleteTweet:1006',
    'UnfavoriteTweet:2001', 'UnfavoriteTweet:2002', 'BookmarksAllDelete:',
  ]);
  ok('요청 순서: 삭제 → 좋아요 취소 → 북마크 전체 삭제 (한도 걸린 건은 같은 항목 재시도)');

  const first = srv.calls[0];
  assert.equal(first.qid, QID.DeleteTweet);
  assert.equal(first.headers.authorization, 'Bearer ' + TOKEN);
  assert.equal(first.headers['x-csrf-token'], 'csrf123');
  assert.match(first.headers['content-type'], /application\/json/);
  assert.equal(first.body.queryId, QID.DeleteTweet);
  assert.equal(first.body.variables.dark_request, false);
  assert.equal(srv.calls[7].qid, QID.UnfavoriteTweet);
  assert.deepEqual(srv.calls[9].body.variables, {});
  ok('요청 헤더·본문 형식(인증 토큰, csrf, queryId, 변수)');

  const text1 = await panelText(page);
  assert.match(text1, /9 \/ 9 \(100%\)/);
  assert.match(text1, /실패 1003: Internal error/);
  assert.match(text1, /북마크를 모두 삭제했습니다/);
  assert.match(text1, /요청 한도에 도달했습니다/);
  ok('진행률 100%, 실패 사유와 한도 대기 기록');

  const [dl] = await Promise.all([page.waitForEvent('download'), btn(page, '실패 목록 저장').click()]);
  const failed = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  assert.deepEqual(failed.map((f) => f.id), ['1003']);
  assert.equal(failed[0].status, 500);
  ok('실패 목록 파일 저장');

  /* ---- 2. 이미 완료된 작업을 다시 열면 이어받기만 하고 재실행하지 않음 */
  const before = srv.calls.length;
  await openRunner(page);
  await upload(page, job1);
  assert.match(await panelText(page), /이전 진행 기록을 이어받았습니다/);
  await btn(page, '시작').click();
  await waitPanel(page, /이미 완료된 작업입니다/);
  assert.equal(srv.calls.length, before);
  await btn(page, '진행 기록 지우기').click();
  await waitPanel(page, /진행 기록을 지웠습니다/);
  ok('완료된 작업 재선택 시 재실행하지 않음, 진행 기록 지우기');

  /* ---- 3. 중지 후 새로고침해도 이어서 진행 (중복 없이, 누락 없이) */
  resetSrv();
  const job2 = mkJob('bbbbbbbbbbbb', range(3001, 3010));
  await openRunner(page);
  await upload(page, job2);
  await startConfirmed(page, 'fast');
  const t0 = Date.now();
  while (delCalls().length < 3 && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 30));
  await btn(page, '중지').click();
  await waitPanel(page, /중지했습니다/);
  const doneAtStop = delCalls().length;
  assert.ok(doneAtStop >= 3 && doneAtStop < 10, '중간에 멈춰야 합니다: ' + doneAtStop);
  await openRunner(page); // 새로고침과 같음
  await upload(page, job2);
  assert.match(await panelText(page), /이전 진행 기록을 이어받았습니다/);
  await startConfirmed(page, 'fast');
  await waitPanel(page, /완료: 삭제\/취소 10개/);
  const ids = delCalls().map((c) => c.id).sort();
  assert.deepEqual(ids, range(3001, 3010), '모든 항목이 정확히 한 번씩');
  ok('중지 → 새로고침 → 이어하기 (중복·누락 없음, 중지 시점 ' + doneAtStop + '개)');

  /* ---- 4. 번들의 queryId 가 낡은 경우: 연속 실패로 일시정지 → X 화면 요청을 학습 → 재개 */
  resetSrv();
  srv.bundleDel = 'OLD_QID_00000';
  const job3 = mkJob('cccccccccccc', range(4001, 4012));
  await openRunner(page);
  await upload(page, job3);
  await startConfirmed(page, 'fast');
  await waitPanel(page, /연속 8회 실패했습니다/);
  assert.equal(delCalls().length, 8);
  assert.ok(delCalls().every((c) => c.qid === 'OLD_QID_00000'));
  let t = await panelText(page);
  assert.match(t, /0 \/ 12 \(0%\)/);
  assert.match(t, /실패 0/);
  ok('낡은 queryId → 404 가 성공으로 처리되지 않고 8회 연속 실패 시 일시정지(진행·실패 수 되돌림)');

  await page.evaluate((o) => fetch('/i/api/graphql/' + o.qid + '/DeleteTweet', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + o.token, 'x-csrf-token': 'csrf123', 'content-type': 'application/json', 'x-client-transaction-id': 'tx-1' },
    body: JSON.stringify({ variables: { tweet_id: '9999', dark_request: false }, queryId: o.qid }),
  }).then((r) => r.status), { qid: QID.DeleteTweet, token: TOKEN });
  await waitPanel(page, /요청 형식을 학습했습니다: DeleteTweet/);
  await btn(page, '재개').click();
  await waitPanel(page, /완료: 삭제\/취소 12개, 이미 없음 0개, 실패 0개/);
  const good = delCalls().filter((c) => c.qid === QID.DeleteTweet && c.id !== '9999').map((c) => c.id).sort();
  assert.deepEqual(good, range(4001, 4012));
  ok('X 화면의 실제 요청을 학습한 뒤 재개 → 12개 모두 성공');

  /* ---- 5. 연속으로 "이미 없음"이 많으면 일시정지 */
  resetSrv();
  const job4 = mkJob('dddddddddddd', range(5101, 5130));
  srv.gone = new Set(job4.tweets);
  await openRunner(page);
  await upload(page, job4);
  await startConfirmed(page, 'fast');
  await waitPanel(page, /연속 25개가 '이미 없음'으로 응답/);
  assert.equal(delCalls().length, 25);
  await btn(page, '재개').click();
  await waitPanel(page, /완료: 삭제\/취소 0개, 이미 없음 30개, 실패 0개/);
  ok("'이미 없음' 25개 연속 시 확인 요청 후 일시정지");

  /* ---- 6. 인증 쿠키가 없으면 요청 없이 중단 */
  resetSrv();
  await ctx.clearCookies();
  await openRunner(page);
  await upload(page, mkJob('eeeeeeeeeeee', ['6001']));
  await startConfirmed(page, 'fast');
  await waitPanel(page, /로그인 정보\(ct0 쿠키\)를 찾지 못했습니다/);
  assert.equal(delCalls().length, 0);
  ok('ct0 쿠키 없음 → 삭제 요청을 보내지 않고 중단');
  await ctx.addCookies([{ name: 'ct0', value: 'csrf123', url: 'https://x.com' }]);

  /* ---- 7. 인증 오류(403)는 항목을 넘기지 않고 일시정지 */
  resetSrv();
  srv.csrf = 'different';
  const job5 = mkJob('ffffffffffff', ['7001', '7002']);
  await openRunner(page);
  await upload(page, job5);
  await startConfirmed(page, 'fast');
  await waitPanel(page, /인증 오류\(403\)/);
  let t7 = await panelText(page);
  assert.match(t7, /0 \/ 2 \(0%\)/);
  srv.csrf = 'csrf123';
  await btn(page, '재개').click();
  await waitPanel(page, /완료: 삭제\/취소 2개/);
  // 첫 시도(403) 뒤 같은 7001 을 다시 시도하고 나서 7002 로 넘어가야 합니다.
  assert.deepEqual(delCalls().map((c) => c.id), ['7001', '7001', '7002']);
  ok('403 → 항목을 건너뛰지 않고 일시정지, 문제 해결 후 재개하면 같은 항목부터');

  /* ---- 8. x.com 이 아닌 사이트에서는 동작하지 않음 */
  await openRunner(page, 'https://example.com/');
  await waitPanel(page, /x\.com 또는 twitter\.com 탭에서만/);
  assert.equal(await btn(page, '시작').isDisabled(), true);
  assert.equal(await page.getByText('작업 파일(.json) 선택').isVisible(), false);
  ok('다른 사이트에서는 시작 불가');

  /* ---- 9. 북마크 백업 */
  resetSrv();
  await openRunner(page, 'https://x.com/home');
  await btn(page, '북마크 백업').click();
  await waitPanel(page, /북마크 페이지로 이동한 뒤 다시 눌러 주세요/);
  ok('북마크 페이지가 아니면 안내만 표시');

  await openRunner(page, 'https://x.com/i/bookmarks');
  await btn(page, '북마크 백업').click();
  await page.evaluate(() => fetch('/i/api/graphql/BMQID_LIST_0001/Bookmarks?variables=%7B%7D').then((r) => r.text()));
  const bmDl = await page.waitForEvent('download', { timeout: 40000 });
  const bm = JSON.parse(fs.readFileSync(await bmDl.path(), 'utf8'));
  assert.equal(bm.format, 'xclean-bookmarks');
  assert.deepEqual(bm.bookmarks.map((b) => b.id).sort(), ['5001', '5002', '5003']);
  const b5003 = bm.bookmarks.find((b) => b.id === '5003');
  assert.equal(b5003.user, 'carol');
  assert.equal(b5003.text, '북마크 글 5003');
  assert.equal(bm.bookmarks.find((b) => b.id === '5001').user, 'alice');
  assert.ok(!bm.bookmarks.some((b) => b.id === '5999'), '인용된 글은 북마크가 아닙니다');
  ok('북마크 백업: 화면(5001·5002) + 응답(5002·5003) 합침, 인용된 글(5999)은 제외');

  /* ---- 10. 닫기와 중복 실행 */
  await page.evaluate((s) => { (0, eval)(s); }, runnerSrc);
  await page.evaluate((s) => { (0, eval)(s); }, runnerSrc);
  assert.equal(await page.locator('#xclean-runner-host').count(), 1);
  await btn(page, '✕').click();
  assert.equal(await page.locator('#xclean-runner-host').count(), 0);
  assert.match(await page.evaluate(() => window.fetch.toString()), /\[native code\]/);
  assert.match(await page.evaluate(() => XMLHttpRequest.prototype.send.toString()), /\[native code\]/);
  ok('중복 붙여넣기는 하나만 유지, 닫으면 fetch/XHR 원상복구');

  assert.deepEqual(pageErrors, [], '페이지 오류: ' + pageErrors.join(' | '));
  ok('페이지 오류 0건');

  await browser.close();
  console.log('\n실행기 E2E 통과:', results.length, '항목');
})().catch((e) => { console.error('\n실패:', e); process.exit(1); });
