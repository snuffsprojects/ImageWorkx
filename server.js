const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { createPosterCache, fallbackPoster, parseRange } = require('./video');
const { createPreviewCache, cleanPreviews } = require('./previews');
const { readActivity } = require('./activity');
const { createMigration } = require('./jpeg-xl-migration');
const { isJpeg, isMigrated, logicalPath, physicalPath } = require('./jpeg-xl-paths');
const { createPilot } = require('./jpeg-xl-pilot');
const tags = require('./tags');
const collections = require('./collections');
const galleryMedia = require('./gallery-media');
const imageTrash = require('./image-trash');
const metadataBackup = require('./metadata-backup');
const { moveToTrash, listTrash, restoreTrash, deleteTrash } = require('./gallery-trash');
const { listDownloadCache, removeDownloadCache } = require('./download-cache');

const ROOT = __dirname;
const DATA_ROOT = path.resolve(process.env.IMAGEWORKS_DATA || ROOT);
const INBOX = path.join(DATA_ROOT, 'Inbox');
const PROCESSED = path.join(DATA_ROOT, 'Processed');
const { planMove, executeMove } = require('./processed-archives');
const GALLERY = path.join(DATA_ROOT, 'Gallery');
const TRASH = path.join(DATA_ROOT, '.gallery-trash');
const IMAGE_TRASH = path.join(DATA_ROOT, '.imageworks-image-trash');
const getPoster = createPosterCache(path.join(DATA_ROOT, '.posters'));
const PREVIEW_CACHE = path.join(DATA_ROOT, '.previews');
const getPreview = createPreviewCache(PREVIEW_CACHE);
const PUBLIC = path.join(ROOT, 'public');
const DOWNLOAD_CACHE = path.join(DATA_ROOT, '.downloads');
const { downloadMedia, goonBoxImageIds } = require('./downloader');
const { bunkrAlbumId } = require('./bunkr');
const log = require('./logger').createLogger(path.join(DATA_ROOT, 'Logs'));
const failedImports = new Map();
const STATE_FILE = path.join(DATA_ROOT, '.imageworks-state.json');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff', '.webm', '.jxl']);
const MIME = {
  '.webm': 'video/webm', '.jxl': 'image/jxl',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff'
};

let state = { processed: {} };
let activity = { status: 'idle', message: 'Watching Inbox', archive: null, updatedAt: new Date().toISOString() };
let scanRunning = false;
let cacheRemovalRunning = false;
let galleryTrashRunning = false;
let pilotJob = { status: 'idle' };
let summaryCache = null;
let summaryGeneration = 0;
let summaryScan = null;
function invalidateSummary() { summaryGeneration++; summaryCache = null; }
function galleryOperationsBusy() {
  return galleryTrashRunning || scanRunning || downloadJob.status === 'working' || pilotJob.status === 'working';
}
function limitBytes(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value * 1024 ** 3) : fallback * 1024 ** 3;
}

