const albumGrid = document.querySelector('#album-grid');
const threadGrid = document.querySelector('#thread-grid');
const emptyState = document.querySelector('#empty-state');
const viewer = document.querySelector('#viewer');
const lightbox = document.querySelector('#lightbox');
const photoGrid = document.querySelector('#photo-grid');
const renameDialog = document.querySelector('#rename-dialog');
const downloadPage = document.querySelector('#download-page');
const galleryPage = document.querySelector('#gallery-page');
const storagePage = document.querySelector('#storage-page');
const activityPage = document.querySelector('#activity-page');
let albums = [];
let currentAlbum = null;
let currentImages = [];
let currentIndex = 0;
const pageSizeOptions = [15, 30, 60, 100];
let pageSize = 15;
try {
  const savedPageSize = Number(localStorage.getItem('imageworksPageSize'));
  if (pageSizeOptions.includes(savedPageSize)) pageSize = savedPageSize;
} catch { /* The default still works when browser storage is unavailable. */ }
document.querySelector('#page-size').value = String(pageSize);
let currentPage = 0;
let albumRequest = 0;
let updatingAlbumId = null;
const unavailableThreads = new Set();
function threadKey(album) { return album?.kind === '4chan' ? `${album.source.board}/${album.source.threadId}` : ''; }
const unavailableMessage = 'Thread not currently available on 4chan. Your saved gallery is unchanged. Refresh this page to try again.';
function updateThreadControl(album) {
  const button = document.querySelector('#update-thread');
  const unavailable = unavailableThreads.has(threadKey(album));
  const updating = updatingAlbumId === album?.id;
  button.disabled = unavailable || Boolean(updatingAlbumId);
  button.textContent = unavailable ? 'Thread unavailable' : updating ? 'Updating…' : 'Update thread';
  button.classList.toggle('unavailable', unavailable);
  button.title = unavailable ? unavailableMessage : '';
  document.querySelector('#thread-update-message').textContent = unavailable ? unavailableMessage : '';
}
const fullImage = document.querySelector('#full-image');
const fullVideo = document.querySelector('#full-video');
let viewingVideo = false;
const imageStage = document.querySelector('#image-stage');
const zoomLevel = document.querySelector('#zoom-reset');
let imageZoom = 1;
let imagePanX = 0;
let imagePanY = 0;
let dragStart = null;

function renderImageTransform() {
  fullImage.style.transform = `translate(${imagePanX}px, ${imagePanY}px) scale(${imageZoom})`;
  zoomLevel.textContent = `${Math.round(imageZoom * 100)}%`;
  imageStage.classList.toggle('zoomed', imageZoom > 1);
}

function setImageZoom(nextZoom, originX = 0, originY = 0) {
  if (viewingVideo) return;
  const oldZoom = imageZoom;
  imageZoom = Math.min(5, Math.max(1, nextZoom));
  if (imageZoom === 1) {
    imagePanX = 0;
    imagePanY = 0;
  } else if (oldZoom !== imageZoom) {
    const ratio = imageZoom / oldZoom;
    imagePanX = originX - (originX - imagePanX) * ratio;
    imagePanY = originY - (originY - imagePanY) * ratio;
  }
  renderImageTransform();
}

