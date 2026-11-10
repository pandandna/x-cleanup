#!/usr/bin/env python3
"""테스트용 모의 X 아카이브를 만듭니다. 사용법: make-fixtures.py <출력 폴더>"""
import json
import os
import sys
import zipfile
from datetime import datetime, timedelta, timezone

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

BASE_ID = 1000000000000000000  # 2^53 을 넘는 ID 로 정밀도 문제를 확인합니다.


def tid(i):
    return str(BASE_ID + i * 1000 + 7)


def fmt(dt):
    return dt.strftime('%a %b %d %H:%M:%S +0000 %Y')


tweets = []
start = datetime(2019, 3, 1, 12, 0, 0, tzinfo=timezone.utc)
for i in range(30):
    dt = start + timedelta(days=i * 75)
    if i % 5 == 0:
        text = 'RT @someone: 남의 글 %d' % i
        reply = None
    elif i % 3 == 1:
        text = '@friend 답글 %d' % i
        reply = tid(i - 1)
    else:
        text = '내 게시물 %d' % i
        reply = None
    if i % 7 == 0:
        text += ' 비밀'
    if i == 4:
        text += ' keep-me'
    t = {
        'id_str': tid(i),
        'id': tid(i),
        'full_text': text,
        'created_at': fmt(dt),
        'favorite_count': str(i * 2),
        'retweet_count': str(i),
        'retweeted': False,
        'favorited': False,
    }
    if reply:
        t['in_reply_to_status_id_str'] = reply
        t['in_reply_to_user_id_str'] = '42'
    tweets.append({'tweet': t})

likes = []
for i in range(10):
    likes.append({'like': {
        'tweetId': tid(100 + i),
        'fullText': '좋아요한 글 %d%s' % (i, ' 광고' if i % 4 == 0 else ''),
        'expandedUrl': 'https://twitter.com/i/web/status/' + tid(100 + i),
    }})

headers = []
for i in range(5):
    headers.append({'tweet': {'tweet_id': tid(i), 'user_id': '42', 'created_at': fmt(start + timedelta(days=i * 75))}})
for i in (500, 501):
    headers.append({'tweet': {'tweet_id': tid(i), 'user_id': '42', 'created_at': fmt(start + timedelta(days=i))}})


def ytd(name, data):
    return 'window.YTD.%s.part0 = %s' % (name, json.dumps(data, ensure_ascii=False, indent=2))


files = {
    'data/tweets.js': ytd('tweets', tweets),
    'data/like.js': ytd('like', likes),
    'data/tweet-headers.js': ytd('tweet_headers', headers),
    'data/deleted-tweets.js': ytd('deleted_tweets', tweets[:2]),   # 무시되어야 함
    'data/follower.js': ytd('follower', [{'follower': {'accountId': '1'}}]),
    'data/manifest.js': 'window.__THAR_CONFIG = {}',
}

for name, text in files.items():
    if name in ('data/tweets.js', 'data/like.js', 'data/tweet-headers.js'):
        with open(os.path.join(out, os.path.basename(name)), 'w', encoding='utf-8') as f:
            f.write(text)

with zipfile.ZipFile(os.path.join(out, 'sample.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    for name, text in files.items():
        z.writestr(name, text)
    z.writestr('data/tweets_media/a.jpg', b'\xff\xd8\xff' * 100)

with zipfile.ZipFile(os.path.join(out, 'sample-stored.zip'), 'w', zipfile.ZIP_STORED) as z:
    for name, text in files.items():
        z.writestr(name, text)

# 항목이 65535개를 넘으면 ZIP64 끝 레코드가 쓰입니다. (미디어 파일이 많은 실제 아카이브와 같은 구조)
with zipfile.ZipFile(os.path.join(out, 'sample-many.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    for i in range(70000):
        z.writestr('data/tweets_media/%06d.jpg' % i, b'x')
    for name, text in files.items():
        z.writestr(name, text)

# 압축 해제 없이 쓸 수 있는 순수 JSON
with open(os.path.join(out, 'not-archive.json'), 'w', encoding='utf-8') as f:
    f.write('{"hello": "world"}')

print('ok', out)
