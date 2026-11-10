'use strict';
// 실행: node --test tests/   (Node 20+ , python3 필요)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const X = require('../js/core.js');

let dir;
test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xclean-fx-'));
  execFileSync('python3', [path.join(__dirname, 'make-fixtures.py'), dir], { stdio: 'pipe' });
});
const fileOf = (name, type) => new File([fs.readFileSync(path.join(dir, name))], name, { type: type || '' });

test('날짜 파싱: X 형식, 오프셋, ISO, 잘못된 값', () => {
  assert.equal(X.parseTwitterDate('Wed Oct 10 20:19:24 +0000 2018'), Date.UTC(2018, 9, 10, 20, 19, 24));
  assert.equal(X.parseTwitterDate('Wed Oct 10 20:19:24 +0900 2018'), Date.UTC(2018, 9, 10, 11, 19, 24));
  assert.equal(X.parseTwitterDate('Wed Oct 10 20:19:24 -0500 2018'), Date.UTC(2018, 9, 11, 1, 19, 24));
  assert.equal(X.parseTwitterDate('2023-05-10T12:34:56.000Z'), Date.UTC(2023, 4, 10, 12, 34, 56));
  assert.equal(X.parseTwitterDate('엉터리'), null);
  assert.equal(X.parseTwitterDate(''), null);
  assert.equal(X.parseTwitterDate(undefined), null);
});

test('parseYtd: 접두사 제거, 순수 배열, 오류', () => {
  assert.deepEqual(X.parseYtd('window.YTD.tweets.part0 = [{"a":1}];'), { key: 'tweets', data: [{ a: 1 }] });
  assert.deepEqual(X.parseYtd('﻿[1,2]'), { key: null, data: [1, 2] });
  assert.throws(() => X.parseYtd('hello'), /형식/);
  assert.throws(() => X.parseYtd('window.YTD.tweets.part0 = {"a":1}'), /형식/);
});

test('normalizeTweet: 유형 구분, 큰 ID 보존, 헤더 전용', () => {
  const rt = X.normalizeTweet({ tweet: { id_str: '1000000000000000007', full_text: 'RT @a: hi', created_at: 'Wed Oct 10 20:19:24 +0000 2018' } });
  assert.equal(rt.kind, 'retweet');
  assert.equal(rt.id, '1000000000000000007');
  assert.equal(X.normalizeTweet({ tweet: { id_str: '1', full_text: '@a hi', in_reply_to_status_id_str: '9' } }).kind, 'reply');
  assert.equal(X.normalizeTweet({ tweet: { id_str: '1', full_text: 'hi' } }).kind, 'original');
  const h = X.normalizeTweet({ tweet: { tweet_id: '55', created_at: '2020-01-01T00:00:00.000Z' } });
  assert.equal(h.noText, true);
  assert.equal(h.kind, 'unknown');
  assert.equal(h.id, '55');
  assert.equal(X.normalizeTweet({ tweet: { id_str: 'abc' } }), null);
  assert.equal(X.normalizeTweet(null), null);
  assert.equal(X.normalizeLike({ like: { tweetId: '12', fullText: 'x' } }).id, '12');
  assert.equal(X.normalizeLike({ like: {} }), null);
});

test('ZIP(deflate): 필요한 파일만 읽고 deleted-tweets 등은 무시', async () => {
  const res = await X.loadFile(fileOf('sample.zip'));
  assert.equal(res.tweets.length, 30);
  assert.equal(res.likes.length, 10);
  assert.equal(res.headers.length, 7);
  const names = res.sources.map((s) => s.name).sort();
  assert.deepEqual(names, ['data/like.js', 'data/tweet-headers.js', 'data/tweets.js']);
  const kinds = res.tweets.reduce((a, t) => { a[t.kind] = (a[t.kind] || 0) + 1; return a; }, {});
  assert.deepEqual(kinds, { retweet: 6, reply: 8, original: 16 });
  // 한글이 깨지지 않는지, 큰 ID 가 정확한지
  assert.ok(res.tweets.some((t) => t.text.includes('비밀')));
  assert.equal(res.tweets[0].id, '1000000000000000007');
});