const migration = createMigration({
  dataRoot: DATA_ROOT, galleryRoot: GALLERY, trashRoot: TRASH,
  discover: async () => {
    const galleries = [];
    for (const entry of (await fsp.readdir(GALLERY, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(GALLERY, entry.name);
      const media = (await walkImages(dir)).map(file => path.relative(dir, file).split(path.sep).join('/'));
      const files = media.filter(isJpeg);
      galleries.push({ name: entry.name, dir, files, media, id: await collections.readGalleryId(dir) });
    }
    return galleries;
  },
  publish: async operation => {
    if (galleryOperationsBusy()) return;
    galleryTrashRunning = true;
    try { return await operation(); }
    finally { galleryTrashRunning = false; }
  },
  changed: invalidateSummary,
  idle: () => !galleryOperationsBusy(),
  minFree: limitBytes('IMAGEWORKS_JXL_MIN_FREE_GIB', 5),
  maxRetained: limitBytes('IMAGEWORKS_JXL_MAX_RETAINED_GIB', 20)
});

async function getSummary() {
  while (!summaryCache) {
    if (!summaryScan) {
      const generation = summaryGeneration;
      summaryScan = getAlbums({ summary: true }).then(albums => {
        if (generation === summaryGeneration) summaryCache = albums;
      }).finally(() => { summaryScan = null; });
    }
    await summaryScan;
  }
  return summaryCache;
}
const stability = new Map();
let downloadJob = { status: 'idle', message: 'Ready for a link', url: '', progress: 0, current: 0, total: 0, log: [], updatedAt: new Date().toISOString() };

function normalizeAlbumName(value) {
  return value
    .replace(/\.part\d+$/i, '')
    .replace(/\+/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s*[–—]\s*/g, ' - ')
    .replace(/\s+-\s+/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[. ]+$/g, '')
    .trim() || 'Untitled gallery';
}

function cleanAlbumName(filename) {
  return normalizeAlbumName(path.basename(filename).replace(/\.(?:rar|zip)$/i, ''));
}

function albumDetails(folderName) {
  const name = normalizeAlbumName(folderName);
  const parts = name.split(/\s+-\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return { name, model: parts.slice(0, -1).join(' - '), set: parts.at(-1) };
  }
  return { name, model: '', set: name };
}

function decodeThreadText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

async function getDownloadSource(sourceUrl) {
  const parsed = new URL(sourceUrl);
  const match = parsed.pathname.match(/^\/([a-z0-9]+)\/thread\/(\d+)(?:\/([^/?#]+))?/i);
  if (!match) return null;
  const [, board, threadId, slug = ''] = match;
  let title = decodeThreadText(decodeURIComponent(slug).replace(/[-_]+/g, ' '));
  try {
    const response = await fetch(`https://a.4cdn.org/${board}/thread/${threadId}.json`, {
      headers: { 'User-Agent': 'ImageWorks Gallery' }, signal: AbortSignal.timeout(10000)
    });
    if (response.ok) {
      const data = await response.json();
      const openingPost = data.posts?.[0] || {};
      title = decodeThreadText(openingPost.sub) || title || decodeThreadText(openingPost.com).slice(0, 90);
    }
  } catch { /* The downloader will report an unreachable or expired thread. */ }
  return { type: '4chan', board: board.toLowerCase(), threadId, title: normalizeAlbumName(title || `Thread ${threadId}`), sourceUrl };
}

async function readAlbumSource(dir, folderName) {
  try {
    const source = JSON.parse(await fsp.readFile(path.join(dir, '.imageworks-source.json'), 'utf8'));
    if (source?.type === '4chan') return source;
  } catch { /* Legacy galleries do not have source metadata. */ }
  const legacy = folderName.match(/^4chan\s+([a-z0-9]+)\s+(\d+)$/i);
  return legacy ? { type: '4chan', board: legacy[1].toLowerCase(), threadId: legacy[2], title: `Thread ${legacy[2]}` } : null;
}

function safeResolve(root, requestPath) {
  const resolved = path.resolve(root, requestPath);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

async function exists(file) { try { await fsp.access(file); return true; } catch { return false; } }

async function loadState() {
  try {
    state = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
    if (!state.processed || typeof state.processed !== 'object') throw new Error('Import state is missing its processed archive map.');
  } catch (error) {
    if (error.code !== 'ENOENT') log('error', 'state.load_failed', { file: STATE_FILE, error });
    state = { processed: {} };
  }
}

async function saveState() {
  await fsp.writeFile(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
  await fsp.rename(STATE_FILE + '.tmp', STATE_FILE);
}

async function walkImages(root, current = root) {
  const output = [];
  for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...await walkImages(root, full));
    else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && (!/\.jxl$/i.test(entry.name) || /\.jpe?g(?:\.imageworks)?\.jxl$/i.test(entry.name))) output.push(full);
  }
  const present = new Set(output);
  return output.filter(file => !isMigrated(file) || !present.has(logicalPath(file)));
}

function run7zip(archive, destination) {
  return new Promise((resolve, reject) => {
    const command = process.env.SEVENZIP || '7z';
    const child = spawn(command, ['x', '-y', '-p', `-o${destination}`, archive], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16384); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
    child.on('error', error => {
      if (error.code === 'ENOENT') error.message = `Archive extractor "${command}" was not found. Install 7zip or set SEVENZIP to its executable path.`;
      error.command = command;
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      const error = new Error(`Archive extraction failed (${signal ? `signal ${signal}` : `exit code ${code}`}): ${(stderr || stdout).trim().slice(-2000) || 'No diagnostic output.'}`);
      Object.assign(error, { command, exitCode: code, signal, stdout, stderr });
      reject(error);
    });
  });
}

async function uniqueDestination(target, reserved = new Set()) {
  if (!reserved.has(target) && !await exists(await physicalPath(target))) return target;
  const ext = path.extname(target);
  const stem = target.slice(0, -ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!reserved.has(candidate) && !await exists(await physicalPath(candidate))) return candidate;
  }
}

async function importArchive(archive) {
  const albumName = cleanAlbumName(path.basename(archive));
  const albumDir = path.join(GALLERY, albumName);
  const tempDir = path.join(DATA_ROOT, `.extracting-${process.pid}-${Date.now()}`);
  activity = { status: 'working', message: `Unpacking ${path.basename(archive)}`, archive: path.basename(archive), updatedAt: new Date().toISOString() };
  const started = Date.now();
  log('info', 'archive.import_started', { archive, album: albumName });
  try {
    await fsp.mkdir(tempDir, { recursive: true });
    await run7zip(archive, tempDir);
    const images = await walkImages(tempDir);
    if (!images.length) throw new Error('The archive did not contain any supported media files.');
    await fsp.mkdir(albumDir, { recursive: true });
    const galleryId = await collections.readGalleryId(albumDir);
    const reserved = await imageTrash.reservedPaths(IMAGE_TRASH, galleryId);
    const reservedFiles = new Set([...reserved].map(item => path.join(albumDir, ...item.split('/'))));
    let added = 0;
    for (const image of images) {
      const relative = path.relative(tempDir, image);
      if (reserved.has(relative.split(path.sep).join('/'))) continue;
      const requested = path.join(albumDir, relative);
      const destination = await uniqueDestination(requested, reservedFiles);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.copyFile(image, destination);
      added++;
    }
    invalidateSummary();
    activity = { status: 'success', message: `Added ${added} file${added === 1 ? '' : 's'} to ${albumName}`, archive: path.basename(archive), updatedAt: new Date().toISOString() };
    log('info', 'archive.import_completed', { archive, album: albumName, images: added, durationMs: Date.now() - started });
    return added;
  } catch (error) {
    activity = { status: 'error', message: `${path.basename(archive)}: ${error.message}`, archive: path.basename(archive), updatedAt: new Date().toISOString() };
    throw error;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(error => log('error', 'archive.cleanup_failed', { archive, tempDir, error }));
  }
}

async function scanInbox() {
  if (scanRunning || galleryTrashRunning || (downloadJob.status === 'working' && downloadJob.targetGallery)) return;
  scanRunning = true;
  try {
    const entries = await fsp.readdir(INBOX, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(?:rar|zip)$/i.test(entry.name) || /\.part(?!0*1\.)\d+\.rar$/i.test(entry.name)) continue;
      const archive = path.join(INBOX, entry.name);
      const stat = await fsp.stat(archive);
      const signature = `${stat.size}:${stat.mtimeMs}`;
      const failure = failedImports.get(entry.name);
      if (failure && failure.signature === signature && Date.now() < failure.retryAt) continue;
      const previous = stability.get(entry.name);
      if (!previous || previous.signature !== signature) {
        stability.set(entry.name, { signature, checks: 1 });
        continue;
      }
      previous.checks++;
      if (previous.checks < 3) continue;
      let imported = state.processed[entry.name] === signature;
      try {
        state.pendingMoves ||= {};
        let plan = state.pendingMoves[entry.name];
        if (!imported) {
          plan = await planMove(archive, PROCESSED);
          await importArchive(archive);
          state.processed[entry.name] = signature;
          state.pendingMoves[entry.name] = plan;
          imported = true;
          await saveState();
        } else if (!plan) {
          plan = await planMove(archive, PROCESSED);
          state.pendingMoves[entry.name] = plan;
          await saveState();
        }
        await executeMove(plan);
        delete state.pendingMoves[entry.name];
        await saveState();
        failedImports.delete(entry.name);
        log('info', 'archive.moved_to_processed', { archive, destination: plan.destination, files: plan.files.length });
      } catch (error) {
        const attempts = failure?.signature === signature ? failure.attempts + 1 : 1;
        const retryMs = Math.min(300000, 30000 * 2 ** Math.min(attempts - 1, 4));
        failedImports.set(entry.name, { signature, attempts, retryAt: Date.now() + retryMs });
        log('error', imported ? 'archive.move_failed' : 'archive.import_failed', { archive, signature, attempts, retryInSeconds: retryMs / 1000, error });
        if (imported) activity = { status: 'error', message: `Imported ${entry.name}, but could not move it out of Inbox: ${error.message}`, archive: entry.name, updatedAt: new Date().toISOString() };
      } finally {
        stability.delete(entry.name);
      }
    }
  } catch (error) {
    log('error', 'inbox.scan_failed', { inbox: INBOX, error });
  } finally { scanRunning = false; }
}

async function getAlbums({ id, summary = false } = {}) {
  const albums = [];
  for (const entry of await fsp.readdir(GALLERY, { withFileTypes: true })) {
    if (!entry.isDirectory() || (id !== undefined && entry.name !== id)) continue;
    const dir = path.join(GALLERY, entry.name);
    const images = await walkImages(dir);
    if (!images.length && !await galleryMedia.manualGallery(dir) && !await collections.readGalleryId(dir)) continue;
    const galleryId = await collections.readGalleryId(dir);
    const migrationStatus = migration.summary(galleryId,
      images.filter(isJpeg).map(file => path.relative(dir, file).split(path.sep).join('/')), images.filter(isMigrated).length);
    const items = await Promise.all(images.map(async file => {
      const stat = await fsp.stat(file);
      const relative = path.relative(GALLERY, logicalPath(file)).split(path.sep).map(encodeURIComponent).join('/');
      return { name: path.basename(logicalPath(file)).replace(/\.jxl$/i, ''), relativePath: path.relative(dir, logicalPath(file)).split(path.sep).join('/'), preview: path.extname(file).toLowerCase() === '.webm' ? null : `/preview/${relative}`, type: path.extname(file).toLowerCase() === '.webm' ? 'video' : 'image', poster: path.extname(file).toLowerCase() === '.webm' ? `/poster/${relative}` : null, url: path.extname(file).toLowerCase() === '.jxl' ? `/reconstructed/${relative}` : `/gallery/${relative}`, jxl: path.extname(file).toLowerCase() === '.jxl', sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    }));
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const modifiedAt = items.length ? items.reduce((latest, item) => item.modifiedAt > latest ? item.modifiedAt : latest, items[0].modifiedAt) : (await fsp.stat(dir)).mtime.toISOString();
    let coverPath = null;
    try { coverPath = await galleryMedia.readCover(dir); } catch (error) { log('error', 'gallery.cover_read_failed', { album: entry.name, error }); }
    const coverItem = items.find(item => item.relativePath === coverPath && item.type === 'image') || items[0];
    const source = await readAlbumSource(dir, entry.name);
    let tagIds = [], tagError = false;
    try { tagIds = await tags.galleryTags(dir); } catch (error) { tagError = true; log('error', 'tags.gallery_read_failed', { album: entry.name, error }); }
    const details = source?.type === '4chan'
      ? { name: entry.name, model: '', set: source.title || `Thread ${source.threadId}` }
      : albumDetails(entry.name);
    albums.push({ id: entry.name, ...details, kind: source?.type || 'collection', source, tagIds, tagError, migration: migrationStatus, count: items.length, sizeBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0), cover: coverItem ? coverItem.poster || coverItem.preview || coverItem.url : null, coverType: coverItem?.type || null, modifiedAt, ...(summary ? {} : { images: items }) });
  }
  return albums.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function supportedDownloadUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    if ((host === 'boards.4chan.org' || host === 'boards.4channel.org') && /^\/[a-z0-9]+\/thread\/\d+/i.test(url.pathname)) return true;
    if (bunkrAlbumId(url)) return true;
    return (host === 'goonbox.cr' || host === 'www.goonbox.cr') && /^\/a\/[a-z0-9]+/i.test(url.pathname);
  } catch { return false; }
}

function addDownloadLog(line) {
  const clean = line.trim();
  if (!clean) return;
  downloadJob.log.push(clean);
  downloadJob.log = downloadJob.log.slice(-60);
  downloadJob.message = clean;
  const progress = clean.match(/^\[(\d+)\/(\d+)\]/);
  if (progress) {
    downloadJob.current = Number(progress[1]);
    downloadJob.total = Number(progress[2]);
    downloadJob.progress = Math.round((downloadJob.current / downloadJob.total) * 100);
  }
  downloadJob.updatedAt = new Date().toISOString();
}

async function copyDownloadedImages(sourceDir, targetDir, includeWebm = false, requestedFiles) {
  const selected = requestedFiles && new Set(requestedFiles);
  const images = (await walkImages(sourceDir)).filter(file =>
    (!selected || selected.has(path.relative(sourceDir, file))) && (includeWebm || path.extname(file).toLowerCase() !== '.webm'));
  await fsp.mkdir(targetDir, { recursive: true });
  let added = 0;
  let skipped = 0;
  const galleryId = await collections.readGalleryId(targetDir);
  const reserved = await imageTrash.reservedPaths(IMAGE_TRASH, galleryId);
  const reservedFiles = new Set([...reserved].map(item => path.join(targetDir, ...item.split('/'))));
  for (const image of images) {
    const relative = path.relative(sourceDir, image);
    if (reserved.has(relative.split(path.sep).join('/'))) { skipped++; continue; }
    const requested = path.join(targetDir, relative);
    await fsp.mkdir(path.dirname(requested), { recursive: true });
    const physical = await physicalPath(requested);
    if (physical !== requested &&
        (await migration.matchesOriginal(galleryId, relative.split(path.sep).join('/'), image))) { skipped++; continue; }
    if (await exists(requested)) {
      const [sourceStat, targetStat] = await Promise.all([fsp.stat(image), fsp.stat(requested)]);
      if (sourceStat.size === targetStat.size) { skipped++; continue; }
    }
    const destination = await uniqueDestination(requested, reservedFiles);
    await fsp.copyFile(image, destination);
    added++;
  }
  return { added, skipped, total: images.length };
}

async function finishDownload(code, { failedLinks = [], files } = {}) {
  if (code !== 0) throw new Error(`Downloader stopped with code ${code}.`);
  const savedLine = [...downloadJob.log].reverse().find(line => line.startsWith('Saved to: '));
  if (!savedLine) throw new Error('The downloader did not report an output folder.');
  const sourceDir = path.resolve(savedLine.slice(10).trim());
  const cacheRoot = path.resolve(DOWNLOAD_CACHE);
  if (!sourceDir.startsWith(cacheRoot + path.sep)) throw new Error('The downloader returned an unexpected output folder.');
  const relative = path.relative(cacheRoot, sourceDir).split(path.sep);
  let albumName;
  if (relative[0] === 'GoonBoxBatch') {
    albumName = downloadJob.targetGallery;
    downloadJob.failedLinks = failedLinks;
    if (failedLinks.length === downloadJob.total) throw new Error('All GoonBox downloads failed. See the download log.');
  } else if (relative[0] === 'GoonBox') albumName = normalizeAlbumName(path.basename(sourceDir));
  else if (relative[0] === 'Bunkr') albumName = normalizeAlbumName(`Bunkr ${relative[1]}`);
  else albumName = normalizeAlbumName(`4chan ${relative.at(-2) || 'thread'} ${relative.at(-1)}`);
  if (downloadJob.source?.type === '4chan') {
    for (const entry of await fsp.readdir(GALLERY, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const existing = await readAlbumSource(path.join(GALLERY, entry.name), entry.name);
      if (existing?.board === downloadJob.source.board && existing?.threadId === downloadJob.source.threadId) {
        albumName = entry.name;
        break;
      }
    }
  }
  const albumDir = path.join(GALLERY, albumName);
  const result = await copyDownloadedImages(sourceDir, albumDir, downloadJob.source?.includeWebm === true, files);
  if (downloadJob.source?.type === '4chan') {
    await fsp.writeFile(path.join(albumDir, '.imageworks-source.json'), JSON.stringify(downloadJob.source, null, 2));
  }
  invalidateSummary();
  downloadJob.status = 'success';
  downloadJob.progress = 100;
  downloadJob.message = result.added
    ? `Added ${result.added} file${result.added === 1 ? '' : 's'} to ${albumName}`
    : `${albumName} is already up to date`;
  if (failedLinks.length) {
    downloadJob.status = 'error';
    downloadJob.message += '. ' + failedLinks.length + ' failed. Retry the failed links from this gallery.';
  }
  downloadJob.album = albumName;
  downloadJob.updatedAt = new Date().toISOString();
  activity = { status: downloadJob.status, message: downloadJob.message, archive: null, updatedAt: downloadJob.updatedAt };
  log('info', 'download.completed', { album: albumName, ...result });
}

async function startDownload(req, res) {
  let body, batch;
  try {
    body = await readJson(req, 65536);
    if (body.links !== undefined) {
      if (typeof body.links !== 'string') throw new Error('Paste individual GoonBox image links.');
      batch = { gallery: body.gallery, ids: goonBoxImageIds(body.links) };
    }
  } catch (error) { return sendJson(res, 400, { error: error.message }); }
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!batch && !supportedDownloadUrl(url)) return sendJson(res, 400, { error: 'Paste a valid 4chan thread, GoonBox album or Bunkr album link.' });
  if (downloadJob.status === 'working' || cacheRemovalRunning || galleryTrashRunning) return sendJson(res, 409, { error: 'A download or gallery operation is already running.' });
  if (batch && (scanRunning || pilotJob.status === 'working')) return sendJson(res, 409, { error: 'Wait for the current gallery operation to finish.' });
  const previousJob = downloadJob;
  downloadJob = { ...previousJob, status: 'working' };
  if (batch) {
    try {
      const dir = await galleryMedia.albumDirectory(GALLERY, batch.gallery);
      batch.id = await collections.ensureGalleryId(dir);
    } catch {
      downloadJob = previousJob;
      return sendJson(res, 400, { error: 'Open an existing gallery before importing links.' });
    }
  }
  try { await fsp.mkdir(DOWNLOAD_CACHE, { recursive: true }); } catch (error) { downloadJob = previousJob; throw error; }
  const source = batch ? null : await getDownloadSource(url);
  if (source) source.includeWebm = body.includeWebm === true;
  downloadJob = { status: 'working', message: 'Starting download…', url, source, targetGallery: batch?.gallery, progress: 0, current: 0, total: 0, log: [], updatedAt: new Date().toISOString() };
  log('info', 'download.started');
  downloadMedia(url, DOWNLOAD_CACHE, addDownloadLog, fetch, { includeWebm: source?.includeWebm === true, batch })
    .then(result => finishDownload(0, result))
    .catch(error => {
      log('error', 'download.failed', { error });
      downloadJob.status = 'error';
      downloadJob.errorCode = error.code === 'THREAD_NOT_FOUND' ? error.code : undefined;
      downloadJob.message = error.code === 'THREAD_NOT_FOUND' ? 'This thread is not currently available on 4chan. Your saved gallery is unchanged.' : error.message;
      downloadJob.updatedAt = new Date().toISOString();
    });
  return sendJson(res, 202, { download: downloadJob });
}

async function readJson(req, maxLength = 4096) {
  return new Promise((resolve, reject) => {
    let body = '', tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (tooLarge) return;
      if (body.length + chunk.length > maxLength) { body = ''; tooLarge = true; return; }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('Request is too large.'));
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid request.')); }
    });
    req.on('error', reject);
  });
}

