const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { downloadMedia } = require('../downloader');

test('thread updates skip indexed media, preserve collisions, and clean failed downloads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let mediaRequests = 0;
  let posts = [{ tim: 1, filename: 'photo', ext: '.jpg', fsize: 3 }];
  const request = async url => {
    if (url.includes('a.4cdn.org')) return Response.json({ posts });
    mediaRequests++;
    return new Response('abc');
  };
  const run = () => downloadMedia('https://boards.4chan.org/wg/thread/123', root, () => {}, request);
  await run();
  await run();
  assert.equal(mediaRequests, 1);
  posts.push({ tim: 2, filename: 'photo', ext: '.jpg', fsize: 3 });
  await run();
  assert.equal(await fs.readFile(path.join(root, 'wg/123/photo-2.jpg'), 'utf8'), 'abc');
  posts.push({ tim: 3, filename: 'broken', ext: '.jpg', fsize: 99 });
  await assert.rejects(run(), /failed/);
  assert.equal((await fs.readdir(path.join(root, 'wg/123'))).some(f => f.endsWith('.part')), false);
  assert.equal(await fs.readFile(path.join(root, 'wg/123/photo.jpg'), 'utf8'), 'abc');
});

test('album pagination, referer, title cleanup, and image filtering', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = async (url, options) => {
    if (url.endsWith('/api/albums/abc')) return Response.json({ album: { title: 'Example (12.09.2026)' }, images: [], pagination: { last_page: 2 } });
    if (url.includes('images?page=2')) return Response.json({ images: [
      { encoded_id: 'a', original_filename: 'image.webp', original_url: 'https://cdn.example/a.webp', size_bytes: 3 },
      { encoded_id: 'b', original_filename: 'movie.mp4', original_url: 'https://cdn.example/b.mp4' },
      { encoded_id: 'c', original_filename: 'movie.webm', original_url: 'https://cdn.example/c.webm' }
    ] });
    assert.equal(options.headers.Referer, 'https://goonbox.cr/a/abc');
    return new Response('abc');
  };
  await downloadMedia('https://goonbox.cr/a/abc', root, () => {}, request, { includeWebm: true });
  assert.equal(await fs.readFile(path.join(root, 'GoonBox/Example/image.webp'), 'utf8'), 'abc');
  assert.equal((await fs.readdir(path.join(root, 'GoonBox/Example'))).some(name => /movie/.test(name)), false);
});


test('WebM is opt-in for 4chan and indexed videos are skipped on updates', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-webm-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let requests = 0;
  const request = async url => {
    if (url.includes('a.4cdn.org')) return Response.json({ posts: [
      { tim: 1, filename: 'clip', ext: '.webm', fsize: 3 },
      { tim: 2, filename: 'photo', ext: '.jpg', fsize: 3 }
    ] });
    requests++;
    return new Response('abc');
  };
  const run = options => downloadMedia('https://boards.4chan.org/wg/thread/123', root, () => {}, request, options);
  await run();
  assert.equal(requests, 1);
  await assert.rejects(fs.stat(path.join(root, 'wg/123/clip.webm')), { code: 'ENOENT' });
  await run({ includeWebm: true });
  assert.equal(requests, 2);
  assert.equal(await fs.readFile(path.join(root, 'wg/123/clip.webm'), 'utf8'), 'abc');
  await run({ includeWebm: true });
  assert.equal(requests, 2);
  await run({ includeWebm: false });
  assert.equal(requests, 2);
});

test('only a missing 4chan thread is marked unavailable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-thread-error-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = 'https://boards.4chan.org/wg/thread/123';
  await assert.rejects(downloadMedia(source, root, () => {}, async () => new Response('', { status: 404 })), { code: 'THREAD_NOT_FOUND', httpStatus: 404 });
  await assert.rejects(downloadMedia(source, root, () => {}, async () => new Response('', { status: 503 })), error => error.httpStatus === 503 && error.code !== 'THREAD_NOT_FOUND');
  await assert.rejects(downloadMedia('https://goonbox.cr/a/abc', root, () => {}, async () => new Response('', { status: 404 })), error => error.httpStatus === 404 && error.code !== 'THREAD_NOT_FOUND');
});

test('Bunkr albums sign image downloads and reuse the cache for either link format', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let fileRequests = 0;
  const request = async (value, options) => {
    const url = new URL(value);
    assert.equal(options.redirect, 'error');
    switch (url.hostname) {
      case 'bunkr.cr':
        assert.equal(url.href, 'https://bunkr.cr/a/Album123?advanced=1');
        return new Response(`<script>window.albumFiles = [
{
  id: 81,
  original: "photo.JPG",
  size: 3,
},
{
  id: 82,
  original: "video.webm",
  size: 4,
}
];</script>`);
      case 'dl.bunkr.cr':
        assert.equal(url.pathname, '/api/_001_v2');
        assert.deepEqual(JSON.parse(options.body), { id: '81' });
        return Response.json({ mediafiles: 'https://media.cdn.cr', path: '/photo%20one.jpg' });
      case 'glb-apisign.cdn.cr':
        assert.equal(url.searchParams.get('path'), '/photo one.jpg');
        return Response.json({ token: 'test-token', ex: 123 });
      case 'media.cdn.cr':
        fileRequests++;
        assert.equal(url.searchParams.get('token'), 'test-token');
        assert.equal(url.searchParams.get('ex'), '123');
        return new Response('abc', { headers: { 'Content-Type': 'application/octet-stream' } });
      default:
        assert.fail('Unexpected request to ' + url.hostname);
    }
  };
  const source = 'https://bunkr.cr/a/Album123';
  await downloadMedia(source, root, () => {}, request, { includeWebm: true });
  await downloadMedia(source + '?advanced=1', root, () => {}, request);
  assert.equal(await fs.readFile(path.join(root, 'Bunkr', 'Album123', 'photo.jpg'), 'utf8'), 'abc');
  assert.equal(fileRequests, 1);
});

test('GoonBox batch accepts copied image links and keeps successes when a link fails', async t => {
  const { goonBoxImageIds } = require('../downloader');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ids = goonBoxImageIds('https\\://goonbox.cr/img/Good\\\nhttps://goonbox.cr/img/Missing\nhttps://www.goonbox.cr/img/Good#copy');
  assert.deepEqual(ids, ['Good', 'Missing']);
  assert.throws(() => goonBoxImageIds('https://goonbox.cr.example.net/img/Good'), /Use individual/);
  let shouldFail = true;
  let originals = 0;
  const request = async (value, options) => {
    const url = new URL(value);
    assert.equal(options.redirect, 'error');
    if (url.hostname === 'goonbox.cr') {
      const id = url.pathname.split('/').at(-1);
      if (id === 'Missing' && shouldFail) return new Response(null, { status: 404 });
      return Response.json({ image: {
        original_url: 'https://simp6.cuckcapital.cr/test.jpg', original_filename: 'test.jpg', size_bytes: 3
      } });
    }
    assert.equal(url.hostname, 'simp6.cuckcapital.cr');
    originals++;
    return new Response('abc', { headers: { 'Content-Type': 'image/jpeg' } });
  };
  const run = () => downloadMedia('', root, () => {}, request, { batch: { id: 'gallery-id', ids } });
  assert.deepEqual(await run(), { failedLinks: ['https://goonbox.cr/img/Missing'], files: ['test-Good.jpg'] });
  shouldFail = false;
  assert.deepEqual(await run(), { failedLinks: [], files: ['test-Good.jpg', 'test-Missing.jpg'] });
  assert.equal(originals, 2);
});
