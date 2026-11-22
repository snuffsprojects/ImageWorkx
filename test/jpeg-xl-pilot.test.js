const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPilot } = require('../jpeg-xl-pilot');

test('pilot preserves originals, verifies every JPEG and copies other media', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-jxl-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gallery = path.join(root, 'Gallery');
  await fs.mkdir(path.join(gallery, 'Album', 'nested'), { recursive: true });
  await fs.writeFile(path.join(gallery, 'Album', 'nested', 'a.jpg'), 'original jpeg');
  await fs.writeFile(path.join(gallery, 'Album', 'b.webp'), 'webp');
  await fs.writeFile(path.join(gallery, 'Album', 'c.webm'), 'webm');
  await fs.writeFile(path.join(gallery, 'Album', '.imageworks-tags.json'), JSON.stringify(['tag-id']));
  await fs.writeFile(path.join(gallery, 'Album', '.imageworks-cover.json'), JSON.stringify({ path:'nested/a.jpg' }));
  let saved;
  const run = async (command, args) => {
    if (command === 'cjxl') { saved = await fs.readFile(args[0]); await fs.writeFile(args[1], 'compressed'); }
    else await fs.writeFile(args[1], saved);
  };
  const result = await createPilot({ galleryRoot: gallery, dataRoot: root, albumId: 'Album', run });
  assert.equal(result.total, 1);
  assert.equal(await fs.readFile(path.join(gallery, 'Album', 'nested', 'a.jpg'), 'utf8'), 'original jpeg');
  assert.equal(await fs.readFile(path.join(gallery, result.name, 'nested', 'a.jpg.jxl'), 'utf8'), 'compressed');
  assert.equal(await fs.readFile(path.join(gallery, result.name, 'b.webp'), 'utf8'), 'webp');
  assert.equal(await fs.readFile(path.join(gallery, result.name, 'c.webm'), 'utf8'), 'webm');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(gallery, result.name, '.imageworks-tags.json'), 'utf8')), ['tag-id']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(gallery, result.name, '.imageworks-cover.json'), 'utf8')), { path:'nested/a.jpg.jxl' });
  await assert.rejects(createPilot({ galleryRoot: gallery, dataRoot: root, albumId: '../outside', run }), /Invalid/);
  await assert.rejects(createPilot({ galleryRoot: gallery, dataRoot: root, albumId: 'Album', run: async (cmd, args) => fs.writeFile(args[1], 'bad') }), /Verification failed/);
  assert.deepEqual((await fs.readdir(gallery)).sort(), ['Album', result.name].sort());
  assert.deepEqual((await fs.readdir(root)).sort(), ['Gallery']);
});
