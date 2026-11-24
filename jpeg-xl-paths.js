const path = require('node:path');
const fs = require('node:fs/promises');

const suffix = '.imageworks.jxl';
const isJpeg = value => /\.jpe?g$/i.test(value);
const isMigrated = value => /\.jpe?g\.imageworks\.jxl$/i.test(value);
const logicalPath = value => isMigrated(value) ? value.slice(0, -suffix.length) : value;

async function physicalPath(file) {
  if (!isJpeg(file)) return file;
  try {
    if ((await fs.lstat(file)).isFile()) return file;
  } catch (error) {
    if (error.code === 'ENOTDIR') return file;
    if (error.code !== 'ENOENT') throw error;
    try {
      if ((await fs.lstat(file + suffix)).isFile()) return file + suffix;
    } catch (missing) { if (!['ENOENT', 'ENOTDIR'].includes(missing.code)) throw missing; }
  }
  return file;
}

module.exports = { suffix, isJpeg, isMigrated, logicalPath, physicalPath };
