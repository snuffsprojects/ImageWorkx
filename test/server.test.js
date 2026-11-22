const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

test('web interface, gallery, rename, and origin protection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-server-'));
  await fs.mkdir(path.join(root, 'Gallery', 'Example'), { recursive: true });
  await fs.writeFile(path.join(root, 'Gallery', 'Example', 'test.jpg'), 'fixture-image');
  await fs.mkdir(path.join(root, 'Inbox'));
  await fs.mkdir(path.join(root, 'fixture'));
  await fs.writeFile(path.join(root, 'fixture/photo.jpg'), 'archive-image');
  await execFile('7z', ['a', '-tzip', path.join(root, 'Inbox', 'Uploaded.zip'), './photo.jpg'], { cwd: path.join(root, 'fixture') });
  await fs.writeFile(path.join(root, 'Inbox', 'Broken.zip'), 'This is not a valid archive');
  const mockFetch = path.join(root, 'mock-fetch.cjs');
  await fs.writeFile(mockFetch, `global.fetch = async url => {
    if (String(url).includes('/thread/999.json')) return new Response('', { status: 404 });
    if (String(url).includes('a.4cdn.org')) return Response.json({ posts: [
      { tim: 1, filename: 'photo', ext: '.jpg', fsize: 3, sub: 'Test thread' },
      { tim: 2, filename: 'movie', ext: '.webm', fsize: 3 }
    ] });
    if (String(url).includes('i.4cdn.org')) return new Response('abc');
    throw new Error('Unexpected external request: ' + url);
  };`);
  const child = spawn(process.execPath, ['--require', mockFetch, path.join(__dirname, '../server.js')], {
    env: { ...process.env, IMAGEWORKS_DATA: root, HOST: '127.0.0.1', PORT: '0', IMAGEWORKS_SCAN_INTERVAL: '100' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await exited;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Gallery: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
  });
  const base = `http://127.0.0.1:${port}`;
  async function postWhenIdle(endpoint, body) {
    for (let i = 0; i < 100; i++) {
      const response = await fetch(base + endpoint, { method: 'POST', body });
      if (response.status !== 409 || !/Wait for the current/.test((await response.clone().json()).error || '')) return response;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Gallery remained busy');
  }

  assert.match(await (await fetch(base)).text(), /ImageWorkx Gallery/);
  const styles = await (await fetch(base + '/styles.css')).text();
  assert.match(styles, /^:root\s*\{/);
  assert.match(styles, /\.batch-toolbar/);

  await fs.mkdir(path.join(root, '.previews'), { recursive: true });
  const cachedPreview = path.join(root, '.previews', 'a'.repeat(64) + '.jpg');
  await fs.writeFile(cachedPreview, 'cached preview');
  const storage = await (await fetch(base + '/api/storage')).json();
  assert.equal(storage.sizes.gallery, Buffer.byteLength('fixture-image'));
  assert.equal(storage.sizes.previews, Buffer.byteLength('cached preview'));
  assert.ok(storage.total >= storage.free);
  assert.equal((await fetch(base + '/api/storage/previews', { method: 'POST', headers: { Origin: 'http://other.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/storage/previews', { method: 'POST' })).status, 200);
  await assert.rejects(fs.access(cachedPreview));
  assert.equal(await fs.readFile(path.join(root, 'Gallery', 'Example', 'test.jpg'), 'utf8'), 'fixture-image');

  const data = await (await fetch(base + '/api/albums')).json();
  assert.equal(data.albums[0].count, 1);
  assert.equal(data.albums[0].sizeBytes, Buffer.byteLength('fixture-image'));
  assert.equal(data.albums[0].images[0].sizeBytes, Buffer.byteLength('fixture-image'));
  assert.equal(await (await fetch(base + data.albums[0].images[0].url)).text(), 'fixture-image');
  const summary = await (await fetch(base + '/api/albums?summary=1')).json();
  assert.equal(summary.albums[0].count, 1);
  assert.equal(summary.albums[0].images, undefined);
  assert.match(summary.albums[0].cover, /^\/preview\//);
  assert.equal(await (await fetch(base + summary.albums[0].cover)).text(), 'fixture-image');
  await fs.writeFile(path.join(root, 'Gallery', 'Example', 'external.jpg'), 'new');
  assert.equal((await (await fetch(base + '/api/albums?summary=1')).json()).albums[0].count, 1);
  await fs.rm(path.join(root, 'Gallery', 'Example', 'external.jpg'));
  await fs.mkdir(path.join(root, 'Gallery', 'Trash Test'));
  await fs.writeFile(path.join(root, 'Gallery', 'Trash Test', 'image.jpg'), 'kept');
  const trashBody = JSON.stringify({ id: 'Trash Test' });
  assert.equal((await fetch(base + '/api/gallery-trash/move', { method: 'POST', headers: { Origin: 'http://other.example' }, body: trashBody })).status, 403);
  const trashMove = await postWhenIdle('/api/gallery-trash/move', trashBody);
  assert.equal(trashMove.status, 200);
  const trashed = (await trashMove.json()).entry;
  assert.equal((await (await fetch(base + '/api/gallery-trash')).json()).entries[0].name, 'Trash Test');
  assert.equal((await (await fetch(base + '/api/albums?id=Trash%20Test')).json()).albums.length, 0);
  const restore = await postWhenIdle('/api/gallery-trash/restore', JSON.stringify({ id: trashed.id }));
  assert.equal(restore.status, 200);
  assert.equal(await fs.readFile(path.join(root, 'Gallery', 'Trash Test', 'image.jpg'), 'utf8'), 'kept');
  await fs.rm(path.join(root, 'Gallery', 'Trash Test'), { recursive: true });
  const createdTag = await postWhenIdle('/api/tags/create', JSON.stringify({ name: 'Portraits' }));
  assert.equal(createdTag.status, 200);
  const tag = (await createdTag.json()).tag;
  const assign = await postWhenIdle('/api/tags/assign', JSON.stringify({ album: 'Example', ids: [tag.id] }));
  assert.equal(assign.status, 200);
  assert.deepEqual((await (await fetch(base + '/api/albums?summary=1')).json()).albums.find(album => album.id === 'Example').tagIds, [tag.id]);
  assert.equal((await fetch(base + '/api/tags/create', { method: 'POST', headers: { Origin: 'http://other.example' }, body: JSON.stringify({ name: 'Bad' }) })).status, 403);
  const createdGallery = await postWhenIdle('/api/albums/create', JSON.stringify({ name: 'Manual Gallery' }));
  assert.equal(createdGallery.status, 201);
  assert.equal((await createdGallery.json()).id, 'Manual Gallery');
  assert.equal((await postWhenIdle('/api/albums/create', JSON.stringify({ name: 'Manual Gallery' }))).status, 409);
  const blankGallery = (await (await fetch(base + '/api/albums?id=Manual%20Gallery')).json()).albums[0];
  assert.equal(blankGallery.count, 0); assert.equal(blankGallery.cover, null);
  async function upload(name, body) {
    for (let i = 0; i < 100; i++) {
      const response = await fetch(base + '/api/albums/upload?id=Manual%20Gallery&name=' + encodeURIComponent(name), { method: 'POST', body });
      if (response.status !== 409) return response;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Gallery remained busy');
  }
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal((await upload('first.jpg', jpeg)).status, 201);
  const duplicate = await upload('first.jpg', jpeg);
  assert.equal(duplicate.status, 201); assert.equal((await duplicate.json()).name, 'first (2).jpg');
  assert.equal((await upload('bad.png', jpeg)).status, 400);
  assert.equal((await fetch(base + '/api/albums/upload?id=Manual%20Gallery&name=blocked.jpg', { method: 'POST', headers: { Origin: 'http://other.example' }, body: jpeg })).status, 403);
  assert.equal((await postWhenIdle('/api/albums/cover', JSON.stringify({ id: 'Manual Gallery', path: 'first (2).jpg' }))).status, 200);
  const coverGallery = (await (await fetch(base + '/api/albums?id=Manual%20Gallery')).json()).albums[0];
  assert.equal(coverGallery.count, 2); assert.match(coverGallery.cover, /first%20\(2\)\.jpg/);
  assert.equal((await postWhenIdle('/api/albums/cover', JSON.stringify({ id: 'Manual Gallery', path: '../outside.jpg' }))).status, 400);
  const collectionResult = await postWhenIdle('/api/collections/create', JSON.stringify({ name: 'Image Trash test' }));
  assert.equal(collectionResult.status, 200);
  const testCollection = (await collectionResult.json()).result;
  assert.equal((await postWhenIdle('/api/collections/add', JSON.stringify({ collection: testCollection.id, album: 'Manual Gallery', path: 'first (2).jpg' }))).status, 200);
  const imageMove = await postWhenIdle('/api/image-trash/move', JSON.stringify({ album: 'Manual Gallery', path: 'first (2).jpg' }));
  assert.equal(imageMove.status, 200);
  const imageEntries = (await (await fetch(base + '/api/image-trash')).json()).entries;
  assert.equal(imageEntries.length, 1); assert.equal(imageEntries[0].name, 'first (2).jpg');
  const missingCover = (await (await fetch(base + '/api/albums?id=Manual%20Gallery')).json()).albums[0];
  assert.equal(missingCover.count, 1); assert.match(missingCover.cover, /first\.jpg/);
  assert.equal((await (await fetch(base + '/api/collections?id=' + testCollection.id)).json()).collection.items[0].state, 'image-trashed');
  const imageDownload = await fetch(base + '/api/image-trash/file?id=' + imageEntries[0].id + '&download=1');
  assert.equal(imageDownload.headers.get('content-disposition'), 'attachment');
  assert.deepEqual(Buffer.from(await imageDownload.arrayBuffer()), jpeg);
  assert.equal((await postWhenIdle('/api/image-trash/restore', JSON.stringify({ id: imageEntries[0].id }))).status, 200);
  const restoredCover = (await (await fetch(base + '/api/albums?id=Manual%20Gallery')).json()).albums[0];
  assert.equal(restoredCover.count, 2); assert.match(restoredCover.cover, /first%20\(2\)\.jpg/);
  assert.equal((await (await fetch(base + '/api/collections?id=' + testCollection.id)).json()).collection.items[0].state, 'available');
  await fs.mkdir(path.join(root, 'Gallery', 'Last Image'));
  await fs.writeFile(path.join(root, 'Gallery', 'Last Image', 'last.jpg'), jpeg);
  const lastMove = await postWhenIdle('/api/image-trash/move', JSON.stringify({ album: 'Last Image', path: 'last.jpg' }));
  assert.equal(lastMove.status, 200);
  assert.equal((await (await fetch(base + '/api/albums?id=Last%20Image')).json()).albums[0].count, 0);
  const lastEntry = (await (await fetch(base + '/api/image-trash')).json()).entries.find(entry => entry.sourceName === 'Last Image');
  assert.equal((await postWhenIdle('/api/image-trash/restore', JSON.stringify({ id: lastEntry.id }))).status, 200);
  assert.equal((await fetch(base + '/api/image-trash/move', { method: 'POST', headers: { Origin: 'http://other.example' }, body: '{}' })).status, 403);

  assert.equal((await fetch(base + '/api/albums/create', { method: 'POST', headers: { Origin: 'http://other.example' }, body: JSON.stringify({ name: 'No' }) })).status, 403);
  const detail = await (await fetch(base + '/api/albums?id=Example')).json();
  assert.equal(detail.albums.length, 1);
  assert.equal(detail.albums[0].images[0].name, 'test.jpg');
  assert.equal(detail.albums[0].images[0].relativePath, 'test.jpg');
  const addedFavourite = await postWhenIdle('/api/collections/add', JSON.stringify({ collection: 'favourites', album: 'Example', path: 'test.jpg' }));
  assert.equal(addedFavourite.status, 200);
  let favourite = (await (await fetch(base + '/api/collections?id=favourites')).json()).collection;
  assert.equal(favourite.items[0].state, 'available');
  assert.equal(favourite.items[0].name, 'test.jpg');
  assert.equal((await fetch(base + '/api/collections/add', { method: 'POST', headers: { Origin: 'http://other.example' }, body: '{}' })).status, 403);
  const batchResult = await postWhenIdle('/api/collections/add-many', JSON.stringify({ collection: 'favourites', album: 'Example', paths: ['test.jpg'] }));
  assert.equal(batchResult.status, 200);
  assert.deepEqual((await batchResult.json()).result, { added: 0, alreadyAdded: 1 });
  const colourResult = await postWhenIdle('/api/tags/colour', JSON.stringify({ id: tag.id, colour: 'blue' }));
  assert.equal(colourResult.status, 200);
  let metadataResponse;
  for (let i = 0; i < 100; i++) {
    metadataResponse = await fetch(base + '/api/metadata-backup');
    if (metadataResponse.status !== 409) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(metadataResponse.status, 200);
  assert.match(metadataResponse.headers.get('content-disposition'), /attachment/);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.tags[0].colour, 'blue');
  const preview = await postWhenIdle('/api/metadata-restore/preview', JSON.stringify(metadata));
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).filesToRestore, 0);
  assert.equal((await fetch(base + '/api/metadata-restore/apply', { method: 'POST', headers: { Origin: 'http://other.example' }, body: JSON.stringify(metadata) })).status, 403);


  const missing = await (await fetch(base + '/api/albums?id=Missing')).json();
  assert.deepEqual(missing.albums, []);
  const traversal = await (await fetch(base + '/api/albums?id=..%2FExample')).json();
  assert.deepEqual(traversal.albums, []);
  await fs.mkdir(path.join(root, 'Gallery', 'Video Only'));
  await fs.writeFile(path.join(root, 'Gallery', 'Video Only', 'clip.webm'), '0123456789');
  await fs.writeFile(path.join(root, 'Gallery', 'Video Only', '.imageworks-source.json'), JSON.stringify({ type: '4chan', board: 'wg', threadId: '123', includeWebm: true }));
  const videoAlbum = (await (await fetch(base + '/api/albums?id=Video%20Only')).json()).albums[0];
  assert.equal(videoAlbum.count, 1);
  assert.equal(videoAlbum.source.includeWebm, true);
  assert.equal(videoAlbum.images[0].type, 'video');
  assert.equal(videoAlbum.cover, videoAlbum.images[0].poster);
  const videoUrl = base + videoAlbum.images[0].url;
  const clip = await fetch(videoUrl, { headers: { Range: 'bytes=2-5' } });
  assert.equal(clip.status, 206);
  assert.equal(clip.headers.get('content-type'), 'video/webm');
  assert.equal(clip.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await clip.text(), '2345');
  const suffix = await fetch(videoUrl, { headers: { Range: 'bytes=-3' } });
  assert.equal(await suffix.text(), '789');
  const invalid = await fetch(videoUrl, { headers: { Range: 'bytes=99-' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */10');
  const head = await fetch(videoUrl, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  assert.equal((await fetch(videoUrl + '?download=1')).headers.get('content-disposition'), 'attachment');
  const poster = await fetch(base + videoAlbum.cover);
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get('content-type'), 'image/svg+xml');
  assert.match(await poster.text(), /WEBM/);
  const afterPoster = (await (await fetch(base + '/api/albums?id=Video%20Only')).json()).albums[0];
  assert.equal(afterPoster.count, 1);
  const body = JSON.stringify({ id: 'Example', name: 'Renamed' });
  assert.equal((await fetch(base + '/api/albums/rename', { method: 'POST', headers: { Origin: 'http://other.example' }, body })).status, 403);
  assert.equal((await postWhenIdle('/api/albums/rename', body)).status, 200);
  assert.equal(await fs.readFile(path.join(root, 'Gallery/Renamed/test.jpg'), 'utf8'), 'fixture-image');
  favourite = (await (await fetch(base + '/api/collections?id=favourites')).json()).collection;
  assert.equal(favourite.items[0].sourceName, 'Renamed');
  assert.equal(favourite.items[0].state, 'available');

  assert.ok((await (await fetch(base + '/api/albums?summary=1')).json()).albums.some(album => album.id === 'Renamed'));
  assert.equal((await fetch(base + '/api/download', { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) })).status, 400);
  async function download(includeWebm, checkBusy = false) {
    const response = await fetch(base + '/api/download', { method: 'POST', body: JSON.stringify({ url: 'https://boards.4chan.org/wg/thread/777', includeWebm }) });
    assert.equal(response.status, 202);
    if (checkBusy) {
      const blocked = await fetch(base + '/api/storage/download-cache', { method: 'POST', body: JSON.stringify({ id: 'wg/777' }) });
      assert.equal(blocked.status, 409);
      const blockedTrash = await fetch(base + '/api/gallery-trash/move', { method: 'POST', body: JSON.stringify({ id: 'Renamed' }) });
      assert.equal(blockedTrash.status, 409);
    }
    for (let i = 0; i < 100; i++) {
      const job = (await (await fetch(base + '/api/download')).json()).download;
      if (job.status !== 'working') { assert.equal(job.status, 'success', job.message); return job; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('Download timed out');
  }
  const expired = await fetch(base + '/api/download', { method: 'POST', body: JSON.stringify({ url: 'https://boards.4chan.org/wg/thread/999' }) });
  assert.equal(expired.status, 202);
  let expiredJob;
  for (let i = 0; i < 50; i++) {
    expiredJob = (await (await fetch(base + '/api/download')).json()).download;
    if (expiredJob.status !== 'working') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(expiredJob.status, 'error');
  assert.equal(expiredJob.errorCode, 'THREAD_NOT_FOUND');
  assert.match(expiredJob.message, /saved gallery is unchanged/);
  await download(false, true);
  let thread = (await (await fetch(base + '/api/albums?id=4chan%20wg%20777')).json()).albums[0];
  assert.equal(thread.count, 1);
  assert.equal(thread.source.includeWebm, false);
  assert.equal((await postWhenIdle('/api/albums/rename', JSON.stringify({ id: thread.id, name: 'My Thread' }))).status, 200);
  await download(true);
  thread = (await (await fetch(base + '/api/albums?id=My%20Thread')).json()).albums[0];
  assert.equal(thread.count, 2);
  assert.equal(thread.source.includeWebm, true);
  assert.equal(thread.images.filter(item => item.type === 'video').length, 1);
  const imagePath = thread.images.find(item => item.type === 'image').relativePath;
  assert.equal((await postWhenIdle('/api/image-trash/move', JSON.stringify({ album: 'My Thread', path: imagePath }))).status, 200);
  await download(true);
  assert.equal((await (await fetch(base + '/api/albums?id=My%20Thread')).json()).albums[0].count, 1);
  const savedImage = (await (await fetch(base + '/api/image-trash')).json()).entries.find(entry => entry.sourceName === 'My Thread');
  assert.equal((await postWhenIdle('/api/image-trash/restore', JSON.stringify({ id: savedImage.id }))).status, 200);
  await download(true);
  assert.equal((await (await fetch(base + '/api/albums?id=My%20Thread')).json()).albums[0].count, 2);
  // Opting out must not re-copy a previously cached video that was removed from the gallery.
  await fs.rm(path.join(root, 'Gallery/My Thread/movie.webm'));
  await download(false);
  thread = (await (await fetch(base + '/api/albums?id=My%20Thread')).json()).albums[0];
  assert.equal(thread.count, 1);
  assert.equal(thread.source.includeWebm, false);
  assert.deepEqual((await (await fetch(base + '/api/albums?id=4chan%20wg%20777')).json()).albums, []);
  let records;
  for (let i = 0; i < 100; i++) {
    records = (await fs.readFile(path.join(root, 'Logs/imageworks.log'), 'utf8')).trim().split('\n').map(JSON.parse);
    if (records.some(r => r.event === 'archive.moved_to_processed') && records.some(r => r.event === 'archive.import_failed')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await fs.readFile(path.join(root, 'Gallery/Uploaded/photo.jpg'), 'utf8'), 'archive-image');
  await assert.rejects(fs.stat(path.join(root, 'Inbox/Uploaded.zip')), { code: 'ENOENT' });
  const moved = records.find(r => r.event === 'archive.moved_to_processed');
  assert.ok((await fs.stat(path.join(moved.destination, 'Uploaded.zip'))).size > 0);
  assert.equal(await fs.readFile(path.join(root, 'Inbox/Broken.zip'), 'utf8'), 'This is not a valid archive');
  const failure = records.find(r => r.event === 'archive.import_failed');
  assert.match(failure.archive, /Broken.zip$/);
  assert.equal(failure.error.exitCode, 2);
  assert.ok(failure.error.stderr || failure.error.stdout);
  assert.match(failure.error.stack, /Error/);
  assert.equal(failure.retryInSeconds, 30);
  assert.ok(Date.parse(failure.timestamp));
  await new Promise(resolve => setTimeout(resolve, 800));
  const latest = await fs.readFile(path.join(root, 'Logs/imageworks.log'), 'utf8');
  assert.equal(latest.split('\n').filter(line => line.includes('archive.import_failed')).length, 1);
});
