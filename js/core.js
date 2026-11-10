/*! X 정리 도구 — 코어 로직 (아카이브 파싱 · ZIP 읽기 · 필터 · 내보내기)
 *  브라우저와 Node 양쪽에서 동작합니다. 네트워크 요청을 하지 않습니다. */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ 날짜 */

  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

  // "Wed Oct 10 20:19:24 +0000 2018" 형식과 ISO 형식을 모두 읽습니다.
  function parseTwitterDate(s) {
    if (!s || typeof s !== 'string') return null;
    const m = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(s.trim());
    if (m) {
      const mon = MONTHS[m[1]];
      if (mon === undefined) return null;
      const utc = Date.UTC(+m[9], mon, +m[2], +m[3], +m[4], +m[5]);
      const offset = (+m[7] * 60 + +m[8]) * 60000 * (m[6] === '-' ? -1 : 1);
      return utc - offset;
    }
    const p = Date.parse(s);
    return Number.isNaN(p) ? null : p;
  }

  /* ------------------------------------------------------- 아카이브 파일 파싱 */

  // `window.YTD.tweets.part0 = [ ... ]` 형태, 또는 순수 JSON 배열을 읽습니다.
  function parseYtd(text) {
    const trimmed = String(text).replace(/^﻿/, '').trimStart();
    const km = /^window\.YTD\.([A-Za-z0-9_]+)\.part\d+\s*=/.exec(trimmed);
    let body;
    if (km) {
      body = trimmed.slice(km[0].length);
    } else if (trimmed.startsWith('[')) {
      body = trimmed;
    } else {
      throw new Error('X 아카이브 파일 형식이 아닙니다.');
    }
    body = body.trim().replace(/;\s*$/, '');
    const data = JSON.parse(body);
    if (!Array.isArray(data)) throw new Error('X 아카이브 파일 형식이 아닙니다.');
    return { key: km ? km[1] : null, data };
  }

  function classify(key, data) {
    if (key === 'tweets' || key === 'tweet') return 'tweets';
    if (key === 'tweet_headers') return 'headers';
    if (key === 'like') return 'likes';
    if (key) return null; // 그 밖의 아카이브 파일(DM, 팔로워 등)은 무시
    const first = data[0];
    if (!first || typeof first !== 'object') return null;
    if (first.tweet && (first.tweet.full_text !== undefined || first.tweet.id_str !== undefined)) return 'tweets';
    if (first.tweet && first.tweet.tweet_id) return 'headers';
    if (first.like) return 'likes';
    return null;
  }

  function normalizeTweet(entry) {
    const t = entry && (entry.tweet || entry);
    if (!t || typeof t !== 'object') return null;
    const id = String(t.id_str || t.id || t.tweet_id || '');
    if (!/^\d{1,25}$/.test(id)) return null;
    const hasText = typeof t.full_text === 'string' || typeof t.text === 'string';
    const text = hasText ? (t.full_text || t.text || '') : '';
    let kind = 'unknown';
    if (hasText) {
      if (/^RT @/.test(text)) kind = 'retweet';
      else if (t.in_reply_to_status_id_str || t.in_reply_to_status_id) kind = 'reply';
      else kind = 'original';
    }
    return {
      id,
      text,
      ts: parseTwitterDate(t.created_at),
      kind,
      fav: Number(t.favorite_count) || 0,
      rt: Number(t.retweet_count) || 0,
      noText: !hasText,
    };
  }

  function normalizeLike(entry) {
    const l = entry && (entry.like || entry);
    if (!l || typeof l !== 'object') return null;
    const id = String(l.tweetId || l.tweet_id || '');
    if (!/^\d{1,25}$/.test(id)) return null;
    return { id, text: typeof l.fullText === 'string' ? l.fullText : '' };
  }

  // 같은 ID가 여러 파일에 있으면 본문이 있는 쪽을 남깁니다.
  function mergeTweets(map, items) {
    for (const t of items) {
      const old = map.get(t.id);
      if (!old || (old.noText && !t.noText)) map.set(t.id, t);
    }
  }
  function mergeLikes(map, items) {
    for (const l of items) {
      const old = map.get(l.id);
      if (!old || (!old.text && l.text)) map.set(l.id, l);
    }
  }

  /* --------------------------------------------------------------- ZIP 읽기 */

  const SIG_EOCD = 0x06054b50;
  const SIG_EOCD64 = 0x06064b50;
  const SIG_LOC64 = 0x07064b50;
  const SIG_CD = 0x02014b50;
  const SIG_LFH = 0x04034b50;

  // 중앙 디렉터리만 읽어 항목 목록을 만듭니다. (수 GB짜리 아카이브도 전체를 메모리에 올리지 않습니다.)
  async function listZip(file) {
    const size = file.size;
    if (size < 22) throw new Error('ZIP 파일이 아닙니다.');
    const tailLen = Math.min(size, 22 + 65535 + 20);
    const tail = new DataView(await file.slice(size - tailLen, size).arrayBuffer());
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP 파일 구조를 찾을 수 없습니다.');

    let cdSize = tail.getUint32(eocd + 12, true);
    let cdOffset = tail.getUint32(eocd + 16, true);
    const entryCount16 = tail.getUint16(eocd + 10, true);
    if (entryCount16 === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
      const loc = eocd - 20;
      if (loc < 0 || tail.getUint32(loc, true) !== SIG_LOC64) throw new Error('ZIP64 구조를 읽을 수 없습니다.');
      const eocd64 = Number(tail.getBigUint64(loc + 8, true));
      const v = new DataView(await file.slice(eocd64, eocd64 + 56).arrayBuffer());
      if (v.getUint32(0, true) !== SIG_EOCD64) throw new Error('ZIP64 구조를 읽을 수 없습니다.');
      cdSize = Number(v.getBigUint64(40, true));
      cdOffset = Number(v.getBigUint64(48, true));
    }

    const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const decoder = new TextDecoder('utf-8');
    const out = [];
    let p = 0;
    while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === SIG_CD) {
      const method = cd.getUint16(p + 10, true);
      let comp = cd.getUint32(p + 20, true);
      let usize = cd.getUint32(p + 24, true);
      const nameLen = cd.getUint16(p + 28, true);
      const extraLen = cd.getUint16(p + 30, true);
      const commentLen = cd.getUint16(p + 32, true);
      let offset = cd.getUint32(p + 42, true);
      const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));

      if (usize === 0xFFFFFFFF || comp === 0xFFFFFFFF || offset === 0xFFFFFFFF) {
        let q = p + 46 + nameLen;
        const qEnd = q + extraLen;
        while (q + 4 <= qEnd) {
          const id = cd.getUint16(q, true);
          const len = cd.getUint16(q + 2, true);
          if (id === 0x0001) {
            let r = q + 4;
            if (usize === 0xFFFFFFFF) { usize = Number(cd.getBigUint64(r, true)); r += 8; }
            if (comp === 0xFFFFFFFF) { comp = Number(cd.getBigUint64(r, true)); r += 8; }
            if (offset === 0xFFFFFFFF) { offset = Number(cd.getBigUint64(r, true)); r += 8; }
            break;
          }
          q += 4 + len;
        }
      }
      out.push({ name, method, comp, size: usize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  async function readZipEntryText(file, e) {
    const lh = new DataView(await file.slice(e.offset, e.offset + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== SIG_LFH) throw new Error('ZIP 항목 헤더가 손상되었습니다: ' + e.name);
    const dataStart = e.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const blob = file.slice(dataStart, dataStart + e.comp);
    if (e.method === 0) return blob.text();
    if (e.method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('이 브라우저는 ZIP 압축 해제를 지원하지 않습니다. 최신 Chrome/Edge를 쓰거나 압축을 풀어 .js 파일을 직접 선택해 주세요.');
      }
      const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    }
    throw new Error('지원하지 않는 압축 방식입니다 (' + e.method + ').');
  }

  // data/tweets.js, tweets-part1.js, tweet-headers.js, like.js 등
  const WANTED = /(^|\/)(tweets?|tweet-headers|like)(-part\d+)?\.js$/i;

  async function isZip(file) {
    if (file.size < 4) return false;
    const b = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04;
  }

  /* 파일 하나를 읽어 { tweets, headers, likes, sources } 로 돌려줍니다. */
  async function loadFile(file, onStatus) {
    const result = { tweets: [], headers: [], likes: [], sources: [] };

    const consume = (name, text) => {
      const { key, data } = parseYtd(text);
      const kind = classify(key, data);
      if (!kind) return;
      const bucket = result[kind];
      const norm = kind === 'likes' ? normalizeLike : normalizeTweet;
      let count = 0;
      for (const entry of data) {
        const item = norm(entry);
        if (item) { bucket.push(item); count++; }
      }
      result.sources.push({ name, kind, count });
    };

    if (/\.zip$/i.test(file.name) || await isZip(file)) {
      const entries = (await listZip(file)).filter((e) => WANTED.test(e.name) && !/__MACOSX/.test(e.name));
      if (!entries.length) throw new Error('ZIP 안에서 tweets.js 또는 like.js 를 찾지 못했습니다.');
      for (const e of entries) {
        if (onStatus) onStatus(e.name + ' 읽는 중…');
        consume(e.name, await readZipEntryText(file, e));
      }
    } else {
      if (onStatus) onStatus(file.name + ' 읽는 중…');
      consume(file.name, await file.text());
    }
    return result;
  }

  /* ----------------------------------------------------------------- 필터 */

  function splitWords(s) {
    return String(s || '').split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  }

  // 주소(…/status/123)나 숫자 ID를 모아 Set 으로 돌려줍니다.
  function parseProtectList(s) {
    const set = new Set();
    const str = String(s || '');
    for (const m of str.matchAll(/status\/(\d+)/g)) set.add(m[1]);
    for (const tok of str.split(/[\s,]+/)) if (/^\d{5,25}$/.test(tok)) set.add(tok);
    return set;
  }

  /* f = { kinds:{original,reply,retweet,unknown}, from, to, include[], exclude[], keepFav, protect:Set } */
  function tweetMatches(t, f) {
    if (f.protect && f.protect.has(t.id)) return false;
    if (!f.kinds[t.kind]) return false;
    if (f.from != null && (t.ts == null || t.ts < f.from)) return false;
    if (f.to != null && (t.ts == null || t.ts > f.to)) return false;
    if (f.keepFav > 0 && t.fav >= f.keepFav) return false;
    const text = (t.text || '').toLowerCase();
    if (f.exclude && f.exclude.length && f.exclude.some((w) => text.includes(w))) return false;
    if (f.include && f.include.length && !f.include.some((w) => text.includes(w))) return false;
    return true;
  }

  function likeMatches(l, f) {
    const text = (l.text || '').toLowerCase();
    if (f.exclude && f.exclude.length && f.exclude.some((w) => text.includes(w))) return false;
    if (f.include && f.include.length && !f.include.some((w) => text.includes(w))) return false;
    return true;
  }

  /* ------------------------------------------------------------- 내보내기 */

  const KIND_LABEL = { original: '게시물', reply: '답글', retweet: '리트윗', unknown: '불명' };
  const statusUrl = (id) => 'https://x.com/i/web/status/' + id;

  function buildBackup(tweets, likes) {
    return {
      format: 'xclean-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      tweets: tweets.map((t) => ({
        id: t.id,
        url: statusUrl(t.id),
        createdAt: t.ts == null ? null : new Date(t.ts).toISOString(),
        type: t.kind,
        text: t.text,
        favorites: t.fav,
        retweets: t.rt,
      })),
      likes: likes.map((l) => ({ id: l.id, url: statusUrl(l.id), text: l.text })),
    };
  }

  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // 엑셀에서 수식으로 해석되지 않도록 본문 앞에 작은따옴표를 붙입니다.
  function safeCell(s) {
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }

  function buildCsv(tweets, likes) {
    const rows = [['구분', '작성일시', '유형', '내용', '받은 좋아요', '리트윗 수', '주소']];
    for (const t of tweets) {
      rows.push(['게시물', t.ts == null ? '' : new Date(t.ts).toISOString(), KIND_LABEL[t.kind] || t.kind, safeCell(t.text), t.fav, t.rt, statusUrl(t.id)]);
    }
    for (const l of likes) rows.push(['좋아요', '', '', safeCell(l.text), '', '', statusUrl(l.id)]);
    return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
  }

  function makeJobId() {
    const bytes = new Uint8Array(6);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function buildJob({ tweets, likes, bookmarksAll }) {
    return {
      format: 'xclean-job',
      version: 1,
      id: makeJobId(),
      createdAt: new Date().toISOString(),
      tweets: tweets.map((t) => t.id),
      likes: likes.map((l) => l.id),
      bookmarksAll: !!bookmarksAll,
    };
  }

  const api = {
    parseTwitterDate, parseYtd, classify, normalizeTweet, normalizeLike, mergeTweets, mergeLikes,
    listZip, readZipEntryText, loadFile, WANTED,
    splitWords, parseProtectList, tweetMatches, likeMatches,
    buildBackup, buildCsv, buildJob, statusUrl, KIND_LABEL,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XClean = api;
})(typeof self !== 'undefined' ? self : this);