function resetImageView() {
  imageZoom = 1;
  imagePanX = 0;
  imagePanY = 0;
  dragStart = null;
  imageStage.classList.remove('dragging');
  renderImageTransform();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: unit ? 1 : 0 }).format(bytes / 1000 ** unit)} ${units[unit]}`;
}

function renderAlbums() {
  albumGrid.replaceChildren();
  threadGrid.replaceChildren();
  emptyState.hidden = albums.length > 0;
  document.querySelector('#album-count').textContent = albums.length;
  document.querySelector('#image-count').textContent = albums.reduce((sum, album) => sum + album.count, 0);
  document.querySelector('#gallery-size').textContent = formatBytes(albums.reduce((sum, album) => sum + (album.sizeBytes || 0), 0));
  const query = (document.querySelector('#gallery-search').value || '').trim().toLocaleLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const matches = albums.filter(album => {
    const text = [album.name, album.model, album.set, album.source?.title, album.source?.board, album.source?.threadId].filter(Boolean).join(' ').toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
  const searchResults = document.querySelector('#search-results');
  searchResults.hidden = !query;
  searchResults.textContent = matches.length
    ? `${matches.length} of ${albums.length} galleries match`
    : 'No galleries match your search. Try another name or clear the search.';
  const collections = matches.filter(album => album.kind !== '4chan');
  const threads = matches.filter(album => album.kind === '4chan');
  document.querySelector('#collection-section').hidden = collections.length === 0;
  document.querySelector('#thread-section').hidden = threads.length === 0;
  document.querySelector('#collection-count').textContent = `${collections.length} ${collections.length === 1 ? 'gallery' : 'galleries'}`;
  document.querySelector('#thread-count').textContent = `${threads.length} ${threads.length === 1 ? 'thread' : 'threads'}`;
  for (const album of [...collections, ...threads]) {
    const isThread = album.kind === '4chan';
    const card = el('article', `album${isThread ? ' thread-album' : ''}`);
    const button = el('button', 'album-open');
    button.type = 'button';
    button.setAttribute('aria-label', `Open ${album.model ? `${album.model}, ${album.set}` : album.name}, ${album.count} files`);
    const cover = el('div', 'album-cover');
    const image = new Image(); image.loading = 'lazy'; image.src = album.cover; image.alt = '';
    cover.append(image);
    if (album.coverType === 'video') cover.append(el('span', 'video-badge', '▶ WEBM'));
    if (isThread) cover.append(el('span', 'thread-badge', '4CHAN'));
    const meta = el('div', 'album-meta');
    if (album.model) meta.append(el('span', 'album-model', album.model));
    if (isThread) meta.append(el('span', 'thread-source', `/${album.source.board}/ · No.${album.source.threadId}`));
    meta.append(el('strong', '', album.set), el('span', '', `${album.count} file${album.count === 1 ? '' : 's'}`));
    button.append(cover, meta);
    button.addEventListener('click', () => openAlbum(album));
    card.append(button);
    if (isThread) {
      const unavailable = unavailableThreads.has(threadKey(album));
      const update = el('button', `thread-update${unavailable ? ' unavailable' : ''}`, unavailable ? 'Unavailable' : updatingAlbumId === album.id ? 'Updating…' : 'Update');
      update.type = 'button';
      update.disabled = unavailable || Boolean(updatingAlbumId);
      update.title = unavailable ? unavailableMessage : '';
      update.setAttribute('aria-label', unavailable ? `${album.set}: thread unavailable` : `Update ${album.set}`);
      update.addEventListener('click', () => updateThread(album));
      card.append(update);
    }
    (isThread ? threadGrid : albumGrid).append(card);
  }
}

function showPage() {
  const page = ['#download', '#storage', '#activity'].includes(location.hash) ? location.hash.slice(1) : 'gallery';
  galleryPage.hidden = page !== 'gallery';
  downloadPage.hidden = page !== 'download';
  storagePage.hidden = page !== 'storage';
  activityPage.hidden = page !== 'activity';
  if (page === 'activity') refreshActivity();
  if (page === 'storage') refreshStorage();
  document.querySelectorAll('[data-page-link]').forEach(link => link.classList.toggle('active', link.dataset.pageLink === page));
}

function renderDownload(job) {
  const panel = document.querySelector('#download-job');
  panel.className = `download-job ${job.status}`;
  document.querySelector('#download-message').textContent = job.message;
  document.querySelector('#download-percent').textContent = `${job.progress || 0}%`;
  const bar = document.querySelector('#download-progress');
  bar.style.width = `${job.progress || 0}%`;
  bar.parentElement.setAttribute('aria-valuenow', job.progress || 0);
  document.querySelector('#download-log').textContent = job.log.length ? job.log.join('\n') : 'Downloads will appear here.';
  document.querySelector('#download-submit').disabled = job.status === 'working';
  if (job.status !== 'working' && updatingAlbumId) {
    const updatedId = updatingAlbumId;
    const updatedAlbum = albums.find(album => album.id === updatedId) || (currentAlbum?.id === updatedId ? currentAlbum : null);
    if (job.status === 'error' && job.errorCode === 'THREAD_NOT_FOUND' && updatedAlbum) unavailableThreads.add(threadKey(updatedAlbum));
    updatingAlbumId = null;
    renderAlbums();
    if (currentAlbum?.id === updatedId && currentAlbum.kind === '4chan') {
      updateThreadControl(currentAlbum);
      if (job.status === 'error' && job.errorCode !== 'THREAD_NOT_FOUND') document.querySelector('#thread-update-message').textContent = `${job.message} You can try updating again.`;
      if (job.status === 'success' && viewer.open && job.album === currentAlbum.id) {
        const updated = albums.find(album => album.id === currentAlbum.id);
        if (updated) openAlbum(updated, currentPage);
      }
    }
  }
}

async function requestDownload(url, includeWebm = false) {
  const response = await fetch('/api/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, includeWebm })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not start the download.');
  renderDownload(result.download);
}

async function startDownload(event) {
  event.preventDefault();
  const input = document.querySelector('#source-url');
  const error = document.querySelector('#download-error');
  error.textContent = '';
  try {
    await requestDownload(input.value.trim(), document.querySelector('#include-webm').checked);
  } catch (downloadError) { error.textContent = downloadError.message; }
}

async function updateThread(album) {
  const url = album.source.sourceUrl || `https://boards.4chan.org/${album.source.board}/thread/${album.source.threadId}`;
  if (unavailableThreads.has(threadKey(album))) return;
  updatingAlbumId = album.id;
  renderAlbums();
  if (currentAlbum?.id === album.id) updateThreadControl(album);
  try {
    await requestDownload(url, currentAlbum?.id === album.id && viewer.open ? document.querySelector('#thread-include-webm').checked : album.source.includeWebm === true);
  } catch (error) {
    updatingAlbumId = null;
    renderAlbums();
    if (currentAlbum?.id === album.id && currentAlbum.kind === '4chan') {
      updateThreadControl(currentAlbum);
      document.querySelector('#thread-update-message').textContent = `${error.message} You can try updating again.`;
    }
    const status = document.querySelector('#status');
    status.className = 'status error';
    status.lastElementChild.textContent = error.message;
  }
}

