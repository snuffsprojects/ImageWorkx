const path = require('node:path');

const origin = 'https://bunkr.cr';
const downloadOrigin = 'https://dl.bunkr.cr';

function bunkrAlbumId(url) {
  if (!['bunkr.cr', 'www.bunkr.cr'].includes(url.hostname)) return null;
  return url.pathname.match(/^\/a\/([a-z0-9]+)\/?$/i)?.[1] || null;
}

async function bunkrPosts(id, request, headers, images) {
  const response = await request(origin + '/a/' + id + '?advanced=1', {
    headers, redirect: 'error', signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Bunkr album returned HTTP ' + response.status + '.');
  const list = (await response.text()).match(/window\.albumFiles\s*=\s*\[([\s\S]*?)<\/script>/)?.[1];
  if (!list) throw new Error('Bunkr did not return an album file list.');

  // The album embeds JavaScript object literals. Read only the fields we need.
  const posts = [];
  for (const [entry] of list.matchAll(/\{(?:"(?:\\.|[^"\\])*"|[^"{}])*\}/g)) {
    const fileId = entry.match(/^\s*id:\s*(\d+)\s*,/m)?.[1];
    const filename = entry.match(/^\s*original:\s*("(?:\\.|[^"\\])*")\s*,/m)?.[1];
    if (!fileId || !filename) continue;
    let original;
    try { original = JSON.parse(filename.replace(/\\'/g, "'")); }
    catch { continue; }
    const { name, ext } = path.parse(original);
    const extension = ext.toLowerCase();
    if (!images.has(extension)) continue;
    const size = Number(entry.match(/^\s*size:\s*(\d+)\s*,/m)?.[1]) || 0;
    posts.push({ id: fileId, name, ext: extension, size });
  }
  if (!posts.length) throw new Error('Bunkr album contains no supported images.');
  return posts;
}

async function requestBunkrFile(post, request, headers) {
  const referer = downloadOrigin + '/file/' + post.id;
  const response = await request(downloadOrigin + '/api/_001_v2', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Origin: downloadOrigin, Referer: referer },
    body: JSON.stringify({ id: post.id }),
    redirect: 'error',
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Bunkr download API returned HTTP ' + response.status + '.');

  const data = await response.json();
  if (typeof data.mediafiles !== 'string' || typeof data.path !== 'string' || !data.path.startsWith('/')) {
    throw new Error('Bunkr returned invalid download metadata.');
  }
  const location = data.mediafiles + data.path;
  const url = URL.canParse(location) && new URL(location);
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password ||
      !/^[a-z0-9-]+\.(?:cdn\.cr|scdn\.st)$/i.test(url.hostname)) {
    throw new Error('Bunkr returned an unexpected media URL.');
  }
  // Use the same signing service as Bunkr's public download button.
  const signUrl = new URL('https://glb-apisign.cdn.cr/sign');
  signUrl.searchParams.set('path', decodeURIComponent(url.pathname));
  const signed = await request(signUrl.href, {
    headers: { ...headers, Origin: downloadOrigin, Referer: referer },
    redirect: 'error', signal: AbortSignal.timeout(30000)
  });
  if (!signed.ok) throw new Error('Bunkr signing service returned HTTP ' + signed.status + '.');
  const { token, ex } = await signed.json();
  if (typeof token !== 'string' || !token || !ex) throw new Error('Bunkr returned an invalid download signature.');
  url.searchParams.set('token', token);
  url.searchParams.set('ex', ex);
  const media = await request(url.href, {
    headers: { ...headers, Referer: referer }, redirect: 'error', signal: AbortSignal.timeout(120000)
  });
  if (!media.ok || !/^image\/|^application\/octet-stream(?:;|$)/i.test(media.headers.get('content-type') || '')) {
    await media.body?.cancel();
    if (media.ok) throw new Error('Bunkr returned a response other than an image.');
  }
  return media;
}

module.exports = { bunkrAlbumId, bunkrPosts, requestBunkrFile };
