const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readActivity } = require('../activity');

test('activity reads recent events across rotated logs and tolerates incomplete records', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-activity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const record = value => JSON.stringify(value) + '\n';
  await fs.writeFile(path.join(dir, 'imageworks.log.1'), record({ timestamp: '2026-01-01T00:00:00Z', level: 'info', event: 'service.started' }));
  await fs.writeFile(path.join(dir, 'imageworks.log'), record({ timestamp: '2026-01-02T00:00:00Z', level: 'info', event: 'archive.import_completed', archive: '/inbox/one.zip', images: 4 }) + record({ timestamp: '2026-01-03T00:00:00Z', level: 'error', event: 'archive.move_failed', error: { message: 'Permission denied', stack: 'private stack' }, retryInSeconds: 30 }) + '{incomplete');
  const events = await readActivity(dir);
  assert.deepEqual(events.map(event => event.event), ['archive.move_failed', 'archive.import_completed', 'service.started']);
  assert.equal(events[0].message, 'Permission denied');
  assert.equal(events[0].retryInSeconds, 30);
  assert.equal(events[1].archive, 'one.zip');
  assert.equal((await readActivity(dir, 1)).length, 1);
});