function setPageStatus(text) {
  for (const suffix of ['', '-bottom']) document.querySelector(`#page-status${suffix}`).textContent = text;
}

function renderPhotoPage(page = 0) {
  const pages = Math.max(1, Math.ceil(currentImages.length / pageSize));
  currentPage = Math.max(0, Math.min(page, pages - 1));
  const start = currentPage * pageSize;
  photoGrid.replaceChildren();
  currentImages.slice(start, start + pageSize).forEach((item, offset) => {
    const button = el('button'); button.type = 'button'; button.setAttribute('aria-label', `View ${item.name}`);
    const image = new Image(); image.loading = 'lazy'; image.src = item.poster || item.preview || item.url; image.alt = item.name;
    button.append(image);
    if (item.type === 'video') button.append(el('span', 'video-badge', '▶ WEBM'));
    button.addEventListener('click', () => openImage(start + offset)); photoGrid.append(button);
  });
  setPageStatus(currentImages.length
    ? `Page ${currentPage + 1} of ${pages} · ${start + 1}–${Math.min(start + pageSize, currentImages.length)} of ${currentImages.length}`
    : 'No files');
  for (const suffix of ['', '-bottom']) {
    document.querySelector(`#page-previous${suffix}`).disabled = currentPage === 0;
    document.querySelector(`#page-next${suffix}`).disabled = currentPage >= pages - 1;
    const numbers = document.querySelector(`#page-numbers${suffix}`);
    numbers.replaceChildren();
    // Keep the first, last and nearby pages visible even in very large galleries.
    const visiblePages = Array.from({ length: pages }, (_, index) => index)
      .filter(index => pages <= 7 || index === 0 || index === pages - 1 || Math.abs(index - currentPage) <= 2);
    let previousPage = -1;
    for (const index of visiblePages) {
      if (previousPage >= 0 && index - previousPage > 1) numbers.append(el('span', 'page-gap', '…'));
      const button = el('button', 'page-number', String(index + 1));
      button.type = 'button';
      button.setAttribute('aria-label', `Page ${index + 1}`);
      if (index === currentPage) button.setAttribute('aria-current', 'page');
      button.addEventListener('click', () => { renderPhotoPage(index); viewer.scrollTop = 0; });
      numbers.append(button);
      previousPage = index;
    }
  }
}

