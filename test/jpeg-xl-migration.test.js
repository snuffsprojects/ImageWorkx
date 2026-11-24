const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createMigration } = require('../jpeg-xl-migration');
const collections = require('../collections');
const imageTrash = require('../image-trash');

test('migration preserves JPEG references, survives reload and accounts for reviewed cleanup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iw-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const galleryRoot = path.join(root, 'Gallery');
  const trashRoot = path.join(root, '.gallery-trash');
  const imageTrashRoot = path.join(root, '.image-trash');
  const dir = path.join(galleryRoot, 'Example');
  await fs.mkdir(dir, { recursive: true });
  const original = Buffer.alloc(8192, 5);
  const jpeg = path.join(dir, 'photo.jpg');
  await fs.writeFile(jpeg, original);
  await fs.writeFile(path.join(dir, 'other.png'), 'other format');
  await fs.writeFile(path.join(dir, 'clip.webm'), 'video');
  await collections.add(root, galleryRoot, 'favourites', 'Example', 'photo.jpg');
  const id = await collections.readGalleryId(dir);
  let encodingStarted, finishEncoding;
  let waitForEncoding = new Promise(resolve => { encodingStarted = resolve; });
  let releaseEncoding = new Promise(resolve => { finishEncoding = resolve; });
  const options = {
    dataRoot: root, galleryRoot, trashRoot, minFree: 0, maxRetained: 2 * original.length,
    discover: async () => Promise.all((await fs.readdir(galleryRoot)).map(async name => {
      const dir = path.join(galleryRoot, name);
      const media = (await fs.readdir(dir)).filter(name => !name.startsWith('.'));
      return { dir, id: await collections.readGalleryId(dir), name, files: media.filter(name => name.endsWith('.jpg')), media };
    })),
    publish: async operation => operation(),
    changed() {},
    run: async (_program, [source, destination]) => {
      if (source.endsWith('.jxl')) return fs.writeFile(destination, original);
      encodingStarted();
      await releaseEncoding;
      await fs.writeFile(destination, 'encoded');
    }
  };
  let worker = createMigration(options);
  await worker.load();
  await worker.tick();
  assert.equal((await worker.report()).galleries[0].readiness, 'queued');
  await worker.setEnabled(true);
  const conversion = worker.tick();
  await waitForEncoding;
  const live = await worker.monitor();
  finishEncoding();
  await conversion;
  assert.equal(live.current.stage, 'Encoding JPEG XL');
  assert.equal(live.current.relative, 'photo.jpg');
  assert.equal(live.events[0].event, 'started');
  await assert.rejects(fs.stat(jpeg), { code: 'ENOENT' });
  assert.equal(await fs.readFile(jpeg + '.imageworks.jxl', 'utf8'), 'encoded');
  let report = await worker.report();
  assert.equal(report.totals.original, 8192);
  assert.equal(report.totals.retained, 8192);
  assert.equal(report.totals.net, -7);
  assert.equal(report.galleries[0].readiness, 'ready');
  const { images, retained, other, videos, pending } = report.galleries[0].counts;
  assert.deepEqual({ images, retained, other, videos, pending }, { images: 2, retained: 1, other: 1, videos: 1, pending: 0 });
  await fs.writeFile(path.join(dir, 'new.jpg'), original);
  const pendingReport = await worker.report();
  assert.equal(pendingReport.galleries[0].readiness, 'queued');
  assert.equal(pendingReport.cleanupAll.revision, null);
  await assert.rejects(worker.cleanupAll('stale'), /ready for cleanup have changed/);
  await fs.unlink(path.join(dir, 'new.jpg'));
  const detail = await collections.detail(root, galleryRoot, trashRoot, 'favourites');
  assert.equal(detail.items[0].url, '/reconstructed/Example/photo.jpg');
  assert.equal(detail.items[0].relativePath, 'photo.jpg');

  const moved = await imageTrash.move(galleryRoot, imageTrashRoot, 'Example', 'photo.jpg');
  assert.equal((await worker.report()).galleries[0].readiness, 'blocked');
  await assert.rejects(worker.review(id, report.galleries[0].review, 'cleanup'), /missing or has changed/);
  await imageTrash.restore(galleryRoot, trashRoot, imageTrashRoot, moved.id);

  // Simulate a crash after linking the verified replacement but before removing the live JPEG.
  const journal = path.join(root, '.imageworks-jpeg-xl', 'journal');
  const [entry] = await fs.readdir(journal);
  const journalFile = path.join(journal, entry);
  const record = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  await fs.writeFile(journalFile, JSON.stringify({ ...record, state: 'publishing' }));
  await fs.link(path.join(root, '.imageworks-jpeg-xl', 'originals', id, record.key + '.jpg'), jpeg);

  worker = createMigration(options);
  await worker.load();
  await assert.rejects(fs.stat(jpeg), { code: 'ENOENT' });
  report = await worker.report();
  assert.equal(report.enabled, true);
  await assert.rejects(worker.review(id, 'stale', 'cleanup'), /review has changed/);
  await assert.rejects(worker.cleanupAll('stale'), /ready for cleanup have changed/);
  assert.equal(report.cleanupAll.galleries, 1);
  assert.equal(report.cleanupAll.bytes, original.length);
  await fs.writeFile(jpeg + '.imageworks.jxl', 'altered');
  await assert.rejects(worker.cleanupAll(report.cleanupAll.revision), /missing or has changed/);
  assert.equal((await worker.report()).totals.retained, original.length);
  await assert.rejects(worker.review(id, report.galleries[0].review, 'cleanup'), /missing or has changed/);
  await fs.writeFile(jpeg + '.imageworks.jxl', 'encoded');
  const queuedGallery = path.join(galleryRoot, 'Waiting');
  await fs.mkdir(queuedGallery);
  const queuedImage = path.join(queuedGallery, 'pending.jpg');
  await fs.writeFile(queuedImage, original);
  const whileQueued = await worker.report();
  assert.equal(whileQueued.cleanupAll.pending, 1);
  assert.equal(whileQueued.cleanupAll.revision, report.cleanupAll.revision);
  waitForEncoding = new Promise(resolve => { encodingStarted = resolve; });
  releaseEncoding = new Promise(resolve => { finishEncoding = resolve; });
  const nextConversion = worker.tick();
  await waitForEncoding;
  const cleanup = worker.cleanupAll(whileQueued.cleanupAll.revision, whileQueued.cleanupAll.ids);
  assert.equal(worker.cleanupStatus().phase, 'waiting');
  await worker.tick();
  assert.equal(worker.cleanupStatus().phase, 'waiting');
  finishEncoding();
  await nextConversion;
  assert.deepEqual(await cleanup, { galleries: 1, files: 1 });
  const { status, total, verified, cleaned, files } = worker.cleanupStatus();
  assert.deepEqual({ status, total, verified, cleaned, files }, { status: 'success', total: 1, verified: 1, cleaned: 1, files: 1 });
  report = await worker.report();
  assert.equal(report.totals.reclaimed, 8192);
  assert.equal(report.totals.retained, original.length);
  assert.equal(report.totals.net, 8178);
  const finished = report.galleries.find(gallery => gallery.name === 'Example');
  assert.equal(finished.files[0].state, 'removed');
  assert.equal(finished.readiness, 'complete');
  assert.ok(finished.files[0].removedAt);
  const newlyReady = report.galleries.find(gallery => gallery.name === 'Waiting');
  assert.equal(newlyReady.readiness, 'ready');
  assert.equal(newlyReady.files[0].state, 'retained');
  const { events } = await worker.monitor();
  assert.ok(events.some(event => event.event === 'cleaned_up' && event.file === 'photo.jpg'));
  assert.ok(events.some(event => event.event === 'converted' && event.file === 'photo.jpg'));
});

