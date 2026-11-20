const fs = require('node:fs/promises');
const path = require('node:path');

async function realDirectory(dir) {
  try { const stat = await fs.lstat(dir); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function entries(dir) {
  if (!await realDirectory(dir)) return [];
  return fs.readdir(dir, { withFileTypes: true });
}
async function sizeOf(dir) {
  let size = 0, files = 0;
  for (const entry of await entries(dir)) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { const child = await sizeOf(file); size += child.size; files += child.files; }
    else if (entry.isFile()) {
      try { size += (await fs.lstat(file)).size; files++; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return { size, files };
}
async function listDownloadCache(root) {
  const result = [];
  for (const category of await entries(root)) {
    if (!category.isDirectory() || !(category.name === 'GoonBox' || /^[a-z0-9]+$/.test(category.name))) continue;
    const parent = path.join(root, category.name);
    for (const item of await entries(parent)) {
      if (!item.isDirectory() || (category.name !== 'GoonBox' && !/^\d+$/.test(item.name))) continue;
      const folder = path.join(parent, item.name);
      const [usage, stat] = await Promise.all([sizeOf(folder), fs.lstat(folder)]);
      result.push({ id: `${category.name}/${item.name}`, source: category.name === 'GoonBox' ? 'GoonBox' : `4chan /${category.name}/`, name: item.name, sizeBytes: usage.size, files: usage.files, modifiedAt: stat.mtime.toISOString() });
    }
  }
  return result.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
async function removeDownloadCache(root, id) {
  if (typeof id !== 'string') throw new Error('Invalid cache entry.');
  const parts = id.split('/');
  if (parts.length !== 2 || !parts[1] || parts[1] === '.' || parts[1] === '..' || parts[1].includes('\\') || !(parts[0] === 'GoonBox' || (/^[a-z0-9]+$/.test(parts[0]) && /^\d+$/.test(parts[1])))) throw new Error('Invalid cache entry.');
  const parent = path.join(root, parts[0]);
  const folder = path.join(parent, parts[1]);
  if (!await realDirectory(root) || !await realDirectory(parent) || !await realDirectory(folder)) throw new Error('Cache entry no longer exists.');
  await fs.rm(folder, { recursive: true });
}
module.exports = { listDownloadCache, removeDownloadCache };
