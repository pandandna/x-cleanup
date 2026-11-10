'use strict';
// 실행: node tests/e2e-site.cjs <픽스처 폴더> <스크린샷 폴더>
// 사이트를 실제 브라우저(Chromium)로 열어 아카이브 불러오기 → 필터 → 백업 → 작업 파일 → 실행기 복사까지 확인합니다.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const FX = path.resolve(process.argv[2]);
const SHOTS = path.resolve(process.argv[3] || FX);
fs.mkdirSync(SHOTS, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const results = [];
const ok = (name) => { results.push(name); console.log('  ✓', name); };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('request', (r) => requests.push(r.url()));

  await page.goto(origin + '/');
  assert.equal(await page.title(), 'X 계정 정리 도구');
  ok('페이지 로드');

  // ---- 1. 잘못된 파일
  await page.setInputFiles('#file-input', path.join(FX, 'not-archive.json'));
  await page.waitForSelector('#load-status li.err');
  assert.match(await page.textContent('#load-status li.err'), /not-archive\.json.*형식/);
  ok('잘못된 파일은 오류 메시지로 표시');

  // ---- 2. 정상 ZIP
  await page.setInputFiles('#file-input', path.join(FX, 'sample.zip'));
  await page.waitForFunction(() => /합계/.test(document.querySelector('#load-status').textContent));
  const status = await page.textContent('#load-status');
  assert.match(status, /data\/tweets\.js — 게시물 30개/);
  assert.match(status, /data\/like\.js — 좋아요 10개/);
  assert.match(status, /합계 — 게시물·답글 32개, 좋아요 10개/);
  assert.doesNotMatch(status, /deleted-tweets/);
  assert.equal((await page.textContent('#tw-summary')).trim(), '전체 32개 중 삭제할 항목 32개');
  assert.equal(await page.locator('#tw-body tr').count(), 32);
  ok('ZIP 불러오기: 게시물 32개(헤더 전용 2개 포함), 좋아요 10개');

  // 최신순 정렬 확인: 첫 행이 가장 최근
  const dates = await page.locator('#tw-body tr td.date').allTextContents();
  const known = dates.filter((d) => d !== '-');
  assert.deepEqual(known, [...known].sort().reverse());
  ok('최신순 정렬');

  // ---- 3. 필터
  await page.uncheck('#k-retweet');
  assert.match(await page.textContent('#tw-summary'), /삭제할 항목 26개/);
  await page.uncheck('#k-unknown');
  assert.match(await page.textContent('#tw-summary'), /삭제할 항목 24개/);
  ok('유형 필터(리트윗·불명 제외 → 24개)');

  await page.fill('#f-include', '비밀');
  await page.waitForFunction(() => /삭제할 항목 4개/.test(document.querySelector('#tw-summary').textContent));
  ok('포함 단어 "비밀" → 4개');

  await page.fill('#f-exclude', '내 게시물 14');
  await page.waitForFunction(() => /삭제할 항목 3개/.test(document.querySelector('#tw-summary').textContent));
  ok('제외 단어가 보존으로 우선 적용 → 3개');

  await page.fill('#f-include', '');
  await page.fill('#f-exclude', '');
  await page.click('#p-reset');
  assert.match(await page.textContent('#tw-summary'), /삭제할 항목 32개/);
  await page.click('#p-reply');
  assert.match(await page.textContent('#tw-summary'), /삭제할 항목 8개/);
  await page.click('#p-year');
  assert.match(await page.textContent('#tw-summary'), /삭제할 항목 32개/); // 모두 1년보다 오래된 게시물
  await page.click('#p-reset');
  ok('빠른 설정(전체·답글만·1년 이상 지난 것)');

  await page.fill('#f-keepfav', '40');
  // favorite_count = i*2 ≥ 40 → i=20..29 (10개) 보존 → 22개
  await page.waitForFunction(() => /삭제할 항목 22개/.test(document.querySelector('#tw-summary').textContent));
  await page.fill('#f-keepfav', '');
  await page.fill('#f-protect', 'https://x.com/me/status/1000000000000000007');
  await page.waitForFunction(() => /삭제할 항목 31개/.test(document.querySelector('#tw-summary').textContent));
  await page.fill('#f-protect', '');
  await page.waitForFunction(() => /삭제할 항목 32개/.test(document.querySelector('#tw-summary').textContent));
  ok('좋아요 N개 이상 보존 / 보존 목록');

  // ---- 4. 수동 조정
  await page.locator('#tw-body tr').first().locator('input[type=checkbox]').uncheck();
  let sum = await page.textContent('#tw-summary');
  assert.match(sum, /삭제할 항목 31개/);
  assert.match(sum, /직접 조정 1개/);
  await page.click('#tw-reset-over');
  assert.match(await page.textContent('#tw-summary'), /삭제할 항목 32개/);
  await page.check('input[name="tw-view"][value="keep"]');
  assert.equal(await page.locator('#tw-body tr').count(), 0);
  assert.match(await page.textContent('#tw-empty'), /해당하는 항목이 없습니다/);
  await page.check('input[name="tw-view"][value="match"]');
  ok('수동 조정과 되돌리기, 보기 전환');

  // 페이지 나누기: 한 쪽 100개 → 32개라서 한 쪽
  assert.equal(await page.isDisabled('#tw-next'), true);
  ok('페이지 나누기 버튼 상태');

  // ---- 5. 좋아요
  await page.click('#tab-likes');
  assert.equal(await page.isVisible('#panel-likes'), true);
  assert.equal(await page.isVisible('#panel-tweets'), false);
  assert.match(await page.textContent('#lk-summary'), /전체 10개 중 취소할 항목 10개/);
  await page.fill('#l-include', '광고');
  await page.waitForFunction(() => /취소할 항목 3개/.test(document.querySelector('#lk-summary').textContent));
  ok('좋아요 탭과 단어 필터(광고 → 3개)');

  // ---- 6. 북마크 + 내보내기
  await page.click('#tab-bookmarks');
  await page.check('#bm-all');
  assert.equal(await page.isDisabled('#btn-job'), true);
  await page.check('#ack');
  assert.equal(await page.isDisabled('#btn-job'), false);
  const exportSummary = await page.textContent('#export-summary');
  assert.match(exportSummary, /게시물·답글 32개 · 좋아요 3개 · 북마크 전체 삭제/);
  ok('내보내기 요약과 확인 체크 전에는 작업 파일 버튼 비활성');

  const dl = async (sel) => {
    const [d] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    return { name: d.suggestedFilename(), text: fs.readFileSync(await d.path(), 'utf8') };
  };
  const bj = await dl('#btn-backup-json');
  assert.match(bj.name, /^x-backup-\d{8}\.json$/);
  const backup = JSON.parse(bj.text);
  assert.equal(backup.tweets.length, 32);
  assert.equal(backup.likes.length, 3);
  assert.ok(backup.tweets.some((t) => t.text.includes('비밀')));
  ok('JSON 백업');

  const bc = await dl('#btn-backup-csv');
  assert.match(bc.name, /^x-backup-\d{8}\.csv$/);
  assert.ok(bc.text.startsWith('﻿구분,작성일시'));
  assert.equal(bc.text.split('\r\n').length, 1 + 32 + 3);
  ok('CSV 백업(BOM, 35행)');

  const jb = await dl('#btn-job');
  assert.match(jb.name, /^xclean-job-\d{8}\.json$/);
  const job = JSON.parse(jb.text);
  assert.equal(job.format, 'xclean-job');
  assert.equal(job.tweets.length, 32);
  assert.equal(job.likes.length, 3);
  assert.equal(job.bookmarksAll, true);
  assert.ok(job.tweets.includes('1000000000000000007'), '큰 ID 문자열 보존');
  fs.writeFileSync(path.join(SHOTS, 'job.json'), jb.text);
  ok('작업 파일(게시물 32, 좋아요 3, 북마크 전체)');

  // ---- 7. 실행기 복사
  const runnerSrc = fs.readFileSync(path.join(ROOT, 'runner.js'), 'utf8');
  await page.click('#btn-copy-runner');
  await page.waitForFunction(() => /복사했습니다/.test(document.querySelector('#toast').textContent));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), runnerSrc);
  ok('실행기 복사(클립보드 내용이 runner.js 와 동일)');

  await page.click('#runner-details summary');
  await page.waitForFunction(() => document.querySelector('#runner-src').textContent.length > 1000);
  assert.equal(await page.textContent('#runner-src'), runnerSrc);
  ok('실행기 코드 보기');

  // ---- 8. 외부 통신 / 콘솔 오류 없음
  const external = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:'));
  assert.deepEqual(external, [], '외부 요청이 있어서는 안 됩니다');
  assert.deepEqual(consoleErrors, [], '콘솔 오류/경고: ' + consoleErrors.join(' | '));
  ok('외부 요청 0건, 콘솔 오류/CSP 위반 0건');

  // ---- 9. 큰 ZIP(ZIP64 끝 레코드)
  const page2 = await ctx.newPage();
  await page2.goto(origin + '/');
  await page2.setInputFiles('#file-input', path.join(FX, 'sample-many.zip'));
  await page2.waitForFunction(() => /합계/.test(document.querySelector('#load-status').textContent));
  assert.match(await page2.textContent('#load-status'), /게시물·답글 32개, 좋아요 10개/);
  await page2.close();
  ok('항목 7만 개짜리 ZIP64 아카이브');

  // ---- 10. 여러 .js 파일을 직접 선택
  const page3 = await ctx.newPage();
  await page3.goto(origin + '/');
  await page3.setInputFiles('#file-input', [path.join(FX, 'tweets.js'), path.join(FX, 'like.js'), path.join(FX, 'tweet-headers.js')]);
  await page3.waitForFunction(() => /합계/.test(document.querySelector('#load-status').textContent));
  assert.match(await page3.textContent('#load-status'), /게시물·답글 32개, 좋아요 10개/);
  await page3.close();
  ok('개별 .js 파일 여러 개 선택');

  // ---- 11. 스크린샷
  await page.click('#tab-tweets');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-top.png'), fullPage: false });
  await page.screenshot({ path: path.join(SHOTS, 'desktop-full.png'), fullPage: true });

  const dark = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const pd = await dark.newPage();
  await pd.goto(origin + '/');
  await pd.setInputFiles('#file-input', path.join(FX, 'sample.zip'));
  await pd.waitForFunction(() => /합계/.test(document.querySelector('#load-status').textContent));
  await pd.screenshot({ path: path.join(SHOTS, 'desktop-dark.png'), fullPage: true });
  await dark.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const pm = await mobile.newPage();
  await pm.goto(origin + '/');
  await pm.setInputFiles('#file-input', path.join(FX, 'sample.zip'));
  await pm.waitForFunction(() => /합계/.test(document.querySelector('#load-status').textContent));
  await pm.screenshot({ path: path.join(SHOTS, 'mobile-full.png'), fullPage: true });
  const overflowX = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflowX <= 1, '모바일 가로 넘침: ' + overflowX);
  await mobile.close();
  ok('스크린샷(데스크톱·다크·모바일) 및 모바일 가로 넘침 없음');

  await browser.close();
  server.close();
  console.log('\n사이트 E2E 통과:', results.length, '항목');
})().catch((e) => { console.error('\n실패:', e); server.close(); process.exit(1); });