async function openAlbum(album, page = 0) {
  if (lightbox.open) lightbox.close();
  stopVideo();
  const request = ++albumRequest;
  currentAlbum = album;
  currentImages = [];
  renderPhotoPage();
  setPageStatus('Loading…');
  document.querySelector('#viewer-error').textContent = '';
  const viewerLabel = album.kind === '4chan' ? `4CHAN · /${album.source.board}/ · No.${album.source.threadId}` : album.model;
  document.querySelector('#viewer-model').textContent = viewerLabel;
  document.querySelector('#viewer-model').hidden = !viewerLabel;
  document.querySelector('#viewer-title').textContent = album.set;
  document.querySelector('#viewer-count').textContent = `${album.count} file${album.count === 1 ? '' : 's'}`;
  const updateButton = document.querySelector('#update-thread');
  updateButton.hidden = album.kind !== '4chan';
  document.querySelector('#thread-webm-option').hidden = album.kind !== '4chan';
  document.querySelector('#thread-include-webm').checked = album.source?.includeWebm === true;
  updateThreadControl(album);
  if (!viewer.open) viewer.showModal();
  viewer.scrollTop = 0;
  updateBackToTop();
  try {
    const response = await fetch(`/api/albums?id=${encodeURIComponent(album.id)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load gallery.');
    const data = await response.json();
    if (request !== albumRequest || !viewer.open) return;
    const details = data.albums[0];
    if (!details) throw new Error('This gallery is no longer available.');
    currentAlbum = details;
    currentImages = details.images;
    document.querySelector('#thread-include-webm').checked = details.source?.includeWebm === true;
    document.querySelector('#viewer-count').textContent = `${details.count} file${details.count === 1 ? '' : 's'}`;
    renderPhotoPage(page);
  } catch (error) {
    if (request !== albumRequest || !viewer.open) return;
    setPageStatus('Unable to load');
    document.querySelector('#viewer-error').textContent = error.message;
  }
}

function showRename() {
  document.querySelector('#new-name').value = currentAlbum.name;
  document.querySelector('#rename-error').textContent = '';
  renameDialog.showModal();
  document.querySelector('#new-name').select();
}

async function renameCurrentAlbum(event) {
  event.preventDefault();
  const input = document.querySelector('#new-name');
  const error = document.querySelector('#rename-error');
  const name = input.value.trim();
  if (!name) return input.focus();
  error.textContent = '';
  try {
    const response = await fetch('/api/albums/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentAlbum.id, name })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not rename gallery.');
    renameDialog.close();
    await refresh(true);
    const updated = albums.find(album => album.id === result.album.name);
    if (updated) openAlbum(updated);
  } catch (renameError) { error.textContent = renameError.message; }
}

function stopVideo() {
  fullVideo.pause();
  fullVideo.removeAttribute('src');
  fullVideo.removeAttribute('poster');
  fullVideo.load();
}

function openImage(index) {
  if (!currentImages.length) return;
  currentIndex = (index + currentImages.length) % currentImages.length;
  const item = currentImages[currentIndex];
  const page = Math.floor(currentIndex / pageSize);
  if (page !== currentPage) renderPhotoPage(page);
  stopVideo();
  resetImageView();
  viewingVideo = item.type === 'video';
  fullImage.hidden = viewingVideo;
  fullVideo.hidden = !viewingVideo;
  imageStage.classList.toggle('video-stage', viewingVideo);
  document.querySelector('.zoom-controls').hidden = viewingVideo;
  document.querySelector('#video-error').hidden = true;
  const original = document.querySelector('#download-original');
  original.hidden = !viewingVideo && !item.jxl;
  original.textContent = viewingVideo ? 'Download original WebM' : 'Download original JPEG';
  if (item.jxl) { original.href = `${item.url}?download=1`; original.download = item.name; }
  if (viewingVideo) {
    fullImage.removeAttribute('src');
    fullVideo.muted = true;
    fullVideo.poster = item.poster || '';
    fullVideo.src = item.url;
    original.href = `${item.url}?download=1`;
    original.download = item.name;
  } else {
    fullImage.src = item.url;
    fullImage.alt = item.name;
  }
  document.querySelector('#caption').textContent = `${item.name} · ${currentIndex + 1} of ${currentImages.length}`;
  if (!lightbox.open) lightbox.showModal();
}

async function refresh(force = false) {
  try {
    const [albumResponse, downloadResponse] = await Promise.all([
      fetch('/api/albums?summary=1', { cache: 'no-store' }), fetch('/api/download', { cache: 'no-store' })
    ]);
    if (!albumResponse.ok || !downloadResponse.ok) throw new Error('Gallery unavailable');
    const data = await albumResponse.json();
    const downloadData = await downloadResponse.json();
    const fingerprint = JSON.stringify(data.albums);
    const oldFingerprint = JSON.stringify(albums);
    albums = data.albums;
    if (force || fingerprint !== oldFingerprint) renderAlbums();
    const status = document.querySelector('#status');
    status.className = `status ${data.activity.status}`;
    status.lastElementChild.textContent = data.activity.message;
    renderDownload(downloadData.download);
  } catch {
    const status = document.querySelector('#status'); status.className = 'status error'; status.lastElementChild.textContent = 'Connection lost';
  }
}

for (const suffix of ['', '-bottom']) {
  document.querySelector(`#page-previous${suffix}`).addEventListener('click', () => { renderPhotoPage(currentPage - 1); viewer.scrollTop = 0; });
  document.querySelector(`#page-next${suffix}`).addEventListener('click', () => { renderPhotoPage(currentPage + 1); viewer.scrollTop = 0; });
}
viewer.addEventListener('close', () => {
  albumRequest++;
  if (lightbox.open) lightbox.close();
  stopVideo();
  currentImages = [];
  photoGrid.replaceChildren();
});
document.querySelector('#close').addEventListener('click', () => viewer.close());
document.querySelector('#back').addEventListener('click', () => viewer.close());
document.querySelector('#rename').addEventListener('click', showRename);
document.querySelector('#update-thread').addEventListener('click', () => currentAlbum && updateThread(currentAlbum));
document.querySelector('#rename-cancel').addEventListener('click', () => renameDialog.close());
document.querySelector('#rename-form').addEventListener('submit', renameCurrentAlbum);
document.querySelector('#download-form').addEventListener('submit', startDownload);
document.querySelector('#lightbox-close').addEventListener('click', () => lightbox.close());
document.querySelector('#previous').addEventListener('click', () => openImage(currentIndex - 1));
document.querySelector('#next').addEventListener('click', () => openImage(currentIndex + 1));
document.querySelector('#zoom-in').addEventListener('click', () => setImageZoom(imageZoom * 1.25));
document.querySelector('#zoom-out').addEventListener('click', () => setImageZoom(imageZoom / 1.25));
zoomLevel.addEventListener('click', resetImageView);
lightbox.addEventListener('close', () => { stopVideo(); viewingVideo = false; resetImageView(); fullImage.removeAttribute('src'); });
fullVideo.addEventListener('error', () => { if (viewingVideo && fullVideo.hasAttribute('src')) document.querySelector('#video-error').hidden = false; });
imageStage.addEventListener('wheel', event => {
  if (viewingVideo) return;
  event.preventDefault();
  const rect = imageStage.getBoundingClientRect();
  setImageZoom(imageZoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
}, { passive: false });
imageStage.addEventListener('dblclick', event => {
  const rect = imageStage.getBoundingClientRect();
  setImageZoom(imageZoom > 1 ? 1 : 2, event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
});
imageStage.addEventListener('pointerdown', event => {
  if (viewingVideo || imageZoom === 1 || event.button !== 0) return;
  dragStart = { x: event.clientX, y: event.clientY, panX: imagePanX, panY: imagePanY };
  imageStage.setPointerCapture(event.pointerId);
  imageStage.classList.add('dragging');
});
imageStage.addEventListener('pointermove', event => {
  if (!dragStart) return;
  imagePanX = dragStart.panX + event.clientX - dragStart.x;
  imagePanY = dragStart.panY + event.clientY - dragStart.y;
  renderImageTransform();
});
function stopImageDrag() {
  dragStart = null;
  imageStage.classList.remove('dragging');
}
imageStage.addEventListener('pointerup', stopImageDrag);
imageStage.addEventListener('pointercancel', stopImageDrag);
document.addEventListener('keydown', event => {
  if (!lightbox.open || (viewingVideo && event.target === fullVideo)) return;
  if (event.key === 'ArrowLeft') openImage(currentIndex - 1);
  if (event.key === 'ArrowRight') openImage(currentIndex + 1);
});
function updateBackToTop() {
  document.querySelector('#back-to-top').hidden = window.scrollY < 300 || viewer.open || galleryPage.hidden;
  document.querySelector('#gallery-back-to-top').hidden = !viewer.open || viewer.scrollTop < 300;
}

function scrollBackToTop(target) {
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
  target.scrollTo({ top: 0, behavior });
}

document.querySelector('#back-to-top').addEventListener('click', () => scrollBackToTop(window));
document.querySelector('#gallery-back-to-top').addEventListener('click', () => scrollBackToTop(viewer));
window.addEventListener('scroll', updateBackToTop, { passive: true });
viewer.addEventListener('scroll', updateBackToTop, { passive: true });
viewer.addEventListener('close', updateBackToTop);
window.addEventListener('hashchange', updateBackToTop);
document.querySelector('#gallery-search').addEventListener('input', renderAlbums);
window.addEventListener('hashchange', showPage);
showPage();
refresh();
setInterval(refresh, 3000);

document.querySelector('#page-size').addEventListener('change', event => {
  const firstVisibleIndex = currentPage * pageSize;
  const selectedSize = Number(event.target.value);
  if (!pageSizeOptions.includes(selectedSize)) return;
  pageSize = selectedSize;
  try { localStorage.setItem('imageworksPageSize', String(pageSize)); } catch { /* Keep the choice for this session. */ }
  renderPhotoPage(Math.floor(firstVisibleIndex / pageSize));
  viewer.scrollTop = 0;
});

async function refreshStorage() {
  const message = document.querySelector('#storage-message');
  message.textContent = 'Calculating storage usage…';
  try {
    const response = await fetch('/api/storage', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not read storage usage.');
    const data = await response.json();
    const list = document.querySelector('#storage-sizes');
    list.replaceChildren();
    for (const [label, bytes] of [['Gallery media', data.sizes.gallery], ['Inbox', data.sizes.inbox], ['Processed archives', data.sizes.processed], ['Gallery Trash', data.sizes.trash], ['Download cache', data.sizes.downloads], ['Image previews', data.sizes.previews], ['Video posters', data.sizes.posters], ['Drive free', data.free], ['Drive total', data.total]]) {
      const item = el('div'); item.append(el('dt', '', label), el('dd', '', formatBytes(bytes))); list.append(item);
    }
    document.querySelector('#storage-clear-previews').disabled = false;
    message.textContent = 'Folder sizes are measured on request.';
  } catch (error) { message.textContent = error.message; }
}
document.querySelector('#storage-refresh').addEventListener('click', refreshStorage);
document.querySelector('#storage-clear-previews').addEventListener('click', async event => {
  if (!window.confirm('Clear cached image previews? They will be recreated as you browse. Original images are kept.')) return;
  event.target.disabled = true;
  try {
    const response = await fetch('/api/storage/previews', { method: 'POST' });
    if (!response.ok) throw new Error('Could not clear image previews.');
    await refreshStorage();
    document.querySelector('#storage-message').textContent = 'Image previews cleared. They will be recreated as needed.';
  } catch (error) { document.querySelector('#storage-message').textContent = error.message; event.target.disabled = false; }
});

async function refreshActivity() {
  const status = document.querySelector('#activity-status');
  try {
    const response = await fetch('/api/activity', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load activity.');
    const { events } = await response.json();
    const list = document.querySelector('#activity-list');
    list.replaceChildren();
    const labels = { 'service.started': 'ImageWorks started', 'archive.import_started': 'Import started', 'archive.import_completed': 'Import completed', 'archive.moved_to_processed': 'Archive moved to Processed', 'archive.import_failed': 'Import failed', 'archive.move_failed': 'Could not move archive', 'download.started': 'Download started', 'download.completed': 'Download completed', 'download.failed': 'Download failed', 'gallery.trash_move': 'Gallery moved to Trash', 'gallery.trash_restore': 'Gallery restored', 'gallery.trash_delete': 'Gallery permanently deleted' };
    for (const event of events) {
      const item = el('li', event.level === 'error' ? 'activity-entry activity-error' : 'activity-entry');
      const date = new Date(event.timestamp);
      const time = el('time', '', Number.isNaN(date.getTime()) ? event.timestamp : date.toLocaleString());
      time.dateTime = event.timestamp;
      item.append(time, el('strong', '', labels[event.event] || event.event.replaceAll('.', ' ').replaceAll('_', ' ')));
      const details = [];
      if (event.archive) details.push(event.archive);
      if (event.album) details.push(`Gallery: ${event.album}`);
      if (Number.isInteger(event.images)) details.push(`${event.images} files`);
      if (Number.isInteger(event.added)) details.push(`${event.added} files added`);
      if (event.message) details.push(event.message);
      if (event.retryInSeconds) details.push(`Retry in ${event.retryInSeconds} seconds`);
      if (details.length) item.append(el('p', '', details.join(' · ')));
      list.append(item);
    }
    status.textContent = events.length ? '' : 'No activity recorded yet.';
  } catch (error) { status.textContent = error.message; }
}
document.querySelector('#activity-refresh').addEventListener('click', refreshActivity);
setInterval(() => { if (!activityPage.hidden) refreshActivity(); }, 15000);

async function refreshDownloadCache() {
  const status = document.querySelector('#cache-status');
  status.textContent = 'Loading cached downloads…';
  try {
    const response = await fetch('/api/storage/download-cache', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not read download cache.');
    const data = await response.json();
    const list = document.querySelector('#cache-list');
    list.replaceChildren();
    for (const entry of data.entries) {
      const item = el('li', 'cache-entry');
      const details = el('div');
      details.append(el('strong', '', `${entry.source} · ${entry.name}`), el('p', '', `${formatBytes(entry.sizeBytes)} · ${entry.files} files · folder changed ${new Date(entry.modifiedAt).toLocaleString()}`));
      const remove = el('button', 'text-button', 'Remove cached files');
      remove.type = 'button'; remove.disabled = data.busy;
      remove.setAttribute('aria-label', `Remove cached files for ${entry.source} ${entry.name}`);
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Remove cached files for ${entry.source} · ${entry.name}? Retry history will be lost. Gallery files are kept.`)) return;
        remove.disabled = true;
        try {
          const response = await fetch('/api/storage/download-cache', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: entry.id }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Could not remove cache entry.');
          await Promise.all([refreshDownloadCache(), refreshStorage()]);
          status.textContent = 'Cached files removed. Gallery files are kept.';
        } catch (error) { status.textContent = error.message; remove.disabled = false; }
      });
      item.append(details, remove); list.append(item);
    }
    status.textContent = data.busy ? 'Removal is unavailable while a download is running.' : data.entries.length ? `${data.entries.length} cached downloads. Completion status is not recorded; review before removing.` : 'No recognised cached downloads found.';
  } catch (error) { status.textContent = error.message; }
}
document.querySelector('#cache-refresh').addEventListener('click', refreshDownloadCache);

document.querySelector('#jxl-pilot').addEventListener('click', async () => {
  if (!currentAlbum || !window.confirm('Create a separate JPEG XL pilot gallery? Every JPEG will be checked against the original. The current gallery will be kept, and the pilot will use additional disk space.')) return;
  try {
    const response = await fetch('/api/jxl-pilot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: currentAlbum.id }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not start pilot.');
    await refreshPilot();
  } catch (error) { document.querySelector('#pilot-status').textContent = error.message; }
});
async function refreshPilot() {
  try {
    const response = await fetch('/api/jxl-pilot', { cache: 'no-store' });
    if (!response.ok) return;
    const { pilot } = await response.json();
    const status = document.querySelector('#pilot-status');
    if (pilot.status === 'working') status.textContent = `JPEG XL pilot: ${pilot.done} of ${pilot.total || '?'} JPEGs verified.`;
    else if (pilot.status === 'success') status.textContent = `Pilot ready: ${pilot.name}. ${pilot.total} JPEGs verified; ${formatBytes(pilot.inputBytes)} → ${formatBytes(pilot.outputBytes)}. Find it in the gallery list.`;
    else if (pilot.status === 'error') status.textContent = `Pilot failed: ${pilot.message}`;
  } catch { /* The regular status indicator reports connection errors. */ }
}
setInterval(() => { if (viewer.open) refreshPilot(); }, 3000);

document.querySelector('#trash-gallery').addEventListener('click', async event => {
  if (!currentAlbum) return;
  const album = currentAlbum;
  const size = formatBytes(album.sizeBytes || 0);
  if (!window.confirm(`Move “${album.name}” to Trash?\n\nGallery media: ${size}. You can restore it from the Storage tab.`)) return;
  event.target.disabled = true;
  try {
    const response = await fetch('/api/gallery-trash/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: album.id }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not move gallery to Trash.');
    if (viewer.open && currentAlbum?.id === album.id) viewer.close();
    await refresh(true);
  } catch (error) { document.querySelector('#viewer-error').textContent = error.message; }
  finally { event.target.disabled = false; }
});
async function refreshTrash() {
  const status = document.querySelector('#trash-status');
  status.textContent = 'Loading Trash…';
  try {
    const response = await fetch('/api/gallery-trash', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load Trash.');
    const { entries } = await response.json();
    const list = document.querySelector('#trash-list');
    list.replaceChildren();
    for (const entry of entries) {
      const item = el('li', 'trash-entry');
      const details = el('div');
      details.append(el('strong', '', entry.name), el('p', '', `${formatBytes(entry.sizeBytes)} · moved ${new Date(entry.trashedAt).toLocaleString()}`));
      const actions = el('div', 'trash-actions');
      for (const [action, label] of [['restore', 'Restore'], ['delete', 'Delete permanently']]) {
        const button = el('button', action === 'delete' ? 'text-button danger-button' : 'text-button', label);
        button.type = 'button';
        button.setAttribute('aria-label', `${label}: ${entry.name}`);
        button.addEventListener('click', async () => {
          if (action === 'delete' && !window.confirm(`Permanently delete “${entry.name}” (${formatBytes(entry.sizeBytes)}) from Trash? This cannot be undone.`)) return;
          button.disabled = true;
          try {
            const response = await fetch(`/api/gallery-trash/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: entry.id }) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Could not update Trash.');
            await Promise.all([refreshTrash(), refreshStorage(), refresh(true)]);
            status.textContent = action === 'restore' ? 'Gallery restored.' : 'Gallery permanently deleted.';
          } catch (error) { status.textContent = error.message; button.disabled = false; }
        });
        actions.append(button);
      }
      item.append(details, actions); list.append(item);
    }
    status.textContent = entries.length ? `${entries.length} ${entries.length === 1 ? 'gallery' : 'galleries'} in Trash.` : 'Trash is empty.';
  } catch (error) { status.textContent = error.message; }
}
document.querySelector('#trash-refresh').addEventListener('click', refreshTrash);
