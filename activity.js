const fs = require('node:fs/promises');
const path = require('node:path');

// The logger rotates three backups; read newest first and ignore incomplete lines.
async function readActivity(directory, limit = 200) {
  const result = [];
  for (const suffix of ['', '.1', '.2', '.3']) {
    let text;
    try { text = await fs.readFile(path.join(directory, 'imageworks.log' + suffix), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && result.length < limit; i--) {
      let row;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      if (!row.timestamp || !(row.level === 'error' || ['service.started', 'archive.import_started', 'archive.import_completed', 'archive.moved_to_processed', 'download.started', 'download.completed', 'gallery.trash_move', 'gallery.trash_restore', 'gallery.trash_delete'].includes(row.event))) continue;
      result.push({ timestamp: row.timestamp, level: row.level, event: row.event,
        archive: typeof row.archive === 'string' ? path.basename(row.archive) : undefined,
        album: row.album, images: row.images, added: row.added,
        message: typeof row.error?.message === 'string' ? row.error.message.slice(0, 2000) : undefined,
        retryInSeconds: row.retryInSeconds });
    }
    if (result.length >= limit) break;
  }
  return result;
}
module.exports = { readActivity };