test('ZIP(저장 방식)과 단일 .js 파일', async () => {
  const stored = await X.loadFile(fileOf('sample-stored.zip'));
  assert.equal(stored.tweets.length, 30);
  const single = await X.loadFile(fileOf('tweets.js'));
  assert.equal(single.tweets.length, 30);
  assert.equal(single.sources[0].kind, 'tweets');
  const likes = await X.loadFile(fileOf('like.js'));
  assert.equal(likes.likes.length, 10);
  const hdr = await X.loadFile(fileOf('tweet-headers.js'));
  assert.equal(hdr.headers.length, 7);
});

test('ZIP64 끝 레코드(항목 7만 개)', async () => {
  const res = await X.loadFile(fileOf('sample-many.zip'));
  assert.equal(res.tweets.length, 30);
  assert.equal(res.likes.length, 10);
});

test('ZIP 항목별 ZIP64 확장 필드(크기·오프셋 0xFFFFFFFF)', async () => {
  const content = Buffer.from('window.YTD.tweets.part0 = [{"tweet":{"id_str":"123456789012345678","full_text":"zip64 확인","created_at":"Wed Oct 10 20:19:24 +0000 2018"}}]', 'utf8');
  const name = Buffer.from('data/tweets.js');
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

  const local = Buffer.concat([u32(0x04034b50), u16(45), u16(0), u16(0), u16(0), u16(0), u32(0), u32(content.length), u32(content.length), u16(name.length), u16(0), name, content]);
  const extra = Buffer.concat([u16(1), u16(24), u64(content.length), u64(content.length), u64(0)]);
  const cd = Buffer.concat([u32(0x02014b50), u16(45), u16(45), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0xFFFFFFFF), u32(0xFFFFFFFF), u16(name.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0), u32(0xFFFFFFFF), name, extra]);
  const cdOffset = local.length;
  const eocd64Offset = cdOffset + cd.length;
  const eocd64 = Buffer.concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(1), u64(1), u64(cd.length), u64(cdOffset)]);
  const locator = Buffer.concat([u32(0x07064b50), u32(0), u64(eocd64Offset), u32(1)]);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(0xFFFF), u16(0xFFFF), u32(0xFFFFFFFF), u32(0xFFFFFFFF), u16(0)]);
  const zip = Buffer.concat([local, cd, eocd64, locator, eocd]);

  const res = await X.loadFile(new File([zip], 'crafted.zip'));
  assert.equal(res.tweets.length, 1);
  assert.equal(res.tweets[0].id, '123456789012345678');
  assert.equal(res.tweets[0].text, 'zip64 확인');
});

test('잘못된 입력은 오류 또는 빈 결과', async () => {
  await assert.rejects(X.loadFile(fileOf('not-archive.json')), /형식/);
  await assert.rejects(X.loadFile(new File([Buffer.from('PK\x03\x04garbage-not-a-real-zip-file-at-all')], 'bad.zip')), /ZIP/);
  await assert.rejects(X.loadFile(new File([Buffer.from('abc')], 'tiny.zip')), /ZIP/);
  const none = await X.loadFile(new File([Buffer.from('window.YTD.follower.part0 = [{"follower":{"accountId":"1"}}]')], 'follower.js'));
  assert.equal(none.sources.length, 0);
});

test('병합: 본문 있는 항목이 헤더 전용 항목을 대체', async () => {
  const hdr = await X.loadFile(fileOf('tweet-headers.js'));
  const tw = await X.loadFile(fileOf('tweets.js'));
  const map = new Map();
  X.mergeTweets(map, hdr.headers);
  X.mergeTweets(map, tw.tweets);
  assert.equal(map.size, 32); // 30 + 헤더에만 있는 2개
  assert.equal(map.get('1000000000000000007').noText, false);
  const only = [...map.values()].filter((t) => t.noText);
  assert.equal(only.length, 2);
  // 순서를 바꿔도 같은 결과
  const map2 = new Map();
  X.mergeTweets(map2, tw.tweets);
  X.mergeTweets(map2, hdr.headers);
  assert.equal(map2.get('1000000000000000007').noText, false);
});

const allKinds = { original: true, reply: true, retweet: true, unknown: true };
const base = () => ({ kinds: { ...allKinds }, from: null, to: null, include: [], exclude: [], keepFav: 0, protect: new Set() });
const T = (o) => ({ id: '1', text: '안녕 Hello', ts: Date.UTC(2022, 5, 15), kind: 'original', fav: 3, rt: 0, noText: false, ...o });

