const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { planMove, executeMove } = require('../processed-archives');

test('multipart moves preserve all volumes, resume safely, and avoid name collisions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-move-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'Album.part01.rar');
  const second = path.join(root, 'Album.part02.rar');
  await fs.writeFile(first, 'first');
  await fs.writeFile(second, 'second');
  await fs.writeFile(path.join(root, 'Other.rar'), 'unrelated');
  const plan = await planMove(first, path.join(root, 'Processed'));
  assert.equal(plan.files.length, 2);
  assert.equal(plan.files.at(-1).source, first);
  // Simulate interruption after the first link was created, before unlinking.
  await fs.mkdir(plan.destination, { recursive: true });
  await fs.link(second, path.join(plan.destination, path.basename(second)));
  await executeMove(plan);
  await executeMove(plan);
  await assert.rejects(fs.stat(first), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(plan.destination, path.basename(first)), 'utf8'), 'first');
  assert.equal(await fs.readFile(path.join(root, 'Other.rar'), 'utf8'), 'unrelated');
  await fs.writeFile(first, 'new upload');
  const next = await planMove(first, path.join(root, 'Processed'));
  assert.notEqual(next.destination, plan.destination);
  await fs.writeFile(first, 'changed since import');
  await assert.rejects(executeMove(next), /changed since import/);
  assert.equal(await fs.readFile(first, 'utf8'), 'changed since import');
});
