const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const collections = require('./collections');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validName(name) { return typeof name === 'string' && name && name !== '.' && name !== '..' && path.basename(name) === name && !name.includes('\\'); }
async function directory(dir) { try { const stat = await fs.lstat(dir); return stat.isDirectory() && !stat.isSymbolicLink(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function readEntry(root, id) {
  if (!UUID.test(id || '') || !await directory(root)) throw new Error('Invalid Image Trash entry.');
  const wrapper = path.join(root, id);
  if (!await directory(wrapper)) throw new Error('Image Trash entry not found.');
  const metadata = path.join(wrapper, 'info.json'), metaStat = await fs.lstat(metadata);
  if (!metaStat.isFile() || metaStat.isSymbolicLink()) throw new Error('Invalid Image Trash metadata.');
  const info = JSON.parse(await fs.readFile(metadata, 'utf8'));
  if (!UUID.test(info.galleryId || '') || !validName(info.sourceName) || !collections.validRelative(info.path) || typeof info.trashedAt !== 'string') throw new Error('Invalid Image Trash metadata.');
  let stat = null;
  try { stat = await fs.lstat(path.join(wrapper, 'media')); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid trashed file.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let deleted = false;
  try { const marker = await fs.lstat(path.join(wrapper, 'deleted')); if (!marker.isFile() || marker.isSymbolicLink()) throw new Error('Invalid deletion record.'); deleted = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { id, wrapper, info, stat, deleted };
}
async function entries(root) {
  if (!await directory(root)) return [];
  const result = [];
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    if (!item.isDirectory() || !UUID.test(item.name)) continue;
    try { const entry = await readEntry(root, item.name); if (entry.stat || entry.deleted) result.push(entry); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}
async function references(root) {
  const result = new Map();
  for (const entry of await entries(root)) {
    const key = `${entry.info.galleryId}\0${entry.info.path}`;
    if (entry.stat) result.set(key, 'image-trashed');
    else if (entry.deleted && !result.has(key)) result.set(key, 'image-deleted');
  }
  return result;
}
async function reservedPaths(root, galleryId) {
  if (!galleryId) return new Set();
  const result = new Set();
  for (const entry of await entries(root)) if (entry.info.galleryId === galleryId) result.add(entry.info.path);
  return result;
}
async function move(galleryRoot, root, album, relative) {
  if (!validName(album) || !collections.validRelative(relative)) throw new Error('Invalid gallery or file.');
  const dir = path.join(galleryRoot, album);
  if (!await collections.regularFile(dir, relative)) throw new Error('The source file is no longer available.');
  const galleryId = await collections.ensureGalleryId(dir);
  await fs.mkdir(root, { recursive: true });
  if (!await directory(root)) throw new Error('Image Trash must be a real directory.');
  const id = randomUUID(), wrapper = path.join(root, id);
  await fs.mkdir(wrapper);
  let moved = false;
  try {
    const info = { galleryId, sourceName: album, path: relative, trashedAt: new Date().toISOString() };
    await fs.writeFile(path.join(wrapper, 'info.json'), JSON.stringify(info), { flag: 'wx' });
    await fs.rename(path.join(dir, ...relative.split('/')), path.join(wrapper, 'media'));
    moved = true; return { id, ...info };
  } finally { if (!moved) await fs.rm(wrapper, { recursive: true, force: true }); }
}
async function list(root, galleryRoot, trashRoot) {
  const all = await entries(root), locations = await collections.locations(galleryRoot, trashRoot);
  return all.map(entry => {
    const found = locations.get(entry.info.galleryId) || [];
    const source = found.length === 1 ? found[0] : null;
    return { id: entry.id, name: path.basename(entry.info.path).replace(/\.jxl$/i, ''), sourceName: source?.name || entry.info.sourceName,
      galleryState: found.length > 1 ? 'conflict' : source?.state || 'missing', trashedAt: entry.info.trashedAt, sizeBytes: entry.stat?.size || 0, deleted: !entry.stat, downloadName: path.basename(entry.info.path) };
  }).sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
}
async function restore(galleryRoot, trashRoot, root, id) {
  const entry = await readEntry(root, id);
  if (!entry.stat) throw new Error('This file was permanently deleted.');
  if ((await entries(root)).some(other => other.id !== id && other.info.galleryId === entry.info.galleryId && other.info.path === entry.info.path)) throw new Error('Another Image Trash entry has the same original location; resolve it before restoring.');
  const matches = (await collections.locations(galleryRoot, trashRoot)).get(entry.info.galleryId) || [];
  if (matches.length !== 1) throw new Error(matches.length ? 'The gallery identity is duplicated; resolve it before restoring.' : 'The original gallery was not found.');
  if (matches[0].state !== 'available') throw new Error('Restore the source gallery from Gallery Trash first.');
  let dir = matches[0].dir;
  const parts = entry.info.path.split('/'), filename = parts.pop();
  for (const part of parts) {
    dir = path.join(dir, part);
    try { await fs.mkdir(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!await directory(dir)) throw new Error('The original folder is not a real directory.');
  }
  const source = path.join(entry.wrapper, 'media'), destination = path.join(dir, filename);
  try { await fs.link(source, destination); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const present = await fs.lstat(destination);
    if (!present.isFile() || present.isSymbolicLink() || present.ino !== entry.stat.ino || present.dev !== entry.stat.dev) throw new Error('A file already exists at the original location. Move it elsewhere before restoring.');
  }
  await fs.unlink(source);
  await fs.rm(entry.wrapper, { recursive: true, force: true }).catch(() => {});
  return entry.info;
}
async function deleteMedia(root, id) {
  const entry = await readEntry(root, id);
  if (!entry.stat) throw new Error('This file was already permanently deleted.');
  try { await fs.writeFile(path.join(entry.wrapper, 'deleted'), '', { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await fs.unlink(path.join(entry.wrapper, 'media'));
  return entry.info;
}
async function forget(root, id) {
  const entry = await readEntry(root, id);
  if (entry.stat || !entry.deleted) throw new Error('Permanently delete or restore the file first.');
  await fs.rm(entry.wrapper, { recursive: true }); return entry.info;
}
async function file(root, id) { const entry = await readEntry(root, id); if (!entry.stat) throw new Error('This file was permanently deleted.'); return { dir: entry.wrapper, name: path.basename(entry.info.path) }; }
module.exports = { move, list, restore, deleteMedia, forget, file, references, reservedPaths };
