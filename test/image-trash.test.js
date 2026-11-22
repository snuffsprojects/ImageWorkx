const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const images = require('../image-trash');
const galleries = require('../gallery-trash');
const collections = require('../collections');
const media = require('../gallery-media');

test('individual file Trash preserves collections and covers through rename and restore', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-image-trash-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const gallery = path.join(root, 'Gallery'), bin = path.join(root, 'ImageTrash'), galleryBin = path.join(root, 'GalleryTrash');
  await fs.mkdir(path.join(gallery, 'Album', 'nested'), { recursive:true });
  const source = path.join(gallery, 'Album', 'nested', 'photo.jpg'); await fs.writeFile(source, 'original');
  await collections.add(root, gallery, 'favourites', 'Album', 'nested/photo.jpg');
  await media.setCover(gallery, 'Album', 'nested/photo.jpg', [source]);
  const moved = await images.move(gallery, bin, 'Album', 'nested/photo.jpg');
  await assert.rejects(fs.access(source));
  let item = (await collections.detail(root, gallery, galleryBin, 'favourites', await images.references(bin))).items[0];
  assert.equal(item.state, 'image-trashed');
  assert.equal((await images.list(bin, gallery, galleryBin))[0].name, 'photo.jpg');
  await fs.rename(path.join(gallery, 'Album'), path.join(gallery, 'Renamed'));
  assert.equal((await images.list(bin, gallery, galleryBin))[0].sourceName, 'Renamed');
  await images.restore(gallery, galleryBin, bin, moved.id);
  assert.equal(await fs.readFile(path.join(gallery, 'Renamed', 'nested', 'photo.jpg'), 'utf8'), 'original');
  assert.equal(await media.readCover(path.join(gallery, 'Renamed')), 'nested/photo.jpg');
  item = (await collections.detail(root, gallery, galleryBin, 'favourites', await images.references(bin))).items[0];
  assert.equal(item.state, 'available'); assert.equal(item.sourceName, 'Renamed');
  assert.deepEqual(await images.list(bin, gallery, galleryBin), []);
});

test('Image Trash prevents overwrites and retains deletion records until explicitly cleared', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-image-trash-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const gallery = path.join(root, 'Gallery'), bin = path.join(root, 'ImageTrash'), galleryBin = path.join(root, 'GalleryTrash');
  await fs.mkdir(path.join(gallery, 'Album'), { recursive:true });
  await fs.writeFile(path.join(gallery, 'Album', 'photo.jpg'), 'original');
  await collections.add(root, gallery, 'favourites', 'Album', 'photo.jpg');
  const moved = await images.move(gallery, bin, 'Album', 'photo.jpg');
  assert.deepEqual([...await images.reservedPaths(bin, moved.galleryId)], ['photo.jpg']);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const upload = await media.upload(gallery, 'Album', 'photo.jpg', jpeg.length, Readable.from([jpeg]), await images.reservedPaths(bin, moved.galleryId));
  assert.equal(upload.name, 'photo (2).jpg');
  await fs.writeFile(path.join(gallery, 'Album', 'photo.jpg'), 'replacement');
  await assert.rejects(images.restore(gallery, galleryBin, bin, moved.id), /already exists/);
  assert.equal(await fs.readFile(path.join(gallery, 'Album', 'photo.jpg'), 'utf8'), 'replacement');
  assert.equal((await collections.detail(root, gallery, galleryBin, 'favourites', await images.references(bin))).items[0].state, 'image-trashed');
  await images.deleteMedia(bin, moved.id);
  assert.equal((await images.list(bin, gallery, galleryBin))[0].deleted, true);
  assert.equal((await collections.detail(root, gallery, galleryBin, 'favourites', await images.references(bin))).items[0].state, 'image-deleted');
  assert.deepEqual([...await images.reservedPaths(bin, moved.galleryId)], ['photo.jpg']);
  await images.forget(bin, moved.id);
  assert.equal((await images.reservedPaths(bin, moved.galleryId)).size, 0);
  assert.equal((await collections.detail(root, gallery, galleryBin, 'favourites', await images.references(bin))).items[0].state, 'available');
});

test('restoring an image requires its original gallery and rejects traversal and symlinks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-image-trash-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const gallery = path.join(root, 'Gallery'), bin = path.join(root, 'ImageTrash'), galleryBin = path.join(root, 'GalleryTrash');
  await fs.mkdir(path.join(gallery, 'Album'), { recursive:true });
  await fs.writeFile(path.join(gallery, 'Album', 'photo.jpg'), 'original');
  await fs.symlink(path.join(gallery, 'Album', 'photo.jpg'), path.join(gallery, 'Album', 'link.jpg'));
  await assert.rejects(images.move(gallery, bin, 'Album', '../outside.jpg'));
  await assert.rejects(images.move(gallery, bin, 'Album', 'link.jpg'));
  const image = await images.move(gallery, bin, 'Album', 'photo.jpg');
  const group = await galleries.moveToTrash(gallery, galleryBin, 'Album');
  await assert.rejects(images.restore(gallery, galleryBin, bin, image.id), /source gallery/);
  await galleries.restoreTrash(gallery, galleryBin, group.id);
  await images.restore(gallery, galleryBin, bin, image.id);
  assert.equal(await fs.readFile(path.join(gallery, 'Album', 'photo.jpg'), 'utf8'), 'original');
});

test('ambiguous Image Trash entries at the same original path must be resolved before restore', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-image-trash-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const gallery = path.join(root, 'Gallery'), bin = path.join(root, 'ImageTrash'), galleryBin = path.join(root, 'GalleryTrash');
  await fs.mkdir(path.join(gallery, 'Album'), { recursive:true });
  await fs.writeFile(path.join(gallery, 'Album', 'photo.jpg'), 'original');
  const first = await images.move(gallery, bin, 'Album', 'photo.jpg');
  await fs.writeFile(path.join(gallery, 'Album', 'photo.jpg'), 'external replacement');
  const second = await images.move(gallery, bin, 'Album', 'photo.jpg');
  await assert.rejects(images.restore(gallery, galleryBin, bin, first.id), /same original location/);
  await images.deleteMedia(bin, second.id);
  await images.forget(bin, second.id);
  await images.restore(gallery, galleryBin, bin, first.id);
  assert.equal(await fs.readFile(path.join(gallery, 'Album', 'photo.jpg'), 'utf8'), 'original');
});

test('interrupted restore can safely finish without overwriting the recovered file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-image-trash-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const gallery = path.join(root, 'Gallery'), bin = path.join(root, 'ImageTrash'), galleryBin = path.join(root, 'GalleryTrash');
  await fs.mkdir(path.join(gallery, 'Album'), { recursive:true });
  const file = path.join(gallery, 'Album', 'photo.jpg');
  await fs.writeFile(file, 'original');
  const moved = await images.move(gallery, bin, 'Album', 'photo.jpg');
  await fs.link(path.join(bin, moved.id, 'media'), file);
  await images.restore(gallery, galleryBin, bin, moved.id);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.deepEqual(await images.list(bin, gallery, galleryBin), []);
});
