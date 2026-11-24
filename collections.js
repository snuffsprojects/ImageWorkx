const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isMigrated, physicalPath } = require('./jpeg-xl-paths');
const FILE = '.imageworks-collections.json';
const GALLERY_ID = '.imageworks-gallery-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA = /\.(?:jpe?g|png|gif|webp|avif|bmp|tiff?|webm|jpe?g(?:\.imageworks)?\.jxl)$/i;
function validName(name) { return typeof name === 'string' && name && name !== '.' && name !== '..' && path.basename(name) === name && !name.includes('\\'); }
function validRelative(rel) { return typeof rel === 'string' && rel.length > 0 && !rel.includes('\\') && !path.isAbsolute(rel) && rel.split('/').every(p => p && p !== '.' && p !== '..') && MEDIA.test(rel); }
async function directory(dir) { try { const s = await fs.lstat(dir); return s.isDirectory() && !s.isSymbolicLink(); } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function readGalleryId(dir) {
  try {
    const file = path.join(dir, GALLERY_ID), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid gallery identity file.');
    const id = (await fs.readFile(file, 'utf8')).trim();
    if (!UUID.test(id)) throw new Error('Invalid gallery identity.');
    return id;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function ensureGalleryId(dir) {
  let id = await readGalleryId(dir);
  if (id) return id;
  id = randomUUID();
  try { await fs.writeFile(path.join(dir, GALLERY_ID), id + '\n', { flag: 'wx' }); return id; }
  catch (error) { if (error.code === 'EEXIST') return readGalleryId(dir); throw error; }
}
async function exactFile(root, relative) {
  if (!validRelative(relative) || !await directory(root)) return false;
  let current = root;
  const parts = relative.split('/');
  try {
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) return false;
    }
    return true;
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}
async function regularFile(root, relative) {
  if (!validRelative(relative)) return false;
  const file = await physicalPath(path.join(root, relative));
  return exactFile(root, path.relative(root, file).split(path.sep).join('/'));
}
async function read(root) {
  let data;
  try { data = JSON.parse(await fs.readFile(path.join(root, FILE), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return [{ id: 'favourites', name: 'Favourites', items: [] }]; throw error; }
  if (!Array.isArray(data) || data.some(c => !c || typeof c.id !== 'string' || typeof c.name !== 'string' || !Array.isArray(c.items)) || !data.some(c => c.id === 'favourites')) throw new Error('Collection data is invalid.');
  return data;
}
async function write(root, data) {
  const dest = path.join(root, FILE), temp = `${dest}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(data, null, 2), { flag: 'wx' }); await fs.rename(temp, dest); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
function getCollection(data, id) { const c = data.find(x => x.id === id); if (!c) throw new Error('Collection not found.'); return c; }
async function create(root, value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Collection names must be 1–80 characters.');
  const data = await read(root);
  if (data.some(c => c.name.toLowerCase() === name.toLowerCase())) throw new Error('A collection with that name already exists.');
  const c = { id: randomUUID(), name, items: [] }; data.push(c); await write(root, data); return c;
}
async function addMany(root, galleryRoot, collectionId, album, paths) {
  if (!validName(album) || !Array.isArray(paths) || !paths.length || paths.length > 500 || paths.some(rel => !validRelative(rel))) throw new Error('Select between 1 and 500 valid images.');
  const unique = [...new Set(paths)], source = path.join(galleryRoot, album);
  for (const relative of unique) if (!await regularFile(source, relative)) throw new Error('A source image is no longer available; nothing was added.');
  const data = await read(root), collection = getCollection(data, collectionId);
  const galleryId = await ensureGalleryId(source);
  let added = 0;
  for (const relative of unique) {
    if (collection.items.some(item => item.galleryId === galleryId && item.path === relative)) continue;
    collection.items.push({ id: randomUUID(), galleryId, sourceName: album, path: relative }); added++;
  }
  if (added) await write(root, data);
  return { added, alreadyAdded: unique.length - added };
}
async function add(root, galleryRoot, collectionId, album, relative) {
  const result = await addMany(root, galleryRoot, collectionId, album, [relative]);
  return { alreadyAdded: result.added === 0 };
}
async function noteRenamed(root, galleryDir, name) {
  const galleryId = await readGalleryId(galleryDir);
  if (!galleryId) return;
  const data = await read(root);
  let changed = false;
  for (const collection of data) for (const item of collection.items) if (item.galleryId === galleryId && item.sourceName !== name) { item.sourceName = name; changed = true; }
  if (changed) await write(root, data);
}
async function remove(root, collectionId, itemId) {
  const data = await read(root), collection = getCollection(data, collectionId);
  const index = collection.items.findIndex(item => item.id === itemId);
  if (index < 0) throw new Error('Collection item not found.');
  collection.items.splice(index, 1); await write(root, data);
}
async function removeCollection(root, id) {
  if (id === 'favourites') throw new Error('Favourites cannot be deleted.');
  const data = await read(root); getCollection(data, id);
  await write(root, data.filter(c => c.id !== id));
}
async function locations(galleryRoot, trashRoot) {
  const map = new Map();
  function add(id, location) { if (!map.has(id)) map.set(id, []); map.get(id).push(location); }
  if (await directory(galleryRoot)) for (const entry of await fs.readdir(galleryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(galleryRoot, entry.name), id = await readGalleryId(dir);
    if (id) add(id, { dir, name: entry.name, state: 'available' });
  }
  if (await directory(trashRoot)) for (const entry of await fs.readdir(trashRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const wrapper = path.join(trashRoot, entry.name), dir = path.join(wrapper, 'gallery');
    if (!await directory(dir)) continue;
    const id = await readGalleryId(dir); if (!id) continue;
    let name; try { name = JSON.parse(await fs.readFile(path.join(wrapper, 'info.json'), 'utf8')).name; } catch { continue; }
    if (validName(name)) add(id, { dir, name, state: 'trashed' });
  }
  return map;
}
async function detail(root, galleryRoot, trashRoot, id, imageReferences = new Map()) {
  const c = getCollection(await read(root), id), map = await locations(galleryRoot, trashRoot);
  const items = [];
  for (const item of c.items) {
    if (!item || !UUID.test(item.id || '') || !UUID.test(item.galleryId || '') || !validRelative(item.path) || !validName(item.sourceName)) throw new Error('Collection item data is invalid.');
    const matches = map.get(item.galleryId) || [];
    let state = matches.length > 1 ? 'conflict' : matches.length ? matches[0].state : 'missing';
    const match = matches.length === 1 ? matches[0] : null;
    if (state === 'available') {
      const removed = imageReferences.get(`${item.galleryId}\0${item.path}`);
      if (removed) state = removed;
      else if (!await regularFile(match.dir, item.path)) state = 'missing';
    }
    const displayName = path.basename(item.path).replace(/\.jxl$/i, '');
    const output = { id: item.id, state, name: displayName, sourceName: match?.name || item.sourceName, sourceAlbumId: state === 'available' ? match.name : null, relativePath: item.path };
    if (state === 'available') {
      const relative = [match.name, ...item.path.split('/')].map(encodeURIComponent).join('/');
      const video = /\.webm$/i.test(item.path);
      const file = await physicalPath(path.join(match.dir, item.path));
      const jxl = /\.jpe?g\.jxl$/i.test(file) || isMigrated(file);
      Object.assign(output, { type: video ? 'video' : 'image', jxl, poster: video ? `/poster/${relative}` : null, preview: video ? `/poster/${relative}` : `/preview/${relative}`, url: `${jxl ? '/reconstructed/' : '/gallery/'}${relative}` });
    }
    items.push(output);
  }
  return { id: c.id, name: c.name, items };
}
module.exports = { read, create, add, addMany, remove, removeCollection, detail, noteRenamed, validRelative, regularFile, exactFile, readGalleryId, ensureGalleryId, locations, GALLERY_ID, FILE };
