const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MANUAL = '.imageworks-manual.json';
const COVER = '.imageworks-cover.json';
const MAX_UPLOAD = 100 * 1024 * 1024;
const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff']);
function validAlbum(name) { return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && path.basename(name) === name && !name.includes('\\'); }
async function albumDirectory(root, name) {
  if (!validAlbum(name)) throw new Error('Invalid gallery.');
  const dir = path.join(root, name);
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Gallery not found.');
  return dir;
}
async function manualGallery(dir) {
  try { const stat = await fs.lstat(path.join(dir, MANUAL)); return stat.isFile() && !stat.isSymbolicLink(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function createGallery(root, name) {
  if (!validAlbum(name)) throw new Error('Invalid gallery name.');
  const dir = path.join(root, name);
  await fs.mkdir(dir);
  try { await fs.writeFile(path.join(dir, MANUAL), JSON.stringify({ version: 1 }), { flag: 'wx' }); }
  catch (error) { await fs.rm(path.join(dir, MANUAL), { force: true }).catch(() => {}); await fs.rmdir(dir).catch(() => {}); throw error; }
  return name;
}
function matchesImage(name, bytes) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (ext === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (ext === '.gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  if (ext === '.webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (ext === '.avif') {
    if (bytes.subarray(4, 8).toString('ascii') !== 'ftyp') return false;
    for (let offset = 8; offset + 4 <= bytes.length; offset += 4) if (offset !== 12 && ['avif', 'avis'].includes(bytes.subarray(offset, offset + 4).toString('ascii'))) return true;
    return false;
  }
  if (ext === '.bmp') return bytes.subarray(0, 2).toString('ascii') === 'BM';
  if (ext === '.tif' || ext === '.tiff') return ['49492a00', '4d4d002a', '49492b00', '4d4d002b'].includes(bytes.subarray(0, 4).toString('hex'));
  return false;
}
async function upload(root, album, name, length, stream, reserved = new Set()) {
  if (typeof name !== 'string' || !name || name.startsWith('.') || path.basename(name) !== name || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 180 || !EXTENSIONS.has(path.extname(name).toLowerCase())) throw new Error('Choose a supported image with a valid filename.');
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_UPLOAD) throw new Error('Images must be between 1 byte and 100 MB.');
  const dir = await albumDirectory(root, album);
  const temp = path.join(dir, `.imageworks-upload-${randomUUID()}.tmp`);
  let handle, count = 0;
  try {
    handle = await fs.open(temp, 'wx');
    for await (const chunk of stream) {
      count += chunk.length;
      if (count > length || count > MAX_UPLOAD) throw new Error('Upload exceeds the stated size.');
      let offset = 0;
      while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
    }
    await handle.close(); handle = null;
    if (count !== length) throw new Error('Upload was incomplete.');
    const input = await fs.open(temp, 'r');
    let header;
    try { const buffer = Buffer.alloc(256); const result = await input.read(buffer, 0, buffer.length, 0); header = buffer.subarray(0, result.bytesRead); }
    finally { await input.close(); }
    if (!matchesImage(name, header)) throw new Error('The file contents do not match a supported image format.');
    const ext = path.extname(name), stem = name.slice(0, -ext.length);
    for (let n = 1; ; n++) {
      const chosen = n === 1 ? name : `${stem} (${n})${ext}`;
      if (reserved.has(chosen)) continue;
      try { await fs.link(temp, path.join(dir, chosen)); return { name: chosen, sizeBytes: count }; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  } finally { if (handle) await handle.close().catch(() => {}); await fs.rm(temp, { force: true }).catch(() => {}); }
}
function validCoverPath(value) { return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !path.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..') && /\.(?:jpe?g|png|gif|webp|avif|bmp|tiff?|jpe?g\.jxl)$/i.test(value); }
async function readCover(dir) {
  try {
    const file = path.join(dir, COVER), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Cover metadata is not a regular file.');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || !validCoverPath(value.path)) throw new Error('Invalid cover metadata.');
    return value.path;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function setCover(root, album, relative, images) {
  const dir = await albumDirectory(root, album);
  if (!validCoverPath(relative) || !images.some(file => path.relative(dir, file).split(path.sep).join('/') === relative && path.extname(file).toLowerCase() !== '.webm')) throw new Error('Choose an image from this gallery.');
  const file = path.join(dir, COVER), temp = path.join(dir, `.imageworks-cover-${randomUUID()}.tmp`);
  try { await fs.writeFile(temp, JSON.stringify({ path: relative }), { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
module.exports = { MANUAL, COVER, MAX_UPLOAD, EXTENSIONS, validCoverPath, albumDirectory, manualGallery, createGallery, upload, readCover, setCover };
