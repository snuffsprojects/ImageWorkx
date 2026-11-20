const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && path.basename(name) === name && !name.includes('\\');
}
async function realDir(dir) {
  try { const stat = await fs.lstat(dir); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function ensureTrash(root) {
  await fs.mkdir(root, { recursive: true });
  if (!await realDir(root)) throw new Error('Trash must be a real directory.');
}
async function sizeOf(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await sizeOf(file);
    else if (entry.isFile()) total += (await fs.lstat(file)).size;
  }
  return total;
}
async function readEntry(root, id) {
  if (typeof id !== 'string' || !idPattern.test(id) || !await realDir(root)) throw new Error('Invalid trash entry.');
  const dir = path.join(root, id);
  if (!await realDir(dir) || !await realDir(path.join(dir, 'gallery'))) throw new Error('Trash entry not found.');
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'info.json'), 'utf8'));
  if (!validName(meta.name) || typeof meta.trashedAt !== 'string') throw new Error('Invalid trash metadata.');
  return { dir, meta };
}
async function moveToTrash(galleryRoot, trashRoot, name) {
  if (!validName(name)) throw new Error('Invalid gallery name.');
  if (!await realDir(galleryRoot) || !await realDir(path.join(galleryRoot, name))) throw new Error('Gallery not found.');
  await ensureTrash(trashRoot);
  const id = randomUUID(), dir = path.join(trashRoot, id);
  await fs.mkdir(dir);
  let moved = false;
  try {
    const meta = { name, trashedAt: new Date().toISOString() };
    await fs.writeFile(path.join(dir, 'info.json'), JSON.stringify(meta));
    await fs.rename(path.join(galleryRoot, name), path.join(dir, 'gallery'));
    moved = true;
    return { id, ...meta };
  } finally {
    if (!moved) await fs.rm(dir, { recursive: true, force: true });
  }
}
async function listTrash(root) {
  if (!await realDir(root)) return [];
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
    try {
      const { dir, meta } = await readEntry(root, entry.name);
      result.push({ id: entry.name, ...meta, sizeBytes: await sizeOf(path.join(dir, 'gallery')) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
}
async function restoreTrash(galleryRoot, trashRoot, id) {
  const { dir, meta } = await readEntry(trashRoot, id);
  if (!await realDir(galleryRoot)) throw new Error('Gallery folder is unavailable.');
  const target = path.join(galleryRoot, meta.name);
  try { await fs.mkdir(target); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('A gallery with that name already exists. Rename it before restoring.'); throw error; }
  try { await fs.rename(path.join(dir, 'gallery'), target); }
  catch (error) { await fs.rmdir(target).catch(() => {}); throw error; }
  // Once restored, a failed metadata cleanup must not report the restore as failed.
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return meta;
}
async function deleteTrash(trashRoot, id) {
  const { dir, meta } = await readEntry(trashRoot, id);
  await fs.rm(dir, { recursive: true });
  return meta;
}
module.exports = { moveToTrash, listTrash, restoreTrash, deleteTrash };
