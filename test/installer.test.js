const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, '../install-ubuntu.sh');
const user = process.env.SUDO_USER || (process.getuid() === 0 ? 'nobody' : os.userInfo().username);
function dryRun(extra = {}) {
  const env = { ...process.env, IMAGEWORKS_USER: user, IMAGEWORKS_DATA: '/tmp/imageworks-installer-example', IMAGEWORKS_PORT: '4173', IMAGEWORKS_LAN_PREFIX: '', IMAGEWORKS_MOUNT: '', ...extra };
  return spawnSync('bash', [script, '--dry-run'], { encoding: 'utf8', env });
}
test('installer previews a local-only service and validates network and mount settings', () => {
  const local = dryRun();
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /HOST=127\.0\.0\.1/);
  assert.match(local.stdout, /IMAGEWORKS_DATA=\/tmp\/imageworks-installer-example/);
  assert.match(local.stdout, /no changes made/i);
  const lan = dryRun({ IMAGEWORKS_LAN_PREFIX: '192.168.42.', IMAGEWORKS_DATA: '/mnt/example/ImageWorks', IMAGEWORKS_MOUNT: '/mnt/example' });
  assert.equal(lan.status, 0, lan.stderr);
  assert.match(lan.stdout, /HOST=0\.0\.0\.0/);
  assert.match(lan.stdout, /LAN_PREFIX=192\.168\.42\./);
  assert.match(lan.stdout, /mountpoint -q "\/mnt\/example"/);
  assert.notEqual(dryRun({ IMAGEWORKS_LAN_PREFIX: '999.168.1.' }).status, 0);
  assert.notEqual(dryRun({ IMAGEWORKS_PORT: '0' }).status, 0);
  assert.notEqual(dryRun({ IMAGEWORKS_DATA: '/tmp/elsewhere', IMAGEWORKS_MOUNT: '/mnt/example' }).status, 0);
  assert.notEqual(dryRun({ IMAGEWORKS_DATA: '/tmp/bad%path' }).status, 0);
});