async function renameAlbum(req, res) {
  const body = await readJson(req);
  if (typeof body.id !== 'string' || typeof body.name !== 'string') return sendJson(res, 400, { error: 'Album and name are required.' });
  if (galleryTrashRunning || scanRunning || downloadJob.status === 'working' || pilotJob.status === 'working') return sendJson(res, 409, { error: 'Wait for the current gallery operation to finish.' });
  galleryTrashRunning = true;
  try {
  const oldDir = safeResolve(GALLERY, body.id);
  const newName = normalizeAlbumName(body.name);
  const newDir = path.join(GALLERY, newName);
  if (!oldDir || path.dirname(oldDir) !== GALLERY || !(await exists(oldDir))) return sendJson(res, 404, { error: 'Gallery not found.' });
  if (oldDir.toLowerCase() === newDir.toLowerCase()) {
    if (oldDir !== newDir) { await fsp.rename(oldDir, newDir); await collections.noteRenamed(DATA_ROOT, newDir, newName).catch(error => log('error', 'collections.rename_update_failed', { error })); invalidateSummary(); }
    return sendJson(res, 200, { album: albumDetails(newName) });
  }
  if (await exists(newDir)) return sendJson(res, 409, { error: 'A gallery with that name already exists.' });
  await fsp.rename(oldDir, newDir);
  await collections.noteRenamed(DATA_ROOT, newDir, newName).catch(error => log('error', 'collections.rename_update_failed', { error }));
  invalidateSummary();
  activity = { status: 'success', message: `Renamed gallery to ${newName}`, archive: null, updatedAt: new Date().toISOString() };
  return sendJson(res, 200, { album: albumDetails(newName) });
  } finally { galleryTrashRunning = false; }
}

