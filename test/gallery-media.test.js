const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const media = require('../gallery-media');

test('manual gallery uploads retain existing names, reject invalid images and select covers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-media-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await media.createGallery(root, 'Album');
  assert.equal(await media.manualGallery(path.join(root, 'Album')), true);
  await assert.rejects(media.createGallery(root, 'Album'), { code: 'EEXIST' });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const write = name => media.upload(root, 'Album', name, jpeg.length, Readable.from([jpeg]));
  assert.equal((await write('photo.jpg')).name, 'photo.jpg');
  assert.equal((await write('photo.jpg')).name, 'photo (2).jpg');
  assert.deepEqual(await fs.readFile(path.join(root, 'Album', 'photo.jpg')), jpeg);
  await assert.rejects(media.upload(root, 'Album', '../bad.jpg', jpeg.length, Readable.from([jpeg])), /valid filename/);
  await fs.symlink(path.join(root, 'Album'), path.join(root, 'AlbumLink'));
  await assert.rejects(media.upload(root, 'AlbumLink', 'link.jpg', jpeg.length, Readable.from([jpeg])), /Gallery not found/);
  await assert.rejects(media.upload(root, 'Album', 'bad.png', jpeg.length, Readable.from([jpeg])), /contents/);
  await assert.rejects(media.upload(root, 'Album', 'zero.jpg', 0, Readable.from([])), /100 MB/);
  await assert.rejects(media.upload(root, 'Album', 'large.jpg', media.MAX_UPLOAD + 1, Readable.from([])), /100 MB/);
  await assert.rejects(media.upload(root, 'Album', 'short.jpg', 9, Readable.from([jpeg])), /incomplete/);
  async function* interrupted() { yield jpeg; throw new Error('Connection lost'); }
  await assert.rejects(media.upload(root, 'Album', 'interrupted.jpg', 9, Readable.from(interrupted())), /Connection lost/);
  assert.equal((await fs.readdir(path.join(root, 'Album'))).some(file => file.includes('upload-')), false);
  const files = [path.join(root, 'Album', 'photo.jpg'), path.join(root, 'Album', 'photo (2).jpg')];
  await media.setCover(root, 'Album', 'photo (2).jpg', files);
  assert.equal(await media.readCover(path.join(root, 'Album')), 'photo (2).jpg');
  await assert.rejects(media.setCover(root, 'Album', '../photo.jpg', files), /Choose an image/);
  assert.equal(await media.readCover(path.join(root, 'Album')), 'photo (2).jpg');
});
