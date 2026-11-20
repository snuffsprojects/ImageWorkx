const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const run = require('node:util').promisify(require('node:child_process').execFile);

const fallbackPoster = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300"><rect width="480" height="300" fill="#11151a"/><path d="M210 100v100l85-50z" fill="#ff6b35"/><text x="240" y="260" text-anchor="middle" fill="#919aa6" font-family="sans-serif" font-size="20">WEBM</text></svg>';

// Serialize generation so a grid full of videos cannot launch many FFmpeg processes.
function createPosterCache(cacheDir, generate = run) {
  const pending = new Map();
  const failed = new Set();
  let queue = Promise.resolve();
  return async function poster(file, stat) {
    const key = createHash('sha256').update(`${file}:${stat.size}:${stat.mtimeMs}`).digest('hex');
    const destination = path.join(cacheDir, key + '.jpg');
    try { await fs.access(destination); return destination; } catch {}
    if (failed.has(key)) return null;
    if (!pending.has(key)) {
      const job = queue.then(async () => {
        const temp = destination + '.tmp.jpg';
        try {
          await fs.mkdir(cacheDir, { recursive: true });
          await generate('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', temp], { timeout: 20000 });
          if (!(await fs.stat(temp)).size) throw new Error('Empty poster');
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
  };
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end || (!match[1] && Number(match[2]) === 0)) return null;
  return { start, end: Math.min(end, size - 1) };
}
module.exports = { createPosterCache, fallbackPoster, parseRange };
