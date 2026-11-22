const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const TAG_FILE = '.imageworks-tags.json';
const COLOURS = ['default', 'blue', 'green', 'gold', 'pink', 'purple', 'grey'];

function nameOf(value) {
  if (typeof value !== 'string') throw new Error('Enter a tag name.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Tag names must be 1–60 characters with no control characters.');
  return name;
}
async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function writeJSON(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(data, null, 2), { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
async function library(root) {
  const tags = await readJSON(path.join(root, TAG_FILE), []);
  if (!Array.isArray(tags) || tags.some(tag => !tag || typeof tag.id !== 'string' || typeof tag.name !== 'string' || (tag.colour !== undefined && !COLOURS.includes(tag.colour)))) throw new Error('The tag library is invalid.');
  return tags;
}
async function createTag(root, value) {
  const name = nameOf(value), tags = await library(root);
  if (tags.some(tag => tag.name.toLowerCase() === name.toLowerCase())) throw new Error('A tag with that name already exists.');
  const tag = { id: randomUUID(), name };
  tags.push(tag); await writeJSON(path.join(root, TAG_FILE), tags); return tag;
}
async function changeTag(root, id, value) {
  const tags = await library(root), tag = tags.find(tag => tag.id === id);
  if (!tag) throw new Error('Tag not found.');
  if (value === null) {
    await writeJSON(path.join(root, TAG_FILE), tags.filter(tag => tag.id !== id));
    return tag;
  }
  const name = nameOf(value);
  if (tags.some(other => other.id !== id && other.name.toLowerCase() === name.toLowerCase())) throw new Error('A tag with that name already exists.');
  tag.name = name; await writeJSON(path.join(root, TAG_FILE), tags); return tag;
}
async function colourTag(root, id, colour) {
  if (!COLOURS.includes(colour)) throw new Error('Invalid tag colour.');
  const tags = await library(root), tag = tags.find(tag => tag.id === id);
  if (!tag) throw new Error('Tag not found.');
  if (colour === 'default') delete tag.colour; else tag.colour = colour;
  await writeJSON(path.join(root, TAG_FILE), tags); return tag;
}
async function galleryTags(dir) {
  const ids = await readJSON(path.join(dir, TAG_FILE), []);
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('The gallery tag metadata is invalid.');
  return ids;
}
async function assignTags(root, galleryRoot, album, ids) {
  if (typeof album !== 'string' || !album || album === '.' || album === '..' || path.basename(album) !== album || album.includes('\\')) throw new Error('Invalid gallery.');
  const dir = path.join(galleryRoot, album);
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Gallery not found.');
  await galleryTags(dir); // Refuse to overwrite unreadable or malformed metadata.
  if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string')) throw new Error('Invalid tag selection.');
  const tags = await library(root), allowed = new Set(tags.map(tag => tag.id));
  if (ids.some(id => !allowed.has(id))) throw new Error('A selected tag no longer exists. Refresh and try again.');
  await writeJSON(path.join(dir, TAG_FILE), [...new Set(ids)]);
}
module.exports = { library, createTag, changeTag, colourTag, galleryTags, assignTags, TAG_FILE, COLOURS };
