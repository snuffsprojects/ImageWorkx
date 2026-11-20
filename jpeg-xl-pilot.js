const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function createPilot({ galleryRoot, dataRoot, albumId, onProgress = () => {}, run = execFile }) {
  if (typeof albumId !== 'string' || !albumId || albumId === '.' || albumId === '..' || path.basename(albumId) !== albumId || albumId.includes('\\')) throw new Error('Invalid gallery.');
  const source = path.join(galleryRoot, albumId);
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('Gallery not found.');
  const staging = path.join(dataRoot, `.jxl-pilot-${randomUUID()}`);
  const work = path.join(dataRoot, `.jxl-work-${randomUUID()}`);
  let published = false;
  try {
    await fs.mkdir(staging);
    await fs.mkdir(work);
    const files = [];
    async function collect(dir, relative = '') {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const rel = path.join(relative, entry.name);
        if (entry.isDirectory()) await collect(path.join(dir, entry.name), rel);
        else if (entry.isFile() && /\.(jpe?g|png|webp|gif|avif|bmp|tiff?|webm)$/i.test(entry.name)) files.push(rel);
      }
    }
    await collect(source);
    const jpgCount = files.filter(name => /\.jpe?g$/i.test(name)).length;
    if (!jpgCount) throw new Error('This gallery has no JPEG images to convert.');
    let done = 0, inputBytes = 0, outputBytes = 0;
    for (const rel of files) {
      const input = path.join(source, rel);
      const jpeg = /\.jpe?g$/i.test(rel);
      const output = path.join(staging, jpeg ? `${rel}.jxl` : rel);
      await fs.mkdir(path.dirname(output), { recursive: true });
      if (!jpeg) { await fs.copyFile(input, output, fs.constants.COPYFILE_EXCL); continue; }
      const reconstructed = path.join(work, 'verify.jpg');
      const before = await sha256(input);
      const stat = await fs.stat(input);
      await run(process.env.IMAGEWORKS_CJXL || 'cjxl', [input, output, '--lossless_jpeg=1', '--num_threads=1', '--quiet'], { timeout: 120000 });
      await run(process.env.IMAGEWORKS_DJXL || 'djxl', [output, reconstructed, '--num_threads=1', '--quiet'], { timeout: 120000 });
      if (before !== await sha256(reconstructed) || before !== await sha256(input)) throw new Error(`Verification failed or source changed: ${rel}`);
      await fs.unlink(reconstructed);
      inputBytes += stat.size;
      outputBytes += (await fs.stat(output)).size;
      onProgress({ done: ++done, total: jpgCount, inputBytes, outputBytes });
    }
    let name = `${albumId} [JPEG XL pilot]`;
    for (let n = 2; ; n++) {
      try { await fs.mkdir(path.join(galleryRoot, name)); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; name = `${albumId} [JPEG XL pilot ${n}]`; }
    }
    const destination = path.join(galleryRoot, name);
    try { await fs.rename(staging, destination); published = true; }
    catch (error) { await fs.rmdir(destination).catch(() => {}); throw error; }
    return { name, total: jpgCount, inputBytes, outputBytes };
  } finally {
    if (!published) await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  }
}
module.exports = { createPilot };
