const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { moveToTrash, listTrash, restoreTrash, deleteTrash } = require('../gallery-trash');

test('trash keeps all gallery files, prevents overwrites, restores and deletes only selected entry', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-trash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gallery = path.join(root, 'Gallery'), trash = path.join(root, 'Trash');
  await fs.mkdir(path.join(gallery, 'Album', 'nested'), { recursive: true });
  await fs.writeFile(path.join(gallery, 'Album', 'nested', 'file.jpg'), 'picture');
  await fs.writeFile(path.join(gallery, 'Album', '.imageworks-source.json'), 'metadata');
  const moved = await moveToTrash(gallery, trash, 'Album');
  await assert.rejects(fs.access(path.join(gallery, 'Album')));
  assert.equal((await listTrash(trash))[0].sizeBytes, 15);
  await fs.mkdir(path.join(gallery, 'Album'));
  await assert.rejects(restoreTrash(gallery, trash, moved.id), /already exists/);
  assert.equal((await listTrash(trash)).length, 1);
  await fs.rmdir(path.join(gallery, 'Album'));
  await restoreTrash(gallery, trash, moved.id);
  assert.equal(await fs.readFile(path.join(gallery, 'Album', 'nested', 'file.jpg'), 'utf8'), 'picture');
  assert.equal(await fs.readFile(path.join(gallery, 'Album', '.imageworks-source.json'), 'utf8'), 'metadata');
  assert.deepEqual(await listTrash(trash), []);
  const again = await moveToTrash(gallery, trash, 'Album');
  await assert.rejects(deleteTrash(trash, '../Album'));
  await deleteTrash(trash, again.id);
  assert.deepEqual(await listTrash(trash), []);
});

test('trash refuses symlinks and invalid gallery names', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-trash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gallery = path.join(root, 'Gallery'), trash = path.join(root, 'Trash');
  await fs.mkdir(gallery); await fs.mkdir(path.join(root, 'outside'));
  await fs.writeFile(path.join(root, 'outside', 'keep'), 'safe');
  await fs.symlink(path.join(root, 'outside'), path.join(gallery, 'link'));
  await assert.rejects(moveToTrash(gallery, trash, 'link'), /not found/);
  await assert.rejects(moveToTrash(gallery, trash, '../outside'), /Invalid/);
  assert.equal(await fs.readFile(path.join(root, 'outside', 'keep'), 'utf8'), 'safe');
});