test('migration restores a verified original and keeps it out of the conversion queue', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iw-restore-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const galleryRoot = path.join(root, 'Gallery');
  const dir = path.join(galleryRoot, 'Example');
  await fs.mkdir(dir, { recursive: true });
  const jpeg = path.join(dir, 'photo.jpg');
  const original = Buffer.alloc(4096, 9);
  await fs.writeFile(jpeg, original);
  const id = await collections.ensureGalleryId(dir);
  const worker = createMigration({
    dataRoot: root, galleryRoot, trashRoot: path.join(root, '.trash'),
    minFree: 0, maxRetained: 65536, changed() {},
    discover: async () => {
      const media = (await fs.readdir(dir)).filter(name => !name.startsWith('.'));
      return [{ dir, id, name: 'Example', files: media.filter(name => name.endsWith('.jpg')), media }];
    },
    publish: async operation => operation(),
    run: async (_program, [source, destination]) => fs.writeFile(destination, source.endsWith('.jxl') ? original : Buffer.from('jxl'))
  });
  await worker.load();
  await worker.setEnabled(true);
  await worker.tick();
  await worker.review(id, (await worker.report()).galleries[0].review, 'restore');
  await worker.tick();
  assert.deepEqual(await fs.readFile(jpeg), original);
  await assert.rejects(fs.stat(jpeg + '.imageworks.jxl'), { code: 'ENOENT' });
  const report = await worker.report();
  assert.equal(report.galleries[0].files[0].state, 'restored');
  assert.equal(report.totals.net, 0);
});
