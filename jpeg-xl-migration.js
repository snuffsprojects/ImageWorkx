const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createLogger } = require('./logger');
const { readRecent } = require('./activity');
const { verifyJpeg, sha256 } = require('./jpeg-xl-pilot');
const { suffix, isJpeg, isMigrated, logicalPath } = require('./jpeg-xl-paths');
const collections = require('./collections');

const GiB = 1024 ** 3;
const identity = /^[\da-f-]{36}$/i;
const keyFor = (id, relative) => createHash('sha256').update(id + '\0' + relative).digest('hex');
const cleanupRevision = galleries => createHash('sha256').update(galleries.map(gallery => gallery.id + ':' + gallery.review).sort().join('\n')).digest('hex');
const revision = records => createHash('sha256').update(records.map(record => record.key + record.convertedAt).sort().join('\n')).digest('hex');

async function stat(file) {
  try {
    const value = await fs.lstat(file);
    if (!value.isFile()) throw new Error('Expected a regular file.');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function sync(file) {
  const handle = await fs.open(file, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function write(file, value) {
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await sync(temp);
  await fs.rename(temp, file);
  await sync(path.dirname(file));
}

function createMigration({ dataRoot, galleryRoot, trashRoot, discover, publish, changed, run, idle = () => true, minFree = 5 * GiB, maxRetained = 20 * GiB }) {
  const root = path.join(dataRoot, '.imageworks-jpeg-xl');
  const journal = path.join(root, 'journal');
  const originals = path.join(root, 'originals');
  const work = path.join(root, 'work');
  const settings = path.join(root, 'settings.json');
  const logName = 'jpeg-xl-worker.log';
  const log = createLogger(root, { filename: logName, maxBytes: 256 * 1024, mirror: false });
  const records = new Map();
  const byGallery = new Map();
  let enabled = false, busy = false, current = null, message = '';
  let candidates = [], refreshAt = 0, retryAt = 0;
  let cleanupSequence = 0, cleanupJob = null, conversionFinished;
  const cleanupStatus = () => cleanupJob && { ...cleanupJob };
  const totalsFor = () => ({ original: 0, encoded: 0, retained: 0, reclaimed: 0, net: 0, allocatedNet: 0 });
  function accumulate(totals, record) {
    totals.original += record.originalBytes;
    totals.encoded += record.encodedBytes;
    if (record.state === 'retained') totals.retained += record.originalBytes;
    else {
      totals.reclaimed += record.originalBytes;
      totals.allocatedNet += record.originalAllocated;
    }
    totals.allocatedNet -= record.encodedAllocated;
    totals.net = totals.original - totals.encoded - totals.retained;
  }

  function remember(record) {
    records.set(record.key, record);
    if (!byGallery.has(record.galleryId)) byGallery.set(record.galleryId, new Map());
    byGallery.get(record.galleryId).set(record.relative, record);
  }
  const outcomes = { retained: 'converted', removed: 'cleaned_up', restored: 'restored', skipped: 'skipped', failed: 'failed' };
  function logOutcome(record, state = record.state, timestamp) {
    if (!Object.hasOwn(outcomes, state)) return;
    log(state === 'failed' ? 'error' : 'info', outcomes[state], {
      ...(timestamp ? { timestamp } : {}),
      album: record.name, file: record.relative, originalBytes: record.originalBytes,
      encodedBytes: record.encodedBytes, message: record.message
    });
  }
  function workerMessage(value, level = 'info') {
    if (message !== value) log(level, 'status', { message: value });
    message = value;
  }
  async function monitor() {
    return { enabled, current: current && { ...current }, message, cleanup: cleanupStatus(), events: await readRecent(root, logName, 100, row => row) };
  }

  async function save(record) {
    await write(path.join(journal, record.key + '.json'), record);
    remember(record);
    logOutcome(record);
  }
  const retainedFile = record => path.join(originals, record.galleryId, record.key + '.jpg');
  async function load() {
    await fs.mkdir(journal, { recursive: true, mode: 0o700 });
    await fs.mkdir(originals, { recursive: true, mode: 0o700 });
    // Work files are disposable. The journal and retained originals survive a restart.
    await fs.rm(work, { recursive: true, force: true });
    await fs.mkdir(work, { mode: 0o700 });
    if (await stat(settings)) enabled = JSON.parse(await fs.readFile(settings, 'utf8')).enabled === true;
    for (const entry of await fs.readdir(journal, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[\da-f]{64}\.json$/.test(entry.name)) continue;
      const record = JSON.parse(await fs.readFile(path.join(journal, entry.name), 'utf8'));
      if (!identity.test(record.galleryId) || !collections.validRelative(record.relative) || !isJpeg(record.relative) ||
          record.key !== keyFor(record.galleryId, record.relative) || entry.name !== record.key + '.json') {
        throw new Error('Invalid JPEG XL migration journal entry.');
      }
      remember(record);
    }
    if (!await stat(path.join(root, logName))) {
      const prior = [];
      for (const record of records.values()) {
        if (record.convertedAt) prior.push([record, 'retained', record.convertedAt]);
        const time = record.removedAt || record.restoredAt || (['skipped', 'failed'].includes(record.state) ? record.at : null);
        if (time) prior.push([record, record.state, time]);
      }
      prior.sort((a, b) => a[2].localeCompare(b[2]));
      for (const [record, state, at] of prior.slice(-1000)) logOutcome(record, state, at);
    }
    await recover();
  }

  async function recover() {
    const pending = [...records.values()].filter(record => ['publishing', 'restoring', 'cleaning'].includes(record.state));
    if (!pending.length) return;
    const locations = await collections.locations(galleryRoot, trashRoot);
    for (const record of pending) {
      const retained = retainedFile(record);
      if (record.state === 'cleaning') {
        const present = await stat(retained);
        await save({ ...record, state: present ? 'retained' : 'removed', removedAt: present ? null : record.cleanupStartedAt });
        continue;
      }
      const matches = locations.get(record.galleryId) || [];
      if (matches.length !== 1) continue;
      const input = path.join(matches[0].dir, record.relative);
      const encoded = input + suffix;
      if (record.state === 'publishing') {
        if (await stat(encoded) && await stat(retained) && await sha256(encoded) === record.encodedHash && await sha256(retained) === record.originalHash) {
          if (await stat(input)) {
            if (await sha256(input) !== record.originalHash) continue;
            await fs.unlink(input);
            await sync(path.dirname(input));
          }
          await save({ ...record, state: 'retained' });
        } else if (!await stat(encoded) && await stat(input)) {
          if (await stat(retained)) {
            if (await sha256(retained) !== record.originalHash || await sha256(input) !== record.originalHash) continue;
            await fs.unlink(retained);
            await sync(path.dirname(retained));
          }
          await save({ ...record, state: 'retry' });
        }
      } else if (await stat(encoded)) {
        if (!await stat(input)) {
          await save({ ...record, state: 'retained' });
          continue;
        }
        if (!await stat(retained) || await sha256(input) !== record.originalHash ||
            await sha256(retained) !== record.originalHash || await sha256(encoded) !== record.encodedHash) continue;
        await fs.unlink(encoded);
        await fs.unlink(retained);
        await save({ ...record, state: 'restored' });
      } else if (await stat(input) && await sha256(input) === record.originalHash) {
        if (await stat(retained) && await sha256(retained) === record.originalHash) await fs.unlink(retained);
        await save({ ...record, state: 'restored' });
      }
    }
  }

  function summary(galleryId, jpegs, migratedCount) {
    const entries = byGallery.get(galleryId) || new Map();
    const issues = [...entries.values()].filter(record => ['failed', 'skipped', 'publishing', 'cleaning', 'restoring'].includes(record.state)).length;
    const pending = jpegs.some(file => !entries.has(file) || entries.get(file).state === 'retry');
    if (issues) return { state: 'attention' };
    if (pending || current?.galleryId === galleryId) return { state: 'queued' };
    if (migratedCount) return { state: 'verified' };
    return null;
  }

  async function setEnabled(value) {
    if (typeof value !== 'boolean') throw new Error('Choose whether automatic migration is enabled.');
    if (value && [...records.values()].some(record => ['publishing', 'restoring', 'cleaning'].includes(record.state))) {
      throw new Error('An interrupted operation needs recovery. Restart ImageWorks before enabling migration.');
    }
    await write(settings, { enabled: value });
    if (enabled !== value) log('info', value ? 'enabled' : 'paused');
    enabled = value;
    if (!enabled) message = '';
    else refreshAt = retryAt = 0;
  }

  async function tick() {
    if (!enabled || busy || cleanupJob?.status === 'working' || !idle() || Date.now() < retryAt) return;
    busy = true;
    let temp;
    try {
      if (Date.now() >= refreshAt) {
        candidates = (await discover()).flatMap(({ files, media, ...gallery }) => {
          const entries = byGallery.get(gallery.id);
          return files.filter(file => !entries?.has(file) || entries.get(file).state === 'retry')
            .map(relative => ({ ...gallery, relative }));
        });
        refreshAt = Date.now() + 60000;
      }
      const candidate = candidates[0];
      if (!candidate) { workerMessage('Queue is clear.'); return; }
      const { dir, relative, name } = candidate;
      const input = path.join(dir, relative);
      if (!await collections.exactFile(dir, relative)) { candidates.shift(); return; }
      const before = await stat(input);
      if (!before) { candidates.shift(); return; }
      const disk = await fs.statfs(dataRoot);
      const retained = [...records.values()].reduce((total, record) => total + (['retained', 'publishing', 'restoring', 'cleaning'].includes(record.state) ? record.originalBytes : 0), 0);
      if (disk.bavail * disk.bsize - before.size * 3 < minFree) { workerMessage('Paused at the free-space floor.'); return; }
      if (retained + before.size > maxRetained) { workerMessage('Paused at the retained originals limit. Review completed galleries to free space.'); return; }
      if (before.dev !== (await fs.stat(originals)).dev) { workerMessage('Gallery and migration folders must be on the same filesystem.'); return; }
      const galleryId = candidate.id || await publish(async () => {
        if (!await stat(input)) return;
        return collections.ensureGalleryId(dir);
      });
      if (!galleryId) return;
      const existing = byGallery.get(galleryId)?.get(relative);
      if (existing && existing.state !== 'retry') { candidates.shift(); return; }
      const key = keyFor(galleryId, relative);
      current = { galleryId, name, relative, stage: 'Preparing', startedAt: new Date().toISOString() };
      message = '';
      log('info', 'started', { album: name, file: relative });
      temp = await fs.mkdtemp(path.join(work, 'item-'));
      const output = path.join(temp, 'encoded.jxl');
      const record = { key, galleryId, name, relative, originalBytes: before.size, originalAllocated: before.blocks * 512, at: new Date().toISOString() };
      if (before.nlink !== 1) {
        await save({ ...record, state: 'skipped', message: 'The original has multiple hard links.' });
        candidates.shift();
        return;
      }
      let originalHash, result;
      try {
        originalHash = await verifyJpeg(input, output, path.join(temp, 'verify.jpg'), run, stage => { current.stage = stage; });
        result = await stat(output);
      } catch (error) {
        if (['ENOENT', 'ENOSPC'].includes(error.code)) {
          retryAt = Date.now() + 30000;
          workerMessage(error.code === 'ENOSPC' ? 'Paused because the disk is full.' : 'Waiting for the JPEG XL tools or source file.', 'error');
          return;
        }
        await save({ ...record, state: 'failed', message: 'JPEG XL encoder or reconstruction verification failed.' });
        candidates.shift();
        return;
      }
      if (!result || result.size >= before.size) {
        await save({ ...record, state: 'skipped', message: 'JPEG XL was not smaller.' });
        candidates.shift();
        return;
      }
      const encoded = input + suffix;
      const next = { ...record, state: 'publishing', originalHash, encodedHash: await sha256(output), encodedBytes: result.size, encodedAllocated: result.blocks * 512, convertedAt: new Date().toISOString() };
      await publish(async () => {
        if (!enabled) return;
        if (await collections.readGalleryId(dir) !== galleryId || !await collections.exactFile(dir, relative)) {
          candidates.shift();
          return;
        }
        const latest = await stat(input);
        if (!latest || latest.nlink !== 1 || latest.dev !== before.dev || latest.ino !== before.ino ||
            await sha256(input) !== originalHash) { candidates.shift(); return; }
        if (await stat(encoded)) {
          await save({ ...record, state: 'failed', message: 'A JPEG XL file already exists at the destination.' });
          candidates.shift();
          return;
        }
        await fs.mkdir(path.dirname(retainedFile(next)), { recursive: true, mode: 0o700 });
        current.stage = 'Publishing verified JPEG XL';
        await save(next);
        await sync(input);
        await sync(output);
        await fs.link(input, retainedFile(next));
        await sync(path.dirname(retainedFile(next)));
        await sync(originals);
        await fs.link(output, encoded);
        await sync(path.dirname(encoded));
        // Both destination files exist before the live JPEG is removed.
        await fs.unlink(input);
        await sync(path.dirname(input));
        await save({ ...next, state: 'retained' });
        candidates.shift();
      });
    } catch (error) {
      workerMessage('Migration stopped: ' + error.message, 'error');
      enabled = false;
      await write(settings, { enabled }).catch(() => {});
    } finally {
      if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
      if (current) changed();
      current = null;
      busy = false;
      conversionFinished?.();
      conversionFinished = undefined;
    }
  }

  async function galleryCounts(media, records) {
    const counts = { images: 0, retained: 0, other: 0, videos: 0, pending: 0, skipped: 0, failed: 0, restored: 0, removed: 0, needsAttention: 0 };
    const available = new Set(media);
    for (const relative of media) {
      if (/\.webm$/i.test(relative)) { counts.videos++; continue; }
      counts.images++;
      const state = records.get(logicalPath(relative))?.state;
      if (isMigrated(relative)) {
        if (state === 'removed') counts.removed++;
        else if (state !== 'retained') counts.needsAttention++;
      } else if (!isJpeg(relative)) counts.other++;
      else if (state === 'failed' || state === 'skipped' || state === 'restored') counts[state]++;
      else if (!state || state === 'retry') counts.pending++;
      else counts.needsAttention++;
    }
    let blocked = false;
    for (const record of records.values()) {
      if (record.state !== 'retained') continue;
      if (await stat(retainedFile(record)).catch(() => null)) {
        counts.retained++;
        if (!available.has(record.relative + suffix)) {
          blocked = true;
          if (!available.has(record.relative)) counts.needsAttention++;
        }
      } else {
        counts.needsAttention++;
        blocked = true;
      }
    }
    const readiness = blocked ? 'blocked' : counts.pending ? 'queued' : counts.needsAttention ? 'attention'
      : counts.retained ? 'ready' : 'complete';
    return { counts, readiness };
  }

  async function report() {
    const locations = await collections.locations(galleryRoot, trashRoot);
    const inventory = await discover();
    const disk = await fs.statfs(dataRoot);
    const totals = totalsFor();
    const galleries = [];
    const live = new Map(inventory.map(gallery => [gallery.name, gallery]));
    for (const gallery of inventory) {
      if (gallery.id && byGallery.has(gallery.id)) continue;
      const status = await galleryCounts(gallery.media || gallery.files, new Map());
      galleries.push({ id: gallery.id, name: gallery.name, active: true, totals: totalsFor(), review: null, files: [], ...status });
    }
    for (const [id, entries] of byGallery) {
      const match = locations.get(id);
      const active = match?.length === 1 && match[0].state === 'available';
      const records = [...entries.values()];
      const eligible = records.filter(record => record.state === 'retained');
      const galleryTotals = totalsFor();
      const files = records.map(record => {
        if (record.state === 'retained' || record.state === 'removed') {
          accumulate(totals, record);
          accumulate(galleryTotals, record);
        }
        return { path: record.relative, state: record.state, originalBytes: record.originalBytes, encodedBytes: record.encodedBytes, at: record.at, convertedAt: record.convertedAt, removedAt: record.removedAt, restoredAt: record.restoredAt, message: record.message };
      });
      const inventoryEntry = active && live.get(match[0].name);
      const status = inventoryEntry ? await galleryCounts(inventoryEntry.media || inventoryEntry.files, entries) : { readiness: 'unavailable' };
      galleries.push({ id, name: match?.length === 1 ? match[0].name : records[0].name, active, totals: galleryTotals,
        review: active && eligible.length && status.readiness !== 'blocked' ? revision(eligible) : null, files, ...status });
    }
    const ready = galleries.filter(gallery => gallery.readiness === 'ready' && gallery.review);
    const pending = galleries.reduce((sum, gallery) => sum + (gallery.counts?.pending || 0), 0);
    const cleanupAll = {
      pending, ids: ready.map(gallery => gallery.id), galleries: ready.length, bytes: ready.reduce((sum, gallery) => sum + gallery.totals.retained, 0),
      revision: ready.length ? cleanupRevision(ready) : null
    };
    return { enabled, current, message, totals, cleanupAll, cleanupJob: cleanupStatus(), free: disk.bavail * disk.bsize, minFree, maxRetained, galleries };
  }

  async function prepareReview(id, version, locations) {
    const selected = [...(byGallery.get(id)?.values() || [])].filter(record => record.state === 'retained');
    if (!selected.length || version !== revision(selected)) throw new Error('The review has changed. Refresh the report before retrying.');
    const matches = locations.get(id) || [];
    if (matches.length !== 1 || matches[0].state !== 'available') throw new Error('The gallery must be available to review originals.');
    const dir = matches[0].dir;
    for (const record of selected) {
      const input = path.join(dir, record.relative);
      const relative = record.relative + suffix;
      if (!await collections.exactFile(dir, relative) || await stat(input) ||
          (await stat(retainedFile(record)))?.nlink !== 1 || await sha256(input + suffix) !== record.encodedHash ||
          await sha256(retainedFile(record)) !== record.originalHash) {
        throw new Error('A reviewed file is missing or has changed: ' + record.relative);
      }
    }
    return { selected, dir };
  }

  async function applyReview({ selected, dir }, action, onFile = () => {}) {
    const at = new Date().toISOString();
    for (const record of selected) {
      const retained = retainedFile(record);
      if (action === 'restore') {
        const input = path.join(dir, record.relative);
        await save({ ...record, state: 'restoring', restoredAt: at });
        await fs.link(retained, input);
        await sync(path.dirname(input));
        await fs.unlink(input + suffix);
        await sync(path.dirname(input));
        await fs.unlink(retained);
        await sync(path.dirname(retained));
        await save({ ...record, state: 'restored' });
      } else {
        await save({ ...record, state: 'cleaning', cleanupStartedAt: at });
        await fs.unlink(retained);
        await sync(path.dirname(retained));
        await save({ ...record, state: 'removed', removedAt: at });
      }
      onFile();
    }
  }

  async function withReview(operation) {
    if (busy) throw new Error('Wait for the current file to finish, or pause the worker and try again.');
    busy = true;
    try {
      return await operation();
    } catch (error) {
      if ([...records.values()].some(record => ['cleaning', 'restoring'].includes(record.state))) {
        enabled = false;
        workerMessage('Review interrupted. Restart ImageWorks to recover.', 'error');
        await write(settings, { enabled }).catch(() => {});
      } else workerMessage(error.message, 'error');
      throw error;
    } finally { busy = false; changed(); }
  }

  async function review(id, version, action) {
    return withReview(async () => {
      const selection = await prepareReview(id, version, await collections.locations(galleryRoot, trashRoot));
      await applyReview(selection, action);
      refreshAt = 0;
      message = action === 'restore' ? 'Retained originals restored.' : 'Reviewed originals removed.';
    });
  }

  async function cleanupAll(version, ids, exclusive = operation => operation()) {
    if (cleanupJob?.status === 'working') throw new Error('Bulk cleanup is already running.');
    const job = cleanupJob = {
      id: ++cleanupSequence, status: 'working', phase: 'preparing', total: 0,
      verified: 0, cleaned: 0, files: 0, gallery: null
    };
    try {
      if (busy) {
        job.phase = 'waiting';
        await new Promise(resolve => { conversionFinished = resolve; });
      }
      job.phase = 'preparing';
      const result = await exclusive(() => withReview(async () => {
        const snapshot = await report();
        const wanted = ids && new Set(ids);
        const ready = snapshot.galleries.filter(gallery => gallery.readiness === 'ready' && gallery.review &&
          (!wanted || wanted.has(gallery.id)));
        if (!ready.length || (wanted && ready.length !== wanted.size) || version !== cleanupRevision(ready)) {
          throw new Error('The galleries ready for cleanup have changed. Refresh the report before retrying.');
        }
        const locations = await collections.locations(galleryRoot, trashRoot);
        Object.assign(job, { phase: 'verifying', total: ready.length });
        workerMessage('Checking retained originals for Cleanup All.');
        const selections = [];
        for (const gallery of ready) {
          job.gallery = gallery.name;
          selections.push(await prepareReview(gallery.id, gallery.review, locations));
          job.verified++;
        }
        job.phase = 'cleaning';
        workerMessage('Removing verified originals for Cleanup All.');
        for (const [index, selection] of selections.entries()) {
          job.gallery = ready[index].name;
          await applyReview(selection, 'cleanup', () => { job.files++; });
          job.cleaned++;
        }
        refreshAt = 0;
        workerMessage('Cleanup All finished.');
        return { galleries: job.cleaned, files: job.files };
      }));
      Object.assign(job, { status: 'success', gallery: null });
      return result;
    } catch (error) {
      Object.assign(job, { status: 'error', error: error.message });
      throw error;
    }
  }

  async function matchesOriginal(galleryId, relative, file) {
    const entry = byGallery.get(galleryId)?.get(relative);
    return Boolean(entry?.originalHash && (await stat(file))?.size === entry.originalBytes && await sha256(file) === entry.originalHash);
  }

  return { originals, load, tick, summary, report, monitor, review, cleanupAll, cleanupStatus, isConverting: () => Boolean(current), setEnabled, matchesOriginal };
}

module.exports = { createMigration };
