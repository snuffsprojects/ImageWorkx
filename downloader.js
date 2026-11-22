const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const { execFile } = require('node:child_process');
const { bunkrAlbumId, bunkrPosts, requestBunkrFile } = require('./bunkr');
const run = require('node:util').promisify(execFile);

const images = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff']);
const clean = value => String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 150) || 'Untitled';
async function readJson(file, fallback) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

function goonBoxImageIds(value) {
  const links = value.trim().replace(/\\:/g, ':').split(/\s+/);
  if (links.length > 250) throw new Error('Paste up to 250 GoonBox image links at a time.');
  const ids = links.map(link => {
    const url = URL.canParse(link.replace(/\\$/, '')) && new URL(link.replace(/\\$/, ''));
    const id = url && url.pathname.match(/^\/img\/([a-z0-9]{1,64})\/?$/i)?.[1];
    if (!id || !['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password ||
        !['goonbox.cr', 'www.goonbox.cr'].includes(url.hostname)) {
      throw new Error('Use individual GoonBox image links, one per line.');
    }
    return id;
  });
  return [...new Set(ids)];
}

function goonBoxMediaUrl(value) {
  const url = URL.canParse(value) && new URL(value);
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password ||
      !/(?:^|\.)(?:goonbox\.cr|cuckcapital\.cr|selti-delivery\.ru|jpe?g\.pet|jpg\.(?:homes|church|fish|fishing)|host\.church|jpg[1-6]\.su|jpg7\.cr)$/i.test(url.hostname)) {
    throw new Error('GoonBox returned an unexpected original image URL.');
  }
  return url;
}

