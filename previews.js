const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const run = require('node:util').promisify(require('node:child_process').execFile);

function createPreviewCache(cacheDir, generate = run) {
  const pending = new Map();
  const failed = new Set();
  let queue = Promise.resolve();
  async function preview(file, stat) {
    const key = createHash('sha256').update(`${file}:${stat.size}:${stat.mtimeMs}`).digest('hex');
    const destination = path.join(cacheDir, `${key}.jpg`);
    try { await fs.access(destination); return destination; } catch {}
    if (failed.has(key)) return null;
    if (!pending.has(key)) {
      const job = queue.then(async () => {
        const temp = destination + '.tmp.jpg';
        try {
          await fs.mkdir(cacheDir, { recursive: true });
          await generate('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', file, '-frames:v', '1', '-vf', 'scale=480:480:force_original_aspect_ratio=decrease', temp], { timeout: 20000 });
          if (!(await fs.stat(temp)).size) throw new Error('Empty preview');
          await fs.rename(temp, destination);
          return destination;
        } catch {
          failed.add(key);
          return null;
        } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
      });
      pending.set(key, job);
      queue = job.catch(() => {});
      job.finally(() => pending.delete(key));
    }
    return pending.get(key);
  }
  return preview;
}

// Discard old previews; an image requested later is regenerated on demand.
async function cleanPreviews(cacheDir, maxAgeMs = 30 * 86400000) {
  let entries;
  try { entries = await fs.readdir(cacheDir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await Promise.all(entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.jpg$/.test(entry.name)).map(async entry => {
    const file = path.join(cacheDir, entry.name);
    try { if (Date.now() - (await fs.stat(file)).mtimeMs > maxAgeMs) await fs.rm(file, { force: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }));
}
module.exports = { createPreviewCache, cleanPreviews };
