const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseRange, createPosterCache } = require('../video');

test('byte ranges support seeking, suffixes and invalid requests', () => {
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=2-99', 10), { start: 2, end: 9 });
  for (const value of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5', 'bad']) assert.equal(parseRange(value, 10), null);
  assert.equal(parseRange('bytes=0-', 0), null);
});

test('posters are deduplicated, serialized, cached and fall back after failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-posters-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0, active = 0, maxActive = 0;
  const poster = createPosterCache(root, async (command, args) => {
    assert.equal(command, 'ffmpeg');
    calls++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    await fs.writeFile(args.at(-1), 'poster');
    active--;
  });
  const stat = { size: 10, mtimeMs: 1 };
  const [a, b, c] = await Promise.all([poster('/one.webm', stat), poster('/one.webm', stat), poster('/two.webm', stat)]);
  assert.equal(a, b); assert.notEqual(a, c);
  assert.equal(calls, 2); assert.equal(maxActive, 1);
  assert.equal(await poster('/one.webm', stat), a);
  assert.equal(calls, 2);
  await poster('/one.webm', { ...stat, mtimeMs: 2 });
  assert.equal(calls, 3);
  let failures = 0;
  const broken = createPosterCache(root, async () => { failures++; throw new Error('No converter'); });
  assert.equal(await broken('/broken.webm', stat), null);
  assert.equal(await broken('/broken.webm', stat), null);
  assert.equal(failures, 1);
});