function urlDownload(req) { return new URL(req.url, 'http://localhost').searchParams.has('download'); }

async function serveFile(req, res, root, relative) {
  const decoded = decodeURIComponent(relative);
  const file = safeResolve(root, decoded);
  if (!file) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('Not a file');
    const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' };
    let range;
    if (req.headers.range) {
      range = parseRange(req.headers.range, stat.size);
      if (!range) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
      headers['Content-Length'] = range.end - range.start + 1;
    }
    if (urlDownload(req)) headers['Content-Disposition'] = 'attachment';
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, range || {});
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch { sendJson(res, 404, { error: 'Not found' }); }
}

async function serveReconstructed(req, res, relative) {
  const requested = safeResolve(GALLERY, decodeURIComponent(relative));
  const file = requested && await physicalPath(requested);
  if (requested && file === requested && isJpeg(requested)) return serveFile(req, res, GALLERY, relative);
  if (!file || !/\.jpe?g(?:\.imageworks)?\.jxl$/i.test(file)) return sendJson(res, 404, { error: 'Not found' });
  try { if (!(await fsp.stat(file)).isFile()) throw new Error(); }
  catch { return sendJson(res, 404, { error: 'Not found' }); }
  const child = spawn(process.env.IMAGEWORKS_DJXL || 'djxl', [file, '-', '--output_format=jpeg', '--num_threads=1', '--quiet'], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.once('data', chunk => {
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', ...(urlDownload(req) ? { 'Content-Disposition': 'attachment' } : {}) });
    if (req.method === 'HEAD') { res.end(); child.kill(); return; }
    res.write(chunk);
    child.stdout.pipe(res);
  });
  child.on('error', () => { if (!res.headersSent) sendJson(res, 500, { error: 'JPEG XL decoder unavailable.' }); else res.destroy(); });
  child.on('close', code => { if ((code !== 0 || !res.headersSent) && !res.writableEnded && !res.destroyed) { if (!res.headersSent) sendJson(res, 500, { error: 'JPEG reconstruction failed.' }); else res.destroy(); } });
  res.on('close', () => { if (child.exitCode === null) child.kill(); });
}

async function servePoster(req, res, relative) {
  const file = safeResolve(GALLERY, decodeURIComponent(relative));
  if (!file || path.extname(file).toLowerCase() !== '.webm') return sendJson(res, 404, { error: 'Not found' });
  let stat;
  try { stat = await fsp.stat(file); if (!stat.isFile()) throw new Error(); }
  catch { return sendJson(res, 404, { error: 'Not found' }); }
  const poster = await getPoster(file, stat);
  if (poster) return serveFile(req, res, path.dirname(poster), path.basename(poster));
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : fallbackPoster);
}

