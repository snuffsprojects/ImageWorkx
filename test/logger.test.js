const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLogger } = require('../logger');

test('log rotation retains bounded backups with readable structured errors', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imageworks-log-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = createLogger(root, { maxBytes: 100, backups: 2 });
  for (let i = 0; i < 5; i++) log('error', 'test.failure', { attempt: i, error: Object.assign(new Error('Extractor missing'), { code: 'ENOENT' }) });
  assert.deepEqual((await fs.readdir(root)).sort(), ['imageworks.log', 'imageworks.log.1', 'imageworks.log.2']);
  const record = JSON.parse(await fs.readFile(path.join(root, 'imageworks.log'), 'utf8'));
  assert.equal(record.attempt, 4);
  assert.equal(record.error.code, 'ENOENT');
  assert.equal(record.error.message, 'Extractor missing');
});