test('필터: 유형·기간·단어·좋아요·보존 목록', () => {
  assert.equal(X.tweetMatches(T(), base()), true);
  assert.equal(X.tweetMatches(T({ kind: 'reply' }), { ...base(), kinds: { ...allKinds, reply: false } }), false);
  // 기간(양 끝 포함)
  assert.equal(X.tweetMatches(T(), { ...base(), from: Date.UTC(2022, 5, 15) }), true);
  assert.equal(X.tweetMatches(T(), { ...base(), from: Date.UTC(2022, 5, 16) }), false);
  assert.equal(X.tweetMatches(T(), { ...base(), to: Date.UTC(2022, 5, 14) }), false);
  assert.equal(X.tweetMatches(T({ ts: null }), { ...base(), to: Date.UTC(2030, 0, 1) }), false); // 날짜 모르면 안전하게 제외
  // 단어(대소문자 무시)
  assert.equal(X.tweetMatches(T(), { ...base(), include: ['hello'] }), true);
  assert.equal(X.tweetMatches(T(), { ...base(), include: ['없는말', '안녕'] }), true);
  assert.equal(X.tweetMatches(T(), { ...base(), include: ['없는말'] }), false);
  assert.equal(X.tweetMatches(T(), { ...base(), exclude: ['hello'] }), false);
  // 제외가 포함보다 우선
  assert.equal(X.tweetMatches(T(), { ...base(), include: ['안녕'], exclude: ['hello'] }), false);
  // 좋아요 보존
  assert.equal(X.tweetMatches(T({ fav: 3 }), { ...base(), keepFav: 3 }), false);
  assert.equal(X.tweetMatches(T({ fav: 2 }), { ...base(), keepFav: 3 }), true);
  // 보존 목록
  assert.equal(X.tweetMatches(T(), { ...base(), protect: new Set(['1']) }), false);
});

test('보존 목록 파싱: 주소·ID·쉼표·줄바꿈, 사용자명 숫자는 무시', () => {
  const s = X.parseProtectList('https://x.com/user12345678/status/1111111111111111111?s=20\n2222222222222222222, 333\nhttps://twitter.com/i/web/status/4444444444444444444');
  assert.deepEqual([...s].sort(), ['1111111111111111111', '2222222222222222222', '4444444444444444444']);
  assert.equal(X.parseProtectList('').size, 0);
});

test('좋아요 필터와 단어 분리', () => {
  assert.deepEqual(X.splitWords(' 광고, 홍보 \n 이벤트,,'), ['광고', '홍보', '이벤트']);
  assert.equal(X.likeMatches({ id: '1', text: '광고입니다' }, { include: ['광고'], exclude: [] }), true);
  assert.equal(X.likeMatches({ id: '1', text: '광고입니다' }, { include: [], exclude: ['광고'] }), false);
});

test('백업 · CSV · 작업 파일', () => {
  const tweets = [T({ id: '10', text: '=SUM(A1) "인용", 쉼표\n줄바꿈', fav: 5, rt: 2 }), T({ id: '11', text: '@친구 안녕' })];
  const likes = [{ id: '20', text: '좋아요' }];
  const b = X.buildBackup(tweets, likes);
  assert.equal(b.format, 'xclean-backup');
  assert.equal(b.tweets.length, 2);
  assert.equal(b.tweets[0].url, 'https://x.com/i/web/status/10');
  assert.equal(b.tweets[0].createdAt, '2022-06-15T00:00:00.000Z');
  assert.equal(b.likes[0].id, '20');

  const csv = X.buildCsv(tweets, likes);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '구분,작성일시,유형,내용,받은 좋아요,리트윗 수,주소');
  assert.ok(csv.includes('"\'=SUM(A1) ""인용"", 쉼표\n줄바꿈"'), '수식 방지 + 따옴표 이스케이프');
  assert.ok(csv.includes("'@친구 안녕"), '@ 로 시작하는 본문도 방지');
  assert.ok(csv.includes('좋아요,,,좋아요,,,https://x.com/i/web/status/20'));

  const job = X.buildJob({ tweets, likes, bookmarksAll: true });
  assert.equal(job.format, 'xclean-job');
  assert.equal(job.version, 1);
  assert.match(job.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(job.tweets, ['10', '11']);
  assert.deepEqual(job.likes, ['20']);
  assert.equal(job.bookmarksAll, true);
  assert.notEqual(X.buildJob({ tweets, likes, bookmarksAll: false }).id, job.id);
});