async function downloadMedia(source, root, log, request = fetch, { includeWebm = false, batch } = {}) {
  const headers = { 'User-Agent': 'ImageWorks Gallery' };
  async function json(url, options = {}) {
    const response = await request(url, { headers, signal: AbortSignal.timeout(30000), ...options });
    if (!response.ok) { const error = new Error(`Source returned HTTP ${response.status}; it may have expired or been deleted.`); error.httpStatus = response.status; throw error; }
    return response.json();
  }
  const url = batch ? null : new URL(source);
  const bunkrId = url && bunkrAlbumId(url);
  let folder, posts;
  if (batch) {
    folder = path.join(root, 'GoonBoxBatch', batch.id);
    posts = batch.ids.map(id => ({ id }));
  } else if (['boards.4chan.org', 'boards.4channel.org'].includes(url.hostname)) {
    const match = url.pathname.match(/^\/([a-z0-9]+)\/thread\/(\d+)(?:\/|$)/i);
    if (!match) throw new Error('Invalid thread URL.');
    const [, board, thread] = match;
    let data;
    try { data = await json(`https://a.4cdn.org/${board}/thread/${thread}.json`); }
    catch (error) { if (error.httpStatus === 404) error.code = 'THREAD_NOT_FOUND'; throw error; }
    folder = path.join(root, board, thread);
    posts = (data.posts || []).filter(p => p.tim && (images.has(p.ext) || (includeWebm && p.ext === '.webm'))).map(p => ({
      id: String(p.tim), ext: p.ext, name: p.filename, size: p.fsize,
      url: `https://i.4cdn.org/${board}/${p.tim}${p.ext}`
    }));
  } else if (['goonbox.cr', 'www.goonbox.cr'].includes(url.hostname)) {
    const match = url.pathname.match(/^\/a\/([a-z0-9]+)(?:\/|$)/i);
    if (!match) throw new Error('Invalid album URL.');
    const id = match[1];
    const api = `https://goonbox.cr/api/albums/${id}`;
    const data = await json(api);
    const title = clean((data.album?.title || id).replace(/\s*\(\d{1,2}[.-]\d{1,2}[.-]\d{2,4}\)\s*$/, ''));
    folder = path.join(root, 'GoonBox', title);
    if (await exists(folder)) {
      let marker = '';
      try { marker = (await fs.readFile(path.join(folder, '.goonbox-album-id'), 'utf8')).trim(); } catch {}
      if (marker !== id) folder = path.join(root, 'GoonBox', `${title} - ${id}`);
    }
    let media = data.images || [];
    const pages = Number(data.pagination?.last_page || 1);
    if (!Number.isInteger(pages) || pages < 1 || pages > 10000) throw new Error('Invalid album pagination.');
    for (let page = 2; page <= pages; page++) media = media.concat((await json(`${api}/images?page=${page}`)).images || []);
    posts = media.map(p => ({ id: String(p.encoded_id), name: path.parse(p.original_filename || '').name,
      ext: (path.extname(p.original_filename || '') || path.extname(new URL(p.original_url).pathname)).toLowerCase(),
      size: p.size_bytes, url: p.original_url })).filter(p => images.has(p.ext));
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, '.goonbox-album-id'), id);
    headers.Referer = source;
  } else if (bunkrId) {
    folder = path.join(root, 'Bunkr', bunkrId);
    posts = await bunkrPosts(bunkrId, request, headers, images);
  } else throw new Error('Unsupported source.');
  await fs.mkdir(folder, { recursive: true });
  const indexFile = path.join(folder, '.download-index.json');
  const index = Object.assign(Object.create(null), await readJson(indexFile, {}));
  log(`Files found: ${posts.length}`);
  let failed = 0;
  const failedLinks = [];
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    let referer;
    const prefix = `[${i + 1}/${posts.length}]`;
    const entry = index[post.id];
    // Accept existing Windows indexes, but never follow a stored path outside this folder.
    if (typeof entry?.file === 'string' && path.basename(entry.file) === entry.file && (!post.size || Number(entry.sourceSize) === Number(post.size)) && await exists(path.join(folder, entry.file))) {
      log(`${prefix} Already downloaded: ${entry.file}`); continue;
    }
    if (batch) {
      referer = 'https://goonbox.cr/img/' + post.id;
      log(prefix + ' Resolving: ' + referer);
      try {
        const options = { redirect: 'error', headers: { ...headers, Referer: referer } };
        let data = await json('https://goonbox.cr/api/images/' + post.id, options);
        if (typeof data.redirect === 'string') {
          const next = new URL(data.redirect, referer);
          if (next.origin !== 'https://goonbox.cr' || !/^\/api\/images\/[a-z0-9]+$/i.test(next.pathname)) {
            throw new Error('GoonBox returned an unexpected image API redirect.');
          }
          data = await json(next.href, options);
        }
        const original = goonBoxMediaUrl(data.image?.original_url);
        const filename = path.parse(data.image.original_filename || original.pathname);
        post.ext = (filename.ext || path.extname(original.pathname)).toLowerCase();
        if (!images.has(post.ext)) throw new Error('Unsupported image format.');
        post.name = filename.name;
        post.size = data.image.size_bytes;
        post.url = original.href;
      } catch (error) {
        failedLinks.push(referer);
        log('FAILED: ' + referer + ': ' + error.message);
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
    }
    const stem = batch ? clean(post.name.slice(0, 150 - post.id.length - 1)) + '-' + post.id : clean(post.name || post.id);
    let filename = `${stem}${post.ext}`;
    if (await exists(path.join(folder, filename))) filename = `${stem}-${clean(post.id)}${post.ext}`;
    // A stale or changed source must never overwrite a completed file.
    let suffix = 2;
    const base = filename;
    while (await exists(path.join(folder, filename))) filename = `${path.parse(base).name} (${suffix++})${post.ext}`;
    const destination = path.join(folder, filename);
    const temp = `${destination}.part`;
    try {
      log(`${prefix} Downloading: ${filename}`);
      const response = bunkrId ? await requestBunkrFile(post, request, headers) : await request(post.url, { ...(batch ? { headers: { ...headers, Referer: referer }, redirect: 'error' } : { headers }), signal: AbortSignal.timeout(120000) });
      if (batch && (!response.ok || !/^(?:image\/|application\/octet-stream(?:;|$))/i.test(response.headers.get('content-type') || ''))) {
        await response.body?.cancel();
        throw new Error(response.ok ? 'GoonBox did not return an image.' : 'HTTP ' + response.status);
      }
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
      const stat = await fs.stat(temp);
      if (!stat.size || (post.size && stat.size !== Number(post.size))) throw new Error('Downloaded size does not match source.');
      let finalFile = filename;
      let converted = false;
      const webpName = `${path.parse(filename).name}.webp`;
      const webp = path.join(folder, webpName);
      const webpTemp = `${webp}.part.webp`;
      if (post.ext === '.png' && !await exists(webp)) {
        try {
          await run('magick', [temp, '-define', 'webp:lossless=true', '-define', 'webp:method=6', webpTemp], { timeout: 120000 });
          await run('magick', ['compare', '-metric', 'AE', temp, webpTemp, 'null:'], { timeout: 120000 });
          if ((await fs.stat(webpTemp)).size < stat.size) {
            await fs.rename(webpTemp, webp);
            finalFile = webpName;
            converted = true;
            log(`Kept lossless WebP: ${webpName}`);
          }
        } catch { /* Missing converter or unverified conversion: preserve the original. */ }
        finally { await fs.rm(webpTemp, { force: true }); }
      }
      if (converted) await fs.rm(temp, { force: true });
      else await fs.rename(temp, destination);
      index[post.id] = { file: finalFile, sourceSize: Number(post.size || 0) };
      await fs.writeFile(indexFile + '.tmp', JSON.stringify(index, null, 2));
      await fs.rename(indexFile + '.tmp', indexFile);
    } catch (error) {
      failed++;
      if (batch) failedLinks.push(referer);
      log(`FAILED: ${filename}: ${error.message}`);
      await fs.rm(temp, { force: true });
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  log(`Saved to: ${folder}`);
  if (batch) return { failedLinks, files: batch.ids.map(id => index[id]?.file).filter(Boolean) };
  if (failed) throw new Error(`${failed} download(s) failed. Completed files remain cached; retry to resume.`);
}

module.exports = { downloadMedia, goonBoxImageIds };
