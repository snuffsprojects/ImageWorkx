const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const tags = require('./tags');
const collections = require('./collections');
const galleryMedia = require('./gallery-media');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validName = name => typeof name === 'string' && !!name && name !== '.' && name !== '..' && path.basename(name) === name && !name.includes('\\');
async function directory(dir) { try { const s = await fs.lstat(dir); return s.isDirectory() && !s.isSymbolicLink(); } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function optionalFile(file) {
  try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Metadata is not a regular file: ${path.basename(file)}`); return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function identity(dir) {
  const raw = await optionalFile(path.join(dir, collections.GALLERY_ID));
  if (raw === null) return null;
  const id = raw.trim(); if (!UUID.test(id)) throw new Error('Invalid gallery identity.'); return id;
}
async function assignments(dir) {
  const raw = await optionalFile(path.join(dir, tags.TAG_FILE));
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !UUID.test(id))) throw new Error('Invalid gallery tag metadata.');
  return value;
}
async function roots(galleryRoot, trashRoot) {
  const result = [];
  if (await directory(galleryRoot)) for (const entry of await fs.readdir(galleryRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && validName(entry.name)) result.push({ kind: 'gallery', name: entry.name, dir: path.join(galleryRoot, entry.name) });
  }
  if (await directory(trashRoot)) for (const entry of await fs.readdir(trashRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const wrapper = path.join(trashRoot, entry.name), dir = path.join(wrapper, 'gallery');
    if (!await directory(dir)) continue;
    const raw = await optionalFile(path.join(wrapper, 'info.json')); if (raw === null) continue;
    const info = JSON.parse(raw); if (!validName(info.name)) throw new Error('Invalid Trash metadata.');
    result.push({ kind: 'trash', trashId: entry.name, name: info.name, dir });
  }
  return result;
}
async function capture(root, galleryRoot, trashRoot) {
  const rawTags = await optionalFile(path.join(root, tags.TAG_FILE));
  const rawCollections = await optionalFile(path.join(root, collections.FILE));
  const output = { format: 'imageworks-metadata', version: 1, createdAt: new Date().toISOString(),
    tags: rawTags === null ? null : await tags.library(root), collections: rawCollections === null ? null : await collections.read(root), galleries: [] };
  for (const entry of await roots(galleryRoot, trashRoot)) {
    const id = await identity(entry.dir), tagIds = await assignments(entry.dir);
    const cover = await galleryMedia.readCover(entry.dir), manual = await galleryMedia.manualGallery(entry.dir);
    if (id !== null || tagIds !== null || cover !== null || manual) output.galleries.push({ kind: entry.kind, name: entry.name, trashId: entry.trashId || null, galleryId: id, tagIds, cover, manual });
  }
  validate(output); return output;
}
function validate(data) {
  if (!data || data.format !== 'imageworks-metadata' || data.version !== 1 || !Array.isArray(data.galleries) || data.galleries.length > 100000) throw new Error('Not a supported ImageWorks metadata backup.');
  if (data.tags !== null && (!Array.isArray(data.tags) || data.tags.some(t => !t || !UUID.test(t.id || '') || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 60 || /[\x00-\x1f\x7f]/.test(t.name) || (t.colour !== undefined && !tags.COLOURS.includes(t.colour))))) throw new Error('Invalid tag library in backup.');
  if (data.tags && (new Set(data.tags.map(t => t.id)).size !== data.tags.length || new Set(data.tags.map(t => t.name.toLowerCase())).size !== data.tags.length)) throw new Error('Duplicate tags in backup.');
  if (data.collections !== null) {
    if (!Array.isArray(data.collections) || !data.collections.some(c => c.id === 'favourites') || new Set(data.collections.map(c => c?.id)).size !== data.collections.length) throw new Error('Invalid collections in backup.');
    for (const c of data.collections) {
      if (!c || !(c.id === 'favourites' || UUID.test(c.id || '')) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80 || /[\x00-\x1f\x7f]/.test(c.name) || !Array.isArray(c.items)) throw new Error('Invalid collection in backup.');
      if (new Set(c.items.map(item => item?.id)).size !== c.items.length) throw new Error('Duplicate collection items in backup.');
      for (const i of c.items) if (!i || !UUID.test(i.id || '') || !UUID.test(i.galleryId || '') || !validName(i.sourceName) || typeof i.path !== 'string' || i.path.includes('\\') || path.isAbsolute(i.path) || i.path.split('/').some(part => !part || part === '.' || part === '..') || !/\.(?:jpe?g|png|gif|webp|avif|bmp|tiff?|webm|jpe?g\.jxl)$/i.test(i.path)) throw new Error('Invalid collection item in backup.');
    }
  }
  const keys = new Set(), galleryIds = new Set();
  for (const entry of data.galleries) {
    if (!entry || !['gallery', 'trash'].includes(entry.kind) || !validName(entry.name) || (entry.kind === 'trash' ? !UUID.test(entry.trashId || '') : entry.trashId !== null) || (entry.galleryId !== null && !UUID.test(entry.galleryId || '')) || (entry.tagIds !== null && (!Array.isArray(entry.tagIds) || entry.tagIds.some(id => typeof id !== 'string' || !UUID.test(id))))) throw new Error('Invalid gallery entry in backup.');
    if (entry.cover !== undefined && entry.cover !== null && !galleryMedia.validCoverPath(entry.cover)) throw new Error('Invalid gallery cover in backup.');
    if (entry.manual !== undefined && typeof entry.manual !== 'boolean') throw new Error('Invalid manual gallery marker in backup.');
    const key = entry.kind === 'trash' ? `trash:${entry.trashId}` : `gallery:${entry.name}`;
    if (keys.has(key) || (entry.galleryId && galleryIds.has(entry.galleryId))) throw new Error('Duplicate gallery identity in backup.'); keys.add(key);
    if (entry.galleryId) galleryIds.add(entry.galleryId);
  }
}
async function plan(root, galleryRoot, trashRoot, data) {
  validate(data);
  const existing = await roots(galleryRoot, trashRoot), indexed = [];
  for (const item of existing) indexed.push({ ...item, galleryId: await identity(item.dir) });
  const writes = [], conflicts = [], missing = [], matchedByName = [];
  async function check(file, value, label, asJson) {
    if (value === null) return;
    const raw = await optionalFile(file);
    if (raw === null) { writes.push({ file, content: asJson ? JSON.stringify(value, null, 2) : value + '\n' }); return; }
    let old;
    try { old = asJson ? JSON.parse(raw) : raw.trim(); } catch { conflicts.push(`${label}: existing metadata is invalid`); return; }
    if (JSON.stringify(old) !== JSON.stringify(value)) conflicts.push(`${label}: existing metadata differs`);
  }
  await check(path.join(root, tags.TAG_FILE), data.tags, 'Shared tag library', true);
  await check(path.join(root, collections.FILE), data.collections, 'Collections', true);
  const matchedTargets = new Set();
  for (const entry of data.galleries) {
    let candidates = entry.galleryId ? indexed.filter(x => x.galleryId === entry.galleryId) : [];
    if (candidates.length > 1) { conflicts.push(`${entry.name}: duplicate gallery identities`); continue; }
    if (!candidates.length) {
      candidates = indexed.filter(x => x.kind === entry.kind && (entry.kind === 'trash' ? x.trashId === entry.trashId : x.name === entry.name));
      if (candidates.length && entry.kind === 'gallery') matchedByName.push(entry.name);
    }
    if (!candidates.length) { missing.push(entry.name); continue; }
    const target = candidates[0];
    if (matchedTargets.has(target.dir)) { conflicts.push(`${entry.name}: multiple backup entries match one gallery`); continue; }
    matchedTargets.add(target.dir);
    if (entry.kind === 'trash' && target.kind === 'trash' && entry.name !== target.name) { conflicts.push(`${entry.name}: Trash entry name differs`); continue; }
    if (entry.galleryId && target.galleryId && entry.galleryId !== target.galleryId) { conflicts.push(`${entry.name}: gallery identity differs`); continue; }
    await check(path.join(target.dir, collections.GALLERY_ID), entry.galleryId, `${entry.name} identity`, false);
    await check(path.join(target.dir, tags.TAG_FILE), entry.tagIds, `${entry.name} tags`, true);
    await check(path.join(target.dir, galleryMedia.COVER), entry.cover == null ? null : { path: entry.cover }, `${entry.name} cover`, true);
    await check(path.join(target.dir, galleryMedia.MANUAL), entry.manual ? { version: 1 } : null, `${entry.name} empty-gallery marker`, true);
  }
  return { writes, conflicts, missing, matchedByName };
}
async function restore(root, galleryRoot, trashRoot, data) {
  const result = await plan(root, galleryRoot, trashRoot, data);
  if (result.conflicts.length) throw new Error('Restore blocked: existing metadata differs. Review the preview.');
  let restored = 0;
  try {
    for (const item of result.writes) {
      const temp = path.join(path.dirname(item.file), `.imageworks-restore-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, item.content, { flag: 'wx' });
        await fs.link(temp, item.file); // Atomic and cannot replace an existing file.
        restored++;
      } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    }
  } catch (error) { throw new Error(`Restore stopped after ${restored} files; no existing metadata was overwritten. Review and retry: ${error.message}`); }
  return { restored, missing: result.missing };
}
module.exports = { capture, plan, restore };