async function directorySize(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  let size = 0;
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) size += await directorySize(file);
    else if (entry.isFile()) {
      try { size += (await fsp.lstat(file)).size; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return size;
}

async function storageInfo() {
  const folders = { jpegOriginals: migration.originals, inbox: INBOX, processed: PROCESSED, downloads: DOWNLOAD_CACHE, trash: TRASH, imageTrash: IMAGE_TRASH, previews: PREVIEW_CACHE, posters: path.join(DATA_ROOT, '.posters') };
  const sizes = {};
  for (const [name, dir] of Object.entries(folders)) sizes[name] = await directorySize(dir);
  sizes.gallery = (await getSummary()).reduce((sum, album) => sum + album.sizeBytes, 0);
  const disk = await fsp.statfs(DATA_ROOT);
  return { sizes, free: disk.bavail * disk.bsize, total: disk.blocks * disk.bsize };
}

async function servePreview(req, res, relative) {
  const requested = safeResolve(GALLERY, decodeURIComponent(relative));
  const file = requested && await physicalPath(requested);
  if (!file || !IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()) || path.extname(file).toLowerCase() === '.webm') return sendJson(res, 404, { error: 'Not found' });
  let stat;
  try { stat = await fsp.stat(file); if (!stat.isFile()) throw new Error(); }
  catch { return sendJson(res, 404, { error: 'Not found' }); }
  const preview = await getPreview(file, stat);
  if (preview) return serveFile(req, res, PREVIEW_CACHE, path.basename(preview));
  if (/\.jxl$/i.test(file)) return serveReconstructed(req, res, relative);
  return serveFile(req, res, GALLERY, relative);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleRequest(req, res) {
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!(remote === '127.0.0.1' || remote === '::1' || (process.env.LAN_PREFIX && remote.startsWith(process.env.LAN_PREFIX)))) return sendJson(res, 403, { error: 'Home network only.' });
  if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return sendJson(res, 403, { error: 'Origin not allowed.' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/albums') return sendJson(res, 200, { albums: await (url.searchParams.get('summary') === '1' && !url.searchParams.has('id') ? getSummary() : getAlbums({ id: url.searchParams.has('id') ? url.searchParams.get('id') : undefined, summary: url.searchParams.get('summary') === '1' })), activity });

  if (url.pathname === '/api/albums/create' && req.method === 'POST') {
    const body = await readJson(req);
    if (typeof body.name !== 'string' || !body.name.trim() || Buffer.byteLength(body.name.trim()) > 150) return sendJson(res, 400, { error: 'Enter a gallery name (up to 150 bytes).' });
    if (galleryTrashRunning || scanRunning || downloadJob.status === 'working' || pilotJob.status === 'working') return sendJson(res, 409, { error: 'Wait for the current import, download or gallery operation to finish.' });
    galleryTrashRunning = true;
    try {
      const name = normalizeAlbumName(body.name);
      await galleryMedia.createGallery(GALLERY, name); invalidateSummary();
      log('info', 'gallery.created', { album: name });
      return sendJson(res, 201, { id: name });
    } catch (error) { return sendJson(res, error.code === 'EEXIST' ? 409 : 400, { error: error.code === 'EEXIST' ? 'A gallery with that name already exists.' : error.message }); }
    finally { galleryTrashRunning = false; }
  }
  if (url.pathname === '/api/albums/upload' && req.method === 'POST') {
    const album = url.searchParams.get('id'), name = url.searchParams.get('name'), rawLength = req.headers['content-length'];
    if (!/^\d+$/.test(rawLength || '') || !Number.isSafeInteger(Number(rawLength)) || Number(rawLength) < 1 || Number(rawLength) > galleryMedia.MAX_UPLOAD) { req.resume(); return sendJson(res, 400, { error: 'Images must be between 1 byte and 100 MB and include their size.' }); }
    if (galleryTrashRunning || scanRunning || downloadJob.status === 'working' || pilotJob.status === 'working') { req.resume(); return sendJson(res, 409, { error: 'Wait for the current import, download or gallery operation to finish.' }); }
    galleryTrashRunning = true;
    try {
      const dir = await galleryMedia.albumDirectory(GALLERY, album);
      const reserved = await imageTrash.reservedPaths(IMAGE_TRASH, await collections.readGalleryId(dir));
      const result = await galleryMedia.upload(GALLERY, album, name, Number(rawLength), req, reserved);
      invalidateSummary(); log('info', 'gallery.image_uploaded', { album, file: result.name, sizeBytes: result.sizeBytes });
      return sendJson(res, 201, result);
    } catch (error) {
      log('error', 'gallery.upload_failed', { album, error });
      if (!req.destroyed) req.resume();
      if (!res.destroyed) return sendJson(res, 400, { error: error.code === 'ENOENT' ? 'Gallery not found.' : error.message });
    } finally { galleryTrashRunning = false; }
  }
  if (url.pathname === '/api/albums/cover' && req.method === 'POST') {
    const body = await readJson(req);
    if (galleryTrashRunning || scanRunning || downloadJob.status === 'working' || pilotJob.status === 'working') return sendJson(res, 409, { error: 'Wait for the current import, download or gallery operation to finish.' });
    galleryTrashRunning = true;
    try {
      const dir = await galleryMedia.albumDirectory(GALLERY, body.id);
      await galleryMedia.setCover(GALLERY, body.id, body.path, await walkImages(dir));
      invalidateSummary(); log('info', 'gallery.cover_changed', { album: body.id });
      return sendJson(res, 200, { ok: true });
    } catch (error) { return sendJson(res, 400, { error: error.code === 'ENOENT' ? 'Gallery not found.' : error.message }); }
    finally { galleryTrashRunning = false; }
  }
  if (url.pathname === '/api/metadata-backup' && req.method === 'GET') {
    if (galleryTrashRunning || scanRunning || downloadJob.status === 'working' || pilotJob.status === 'working') return sendJson(res, 409, { error: 'Wait for the current import, download or gallery operation to finish.' });
    galleryTrashRunning = true;
    try {
      const data = await metadataBackup.capture(DATA_ROOT, GALLERY, TRASH);
      const body = JSON.stringify(data, null, 2);
      if (Buffer.byteLength(body) > 20 * 1024 * 1024) return sendJson(res, 413, { error: 'Metadata backup exceeds the 20 MB restore limit.' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="imageworks-metadata-backup.json"', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
      return res.end(body);
    } finally { galleryTrashRunning = false; }
  }
  if (['/api/metadata-restore/preview', '/api/metadata-restore/apply'].includes(url.pathname) && req.method === 'POST') {
    let body; try { body = await readJson(req, 20 * 1024 * 1024); } catch (error) { return sendJson(res, 400, { error: error.message }); }
    if (galleryTrashRunning || scanRunning || downloadJob.status === 'working' || pilotJob.status === 'working') return sendJson(res, 409, { error: 'Wait for the current import, download or gallery operation to finish.' });
    galleryTrashRunning = true;
    try {
      if (url.pathname.endsWith('/preview')) {
        const result = await metadataBackup.plan(DATA_ROOT, GALLERY, TRASH, body);
        return sendJson(res, 200, { filesToRestore: result.writes.length, conflicts: result.conflicts, missing: result.missing, matchedByName: result.matchedByName });
      }
      const result = await metadataBackup.restore(DATA_ROOT, GALLERY, TRASH, body);
      invalidateSummary(); log('info', 'metadata.restored', { files: result.restored, missing: result.missing.length });
      return sendJson(res, 200, result);
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
    finally { galleryTrashRunning = false; }
  }
  if (url.pathname === '/api/collections' && req.method === 'GET') {
    if (url.searchParams.has('id')) {
      try { return sendJson(res, 200, { collection: await collections.detail(DATA_ROOT, GALLERY, TRASH, url.searchParams.get('id'), await imageTrash.references(IMAGE_TRASH)) }); }
      catch (error) { return sendJson(res, 400, { error: error.message }); }
    }
    const all = await collections.read(DATA_ROOT);
    return sendJson(res, 200, { collections: all.map(c => ({ id: c.id, name: c.name, count: c.items.length })) });
  }
  if (['/api/collections/create', '/api/collections/add', '/api/collections/add-many', '/api/collections/remove', '/api/collections/delete'].includes(url.pathname) && req.method === 'POST') {
    const body = await readJson(req, url.pathname.endsWith('/add-many') ? 262144 : 4096);
    if (galleryTrashRunning || scanRunning || downloadJob.status === 'working' || pilotJob.status === 'working') return sendJson(res, 409, { error: 'Wait for the current import, download or gallery operation to finish.' });
    galleryTrashRunning = true;
    try {
      let result;
      if (url.pathname.endsWith('/create')) result = await collections.create(DATA_ROOT, body.name);
      else if (url.pathname.endsWith('/add')) result = await collections.add(DATA_ROOT, GALLERY, body.collection, body.album, body.path);
      else if (url.pathname.endsWith('/add-many')) result = await collections.addMany(DATA_ROOT, GALLERY, body.collection, body.album, body.paths);
      else if (url.pathname.endsWith('/remove')) result = await collections.remove(DATA_ROOT, body.collection, body.item);
      else result = await collections.removeCollection(DATA_ROOT, body.collection);
      return sendJson(res, 200, { result });
    } catch (error) { return sendJson(res, 400, { error: error.code === 'ENOENT' ? 'Gallery or image not found.' : error.message }); }
    finally { galleryTrashRunning = false; }
  }
  if (url.pathname === '/api/tags' && req.method === 'GET') return sendJson(res, 200, { tags: await tags.library(DATA_ROOT) });
  if (['/api/tags/create', '/api/tags/rename', '/api/tags/colour', '/api/tags/delete', '/api/tags/assign'].includes(url.pathname) && req.method === 'POST') {
    const body = await readJson(req);
    if (galleryTrashRunning || scanRunning || downloadJob.status === 'working' || pilotJob.status === 'working') return sendJson(res, 409, { error: 'Wait for the current import, download or gallery operation to finish.' });
    galleryTrashRunning = true;
    try {
      let tag;
      if (url.pathname.endsWith('/create')) tag = await tags.createTag(DATA_ROOT, body.name);
      else if (url.pathname.endsWith('/rename')) tag = await tags.changeTag(DATA_ROOT, body.id, body.name);
      else if (url.pathname.endsWith('/colour')) tag = await tags.colourTag(DATA_ROOT, body.id, body.colour);
      else if (url.pathname.endsWith('/delete')) tag = await tags.changeTag(DATA_ROOT, body.id, null);
      else await tags.assignTags(DATA_ROOT, GALLERY, body.album, body.ids);
      invalidateSummary();
      return sendJson(res, 200, { tag, tags: await tags.library(DATA_ROOT) });
    } catch (error) { return sendJson(res, 400, { error: error.code === 'ENOENT' ? 'Gallery not found.' : error.message }); }
    finally { galleryTrashRunning = false; }
  }
  if (url.pathname === '/api/jxl-migration/worker' && req.method === 'GET') return sendJson(res, 200, await migration.monitor());
  if (url.pathname === '/api/jxl-migration' && req.method === 'GET') return sendJson(res, 200, await migration.report());
  if (url.pathname === '/api/jxl-migration' && req.method === 'POST') {
    const body = await readJson(req);
    try { await migration.setEnabled(body.enabled); return sendJson(res, 200, { ok: true }); }
    catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  if (url.pathname === '/api/jxl-migration/cleanup-all') {
    if (req.method === 'GET') return sendJson(res, 200, { job: migration.cleanupStatus() });
    if (req.method === 'POST') {
      const body = await readJson(req, 1024 * 1024);
      if (typeof body.revision !== 'string' || !Array.isArray(body.ids) || !body.ids.length ||
          body.ids.some(id => typeof id !== 'string' || id.length !== 36)) {
        return sendJson(res, 400, { error: 'Refresh the migration report before starting cleanup.' });
      }
      if ((galleryOperationsBusy() && !migration.isConverting()) || migration.cleanupStatus()?.status === 'working') return sendJson(res, 409, { error: 'Wait for the current gallery operation to finish.' });
      migration.cleanupAll(body.revision, body.ids, async operation => {
        if (galleryOperationsBusy()) throw new Error('Another gallery operation started. Try cleanup again once it finishes.');
        galleryTrashRunning = true;
        try { return await operation(); }
        finally { galleryTrashRunning = false; }
      }).catch(() => { /* The migration job records the failure for the report. */ });
      return sendJson(res, 202, { job: migration.cleanupStatus() });
    }
  }
  if (['/api/jxl-migration/restore', '/api/jxl-migration/cleanup'].includes(url.pathname) && req.method === 'POST') {
    const body = await readJson(req);
    if (galleryOperationsBusy()) return sendJson(res, 409, { error: 'Wait for the current gallery operation to finish.' });
    galleryTrashRunning = true;
    try {
      await migration.review(body.id, body.revision, url.pathname.endsWith('/restore') ? 'restore' : 'cleanup');
      return sendJson(res, 200, { ok: true });
    } catch (error) { return sendJson(res, 409, { error: error.message }); }
    finally { galleryTrashRunning = false; }
  }
  if (url.pathname === '/api/jxl-pilot' && req.method === 'GET') return sendJson(res, 200, { pilot: pilotJob });
  if (url.pathname === '/api/jxl-pilot' && req.method === 'POST') {
    const body = await readJson(req);
    if (pilotJob.status === 'working' || galleryTrashRunning) return sendJson(res, 409, { error: 'A gallery operation is already running.' });
    if (typeof body.id !== 'string' || !body.id || body.id === '.' || body.id === '..' || path.basename(body.id) !== body.id || body.id.includes('\\')) return sendJson(res, 400, { error: 'Invalid gallery.' });
    pilotJob = { status: 'working', album: body.id, done: 0, total: 0 };
    createPilot({ galleryRoot: GALLERY, dataRoot: DATA_ROOT, albumId: body.id, onProgress: progress => Object.assign(pilotJob, progress) })
      .then(result => { pilotJob = { status: 'success', ...result }; invalidateSummary(); log('info', 'jxl.pilot_completed', result); })
      .catch(error => { pilotJob = { status: 'error', message: error.code === 'ENOENT' && error.path && /(?:cjxl|djxl)$/.test(error.path) ? 'Install libjxl-tools to use the pilot.' : error.message }; log('error', 'jxl.pilot_failed', { error }); });
    return sendJson(res, 202, { pilot: pilotJob });
  }
  if (url.pathname === '/api/image-trash' && req.method === 'GET') return sendJson(res, 200, { entries: await imageTrash.list(IMAGE_TRASH, GALLERY, TRASH) });
  if (url.pathname === '/api/image-trash/file' && req.method === 'GET') {
    try { const item = await imageTrash.file(IMAGE_TRASH, url.searchParams.get('id')); return serveFile(req, res, item.dir, 'media'); }
    catch (error) { return sendJson(res, 404, { error: error.message }); }
  }
  if (['/api/image-trash/move', '/api/image-trash/restore', '/api/image-trash/delete', '/api/image-trash/forget'].includes(url.pathname) && req.method === 'POST') {
    const body = await readJson(req);
    if (galleryTrashRunning || scanRunning || downloadJob.status === 'working' || pilotJob.status === 'working') return sendJson(res, 409, { error: 'Wait for the current import, download or gallery operation to finish.' });
    galleryTrashRunning = true;
    try {
      let result;
      if (url.pathname.endsWith('/move')) result = await imageTrash.move(GALLERY, IMAGE_TRASH, body.album, body.path);
      else if (url.pathname.endsWith('/restore')) result = await imageTrash.restore(GALLERY, TRASH, IMAGE_TRASH, body.id);
      else if (url.pathname.endsWith('/delete')) result = await imageTrash.deleteMedia(IMAGE_TRASH, body.id);
      else result = await imageTrash.forget(IMAGE_TRASH, body.id);
      invalidateSummary();
      log('info', `image.trash_${url.pathname.split('/').at(-1)}`, { album: result.sourceName, file: path.basename(result.path) });
      return sendJson(res, 200, { ok: true });
    } catch (error) { return sendJson(res, 400, { error: error.code === 'ENOENT' ? 'Gallery or image not found.' : error.message }); }
    finally { galleryTrashRunning = false; }
  }
  if (url.pathname === '/api/gallery-trash' && req.method === 'GET') return sendJson(res, 200, { entries: await listTrash(TRASH) });
  if (['/api/gallery-trash/move', '/api/gallery-trash/restore', '/api/gallery-trash/delete'].includes(url.pathname) && req.method === 'POST') {
    const body = await readJson(req);
    if (galleryTrashRunning || scanRunning || downloadJob.status === 'working' || pilotJob.status === 'working') return sendJson(res, 409, { error: 'Wait for the current import, download or gallery operation to finish.' });
    galleryTrashRunning = true;
    try {
      let result;
      if (url.pathname.endsWith('/move')) result = await moveToTrash(GALLERY, TRASH, body.id);
      else if (url.pathname.endsWith('/restore')) result = await restoreTrash(GALLERY, TRASH, body.id);
      else result = await deleteTrash(TRASH, body.id);
      invalidateSummary();
      const action = url.pathname.split('/').at(-1);
      log('info', `gallery.trash_${action}`, { album: result.name });
      return sendJson(res, 200, { entry: result });
    } catch (error) {
      const status = /already exists/.test(error.message) ? 409 : 400;
      return sendJson(res, status, { error: error.message });
    } finally { galleryTrashRunning = false; }
  }
  if (url.pathname === '/api/activity' && req.method === 'GET') return sendJson(res, 200, { events: await readActivity(path.join(DATA_ROOT, 'Logs')) });
  if (url.pathname === '/api/storage/download-cache' && req.method === 'GET') return sendJson(res, 200, { entries: await listDownloadCache(DOWNLOAD_CACHE), busy: downloadJob.status === 'working' || cacheRemovalRunning });
  if (url.pathname === '/api/storage/download-cache' && req.method === 'POST') {
    const body = await readJson(req);
    if (downloadJob.status === 'working' || cacheRemovalRunning) return sendJson(res, 409, { error: 'Wait for the current download or cache removal to finish.' });
    cacheRemovalRunning = true;
    try {
      await removeDownloadCache(DOWNLOAD_CACHE, body.id);
      log('info', 'download.cache_removed', { cache: body.id });
      return sendJson(res, 200, { ok: true });
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
    finally { cacheRemovalRunning = false; }
  }
  if (url.pathname === '/api/storage' && req.method === 'GET') return sendJson(res, 200, await storageInfo());
  if (url.pathname === '/api/storage/previews' && req.method === 'POST') {
    await cleanPreviews(PREVIEW_CACHE, 0);
    log('info', 'preview.cleared');
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/albums/rename' && req.method === 'POST') return renameAlbum(req, res);
  if (url.pathname === '/api/download' && req.method === 'GET') return sendJson(res, 200, { download: downloadJob });
  if (url.pathname === '/api/download' && req.method === 'POST') return startDownload(req, res);
  if (url.pathname.startsWith('/reconstructed/')) return serveReconstructed(req, res, url.pathname.slice(15));
  if (url.pathname.startsWith('/preview/')) return servePreview(req, res, url.pathname.slice(9));
  if (url.pathname.startsWith('/poster/')) return servePoster(req, res, url.pathname.slice(8));
  if (url.pathname.startsWith('/gallery/')) {
    const relative = url.pathname.slice(9);
    const requested = safeResolve(GALLERY, decodeURIComponent(relative));
    if (requested && isMigrated(await physicalPath(requested)) && isJpeg(requested)) return serveReconstructed(req, res, relative);
    return serveFile(req, res, GALLERY, relative);
  }
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  return serveFile(req, res, PUBLIC, requested);
}

async function main() {
  await Promise.all([fsp.mkdir(INBOX, { recursive: true }), fsp.mkdir(GALLERY, { recursive: true }), fsp.mkdir(DOWNLOAD_CACHE, { recursive: true })]);
  await loadState();
  await migration.load();
  setInterval(() => migration.tick(), 2000).unref();
  await getSummary();
  setInterval(() => { invalidateSummary(); getSummary().catch(error => log('error', 'gallery.scan_failed', { error })); }, 60000).unref();
  const cleanupPreviews = () => cleanPreviews(PREVIEW_CACHE).catch(error => log('error', 'preview.cleanup_failed', { error }));
  cleanupPreviews();
  setInterval(cleanupPreviews, 86400000).unref();
  log('info', 'service.started', { inbox: INBOX, gallery: GALLERY, extractor: process.env.SEVENZIP || '7z' });
  setInterval(scanInbox, Math.max(100, Number(process.env.IMAGEWORKS_SCAN_INTERVAL || 2000))).unref();
  await scanInbox();
  http.createServer((req, res) => handleRequest(req, res).catch(error => { log('error', 'request.failed', { method: req.method, pathname: req.url.split('?')[0], error }); sendJson(res, 500, { error: error.message }); }))
    .listen(PORT, HOST, function () { console.log(`ImageWorks is watching ${INBOX}\nGallery: http://${HOST}:${this.address().port}`); })
    .on('error', error => { log('error', 'service.listen_failed', { host: HOST, port: PORT, error }); process.exitCode = 1; });
}

main().catch(error => { log('error', 'service.start_failed', { error }); process.exitCode = 1; });
