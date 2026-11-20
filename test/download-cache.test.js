const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listDownloadCache, removeDownloadCache } = require('../download-cache');

test('lists and removes only individual recognised cache directories', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache');
  await fs.mkdir(path.join(cache, 'wg', '123'), { recursive: true });
  await fs.mkdir(path.join(cache, 'GoonBox', 'Example'), { recursive: true });
  await fs.mkdir(path.join(root, 'outside'));
  await fs.writeFile(path.join(root, 'outside', 'important'), 'safe');
  await fs.writeFile(path.join(cache, 'wg', '123', 'photo.jpg'), 'image');
  await fs.writeFile(path.join(cache, 'GoonBox', 'Example', 'photo.jpg'), 'album');
  await fs.symlink(path.join(root, 'outside'), path.join(cache, 'GoonBox', 'link'));
  const list = await listDownloadCache(cache);
  assert.deepEqual(list.map(entry => entry.id).sort(), ['GoonBox/Example', 'wg/123']);
  assert.equal(list.find(entry => entry.id === 'wg/123').sizeBytes, 5);
  await assert.rejects(removeDownloadCache(cache, 'GoonBox/../outside'));
  await assert.rejects(removeDownloadCache(cache, 'GoonBox/link'));
  await removeDownloadCache(cache, 'wg/123');
  await assert.rejects(fs.access(path.join(cache, 'wg', '123')));
  assert.equal(await fs.readFile(path.join(root, 'outside', 'important'), 'utf8'), 'safe');
  assert.equal(await fs.readFile(path.join(cache, 'GoonBox', 'Example', 'photo.jpg'), 'utf8'), 'album');
});
