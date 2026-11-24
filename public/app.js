const albumGrid = document.querySelector('#album-grid');
const threadGrid = document.querySelector('#thread-grid');
const emptyState = document.querySelector('#empty-state');
const viewer = document.querySelector('#viewer');
const lightbox = document.querySelector('#lightbox');
const photoGrid = document.querySelector('#photo-grid');
const renameDialog = document.querySelector('#rename-dialog');
const downloadPage = document.querySelector('#download-page');
const galleryPage = document.querySelector('#gallery-page');
const collectionsPage = document.querySelector('#collections-page');
const storagePage = document.querySelector('#storage-page');
const migrationPage = document.querySelector('#migration-page');
const migrationWorkerPage = document.querySelector('#migration-worker-page');
const activityPage = document.querySelector('#activity-page');
let albums = [];
let tagLibrary = [];
let tagDraft = new Set();
let tagEditingAlbum = null;
let currentAlbum = null;
let currentImages = [];
let currentIndex = 0;
let collectionContext = false;
let activeCollection = null;
let collectionPageIndex = 0;
let collectionPickerSource = null;
let selectingImages = false;
let selectedImages = new Set();
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
  if (bytes < 0) return '−' + formatBytes(-bytes);
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: unit ? 1 : 0 }).format(bytes / 1000 ** unit)} ${units[unit]}`;
}

const migrationLabels = {
  queued: 'JPEG XL conversion queued',
  verified: 'JPEG XL conversion verified',
  attention: 'JPEG XL migration needs attention'
};

function renderAlbums() {
  albumGrid.replaceChildren();
  threadGrid.replaceChildren();
  emptyState.hidden = albums.length > 0;
  document.querySelector('#album-count').textContent = albums.length;
  document.querySelector('#image-count').textContent = albums.reduce((sum, album) => sum + album.count, 0);
  document.querySelector('#gallery-size').textContent = formatBytes(albums.reduce((sum, album) => sum + (album.sizeBytes || 0), 0));
  const filter = document.querySelector('#tag-filter');
  let selectedTag = filter.value || 'all';
  if (!['all', 'untagged'].includes(selectedTag) && !tagLibrary.some(tag => tag.id === selectedTag)) selectedTag = 'all';
  filter.replaceChildren();
  for (const [value, label] of [['all', 'All tags'], ['untagged', 'Untagged'], ...[...tagLibrary].sort((a, b) => a.name.localeCompare(b.name)).map(tag => [tag.id, tag.name])]) { const option = el('option', '', label); option.value = value; filter.append(option); }
  filter.value = selectedTag;
  const query = (document.querySelector('#gallery-search').value || '').trim().toLocaleLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const matches = albums.filter(album => {
    const text = [album.name, album.model, album.set, album.source?.title, album.source?.board, album.source?.threadId].filter(Boolean).join(' ').toLocaleLowerCase();
    const liveIds = (album.tagIds || []).filter(id => tagLibrary.some(tag => tag.id === id));
    return terms.every(term => text.includes(term)) && (selectedTag === 'all' || (selectedTag === 'untagged' ? liveIds.length === 0 : liveIds.includes(selectedTag)));
  });
  const searchResults = document.querySelector('#search-results');
  searchResults.hidden = !query && selectedTag === 'all';
  searchResults.textContent = matches.length
    ? `${matches.length} of ${albums.length} galleries match`
    : 'No galleries match. Try another search or tag.';
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
    if (album.cover) { const image = new Image(); image.loading = 'lazy'; image.src = album.cover; image.alt = ''; cover.append(image); }
    else cover.append(el('span', 'empty-cover', 'Empty gallery'));
    if (album.coverType === 'video') cover.append(el('span', 'video-badge', '▶ WEBM'));
    if (album.migration && migrationLabels[album.migration.state]) {
      const label = migrationLabels[album.migration.state];
      const dot = el('span', 'migration-dot ' + album.migration.state);
      dot.title = label;
      dot.setAttribute('aria-hidden', 'true');
      button.setAttribute('aria-label', button.getAttribute('aria-label') + '. ' + label);
      cover.append(dot);
    }
    if (isThread) cover.append(el('span', 'thread-badge', '4CHAN'));
    const meta = el('div', 'album-meta');
    if (album.model) meta.append(el('span', 'album-model', album.model));
    if (isThread) meta.append(el('span', 'thread-source', `/${album.source.board}/ · No.${album.source.threadId}`));
    meta.append(el('strong', '', album.set), el('span', '', `${album.count} file${album.count === 1 ? '' : 's'}`));
    const matchingTags = tagLibrary.filter(tag => (album.tagIds || []).includes(tag.id));
    if (matchingTags.length) { const chips = el('span', 'album-tags'); for (const tag of matchingTags) chips.append(tagChip(tag)); meta.append(chips); }
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
  const page = ['#collections', '#download', '#storage', '#activity', '#migration', '#migration-worker'].includes(location.hash) ? location.hash.slice(1) : 'gallery';
  galleryPage.hidden = page !== 'gallery';
  collectionsPage.hidden = page !== 'collections';
  if (page === 'collections') refreshCollections();
  downloadPage.hidden = page !== 'download';
  storagePage.hidden = page !== 'storage';
  migrationPage.hidden = page !== 'migration';
  if (page === 'migration') { refreshMigration(); pollCleanup(); }
  migrationWorkerPage.hidden = page !== 'migration-worker';
  if (!migrationWorkerPage.hidden) refreshMigrationWorker();
  activityPage.hidden = page !== 'activity';
  if (page === 'activity') refreshActivity();
  if (page === 'storage') refreshStorage();
  document.querySelectorAll('[data-page-link]').forEach(link => link.classList.toggle('active', link.dataset.pageLink === page));
}

const importLinksForm = document.querySelector('#import-links-form');
const importLinksInput = document.querySelector('#gallery-links');
const importLinksStatus = document.querySelector('#import-links-status');
const importLinksButton = document.querySelector('#import-links');
const importLinksSubmit = document.querySelector('#import-links-submit');
const importLinksProgress = document.querySelector('#import-links-progress');
const importLinksBar = document.querySelector('#import-links-bar');
const importLinksPercent = document.querySelector('#import-links-percent');
let lastLinkImport;

function showLinkImportProgress(percent) {
  importLinksProgress.hidden = false;
  if (percent === undefined) importLinksBar.removeAttribute('value');
  else importLinksBar.value = percent;
  importLinksPercent.textContent = percent === undefined ? '' : percent + '%';
}

function renderLinkImport(job) {
  importLinksSubmit.disabled = job.status === 'working';
  if (!viewer.open || !job.targetGallery || job.targetGallery !== currentAlbum?.id) return;
  if (job.status === 'working') {
    // The download log reports the link currently being processed.
    showLinkImportProgress(job.total ? Math.floor(100 * Math.max(0, job.current - 1) / job.total) : undefined);
    importLinksStatus.textContent = job.total ? `Importing ${job.current} of ${job.total}…` : 'Starting import…';
    return;
  }
  if (lastLinkImport === job.updatedAt) return;
  lastLinkImport = job.updatedAt;
  if (job.total) showLinkImportProgress(job.progress);
  else importLinksProgress.hidden = true;
  importLinksStatus.textContent = job.message;
  if (job.failedLinks?.length) importLinksInput.value = job.failedLinks.join('\n');
  else if (job.status === 'success') importLinksInput.value = '';
  if (job.album) openAlbum(currentAlbum, currentPage);
}

function renderDownload(job) {
  renderLinkImport(job);
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
    const button = el('button'); button.type = 'button'; button.setAttribute('aria-label', `${selectingImages ? 'Select' : 'View'} ${item.name}`);
    if (selectingImages) { button.classList.add('selectable'); button.setAttribute('aria-pressed', selectedImages.has(item.relativePath) ? 'true' : 'false'); }
    const image = new Image(); image.loading = 'lazy'; image.src = item.poster || item.preview || item.url; image.alt = item.name;
    button.append(image);
    if (item.type === 'video') button.append(el('span', 'video-badge', '▶ WEBM'));
    const badge = selectingImages ? el('span', 'selection-badge', selectedImages.has(item.relativePath) ? '✓' : '+') : null;
    if (badge) button.append(badge);
    button.addEventListener('click', () => {
      if (!selectingImages) return openImage(start + offset);
      if (selectedImages.has(item.relativePath)) selectedImages.delete(item.relativePath);
      else if (selectedImages.size < 500) selectedImages.add(item.relativePath);
      else document.querySelector('#batch-status').textContent = 'Select up to 500 files at a time.';
      button.setAttribute('aria-pressed', selectedImages.has(item.relativePath) ? 'true' : 'false');
      badge.textContent = selectedImages.has(item.relativePath) ? '✓' : '+';
      updateBatchControls();
    }); photoGrid.append(button);
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
  if (!viewer.open || currentAlbum?.id !== album.id) {
    document.querySelector('#upload-status').textContent = '';
    importLinksForm.hidden = true;
    importLinksProgress.hidden = true;
    importLinksButton.setAttribute('aria-expanded', 'false');
    importLinksInput.value = '';
    importLinksStatus.textContent = '';
    lastLinkImport = undefined;
  }
  selectingImages = false; selectedImages = new Set(); updateBatchControls();
  collectionContext = false;
  if (lightbox.open) lightbox.close();
  stopVideo();
  const request = ++albumRequest;
  currentAlbum = album;
  currentImages = [];
  renderPhotoPage();
  setPageStatus('Loading…');
  document.querySelector('#viewer-empty').hidden = true;
  document.querySelector('#viewer-error').textContent = '';
  const viewerLabel = album.kind === '4chan' ? `4CHAN · /${album.source.board}/ · No.${album.source.threadId}` : album.model;
  document.querySelector('#viewer-model').textContent = viewerLabel;
  document.querySelector('#viewer-model').hidden = !viewerLabel;
  document.querySelector('#viewer-title').textContent = album.set;
  document.querySelector('#edit-tags').disabled = Boolean(album.tagError);
  if (album.tagError) document.querySelector('#viewer-error').textContent = 'Could not read this gallery’s tag metadata. Check the logs before editing tags.';
  renderViewerTags(album);
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
    document.querySelector('#edit-tags').disabled = Boolean(details.tagError);
    if (details.tagError) document.querySelector('#viewer-error').textContent = 'Could not read this gallery’s tag metadata. Check the logs before editing tags.';
    renderViewerTags(details);
    currentImages = details.images;
    document.querySelector('#viewer-empty').hidden = currentImages.length > 0;
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
  if (!collectionContext && page !== currentPage) renderPhotoPage(page);
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
  document.querySelector('#caption').textContent = `${item.name}${collectionContext ? ` · ${item.sourceName}` : ''} · ${currentIndex + 1} of ${currentImages.length}`;
  document.querySelector('#collection-image-status').textContent = '';
  document.querySelector('#favourite-image').disabled = false;
  document.querySelector('#add-to-collection').disabled = false;
  document.querySelector('#set-gallery-cover').hidden = viewingVideo;
  document.querySelector('#trash-image').hidden = collectionContext;
  document.querySelector('#trash-image').setAttribute('aria-label', viewingVideo ? 'Move original video to Image Trash' : 'Move original image to Image Trash');
  document.querySelector('#remove-from-collection').hidden = !collectionContext;
  document.querySelector('#remove-from-collection').disabled = false;
  if (!lightbox.open) lightbox.showModal();
}

async function refresh(force = false) {
  try {
    const [albumResponse, downloadResponse, tagsResponse] = await Promise.all([
      fetch('/api/albums?summary=1', { cache: 'no-store' }), fetch('/api/download', { cache: 'no-store' }), fetch('/api/tags', { cache: 'no-store' })
    ]);
    if (!albumResponse.ok || !downloadResponse.ok || !tagsResponse.ok) throw new Error('Gallery unavailable');
    const data = await albumResponse.json();
    const downloadData = await downloadResponse.json();
    const nextTags = (await tagsResponse.json()).tags;
    const tagsChanged = JSON.stringify(tagLibrary) !== JSON.stringify(nextTags);
    tagLibrary = nextTags;
    const fingerprint = JSON.stringify(data.albums);
    const oldFingerprint = JSON.stringify(albums);
    albums = data.albums;
    if (force || tagsChanged || fingerprint !== oldFingerprint) renderAlbums();
    if (currentAlbum && viewer.open) {
      const latest = albums.find(album => album.id === currentAlbum.id);
      if (latest && JSON.stringify(currentAlbum.tagIds || []) !== JSON.stringify(latest.tagIds || [])) { currentAlbum.tagIds = latest.tagIds; renderViewerTags(currentAlbum); }
      else if (tagsChanged) renderViewerTags(currentAlbum);
    }
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
  if (!collectionsPage.hidden && activeCollection) refreshCollections();
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
  if (!lightbox.open || document.querySelector('#collection-picker').open || (viewingVideo && event.target === fullVideo)) return;
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

const migrationToggle = document.querySelector('#migration-toggle');
const migrationStatus = document.querySelector('#migration-status');
let migrationEnabled = false;
let migrationRequest = 0;
const migrationCleanupButton = document.querySelector('#migration-cleanup-all');
const migrationCleanupStatus = document.querySelector('#migration-cleanup-status');
const migrationCleanupProgress = document.querySelector('#migration-cleanup-progress');
let cleanupSelection, cleanupJob = null, cleanupStarting = false, cleanupPolling = false, cleanupGeneration = 0;

function cleanupBusy() { return cleanupStarting || cleanupJob?.status === 'working'; }

function cleanupProgressText(job) {
  if (job.phase === 'waiting') return 'Waiting for the current JPEG to finish before cleanup…';
  if (!job.total) return 'Preparing bulk cleanup…';
  const verifying = job.phase === 'verifying';
  const done = verifying ? job.verified : job.cleaned;
  const percent = Math.floor(100 * done / job.total);
  return (verifying ? 'Verified ' : 'Cleaned ') + done + ' of ' + job.total + ' galleries (' + percent + '%)' +
    (job.gallery ? ' · ' + job.gallery : '');
}

function renderCleanup(job) {
  cleanupJob = job;
  migrationCleanupButton.disabled = cleanupBusy() || !cleanupSelection?.revision;
  migrationCleanupProgress.hidden = !job || (job.status === 'error' && !job.total);
  if (!job) return;
  if (job.total) {
    const completed = job.phase === 'verifying' ? job.verified : job.cleaned;
    migrationCleanupProgress.value = Math.floor(100 * completed / job.total);
  } else migrationCleanupProgress.removeAttribute('value');
  if (job.status === 'success') {
    migrationCleanupStatus.textContent = 'Cleanup complete · 100% · ' + job.cleaned + ' galleries cleaned · ' + job.files + ' originals removed.';
  } else if (job.status === 'error') {
    migrationCleanupStatus.textContent = job.error + (job.files ? ' Removed ' + job.files + ' originals before stopping.' : '');
  } else migrationCleanupStatus.textContent = cleanupProgressText(job);
}

async function pollCleanup() {
  if (cleanupPolling || cleanupStarting) return;
  cleanupPolling = true;
  const generation = cleanupGeneration;
  try {
    const response = await fetch('/api/jxl-migration/cleanup-all', { cache: 'no-store' });
    if (!response.ok) return;
    const { job } = await response.json();
    if (generation !== cleanupGeneration || !job) return;
    const terminal = job.status !== 'working' && (cleanupJob?.id !== job.id || cleanupJob.status === 'working');
    renderCleanup(job);
    if (terminal) {
      await refreshMigration();
      await refresh(true);
    }
  } catch { /* The next poll can reconnect without interrupting cleanup. */ }
  finally { cleanupPolling = false; }
}
setInterval(() => { if (!migrationPage.hidden) pollCleanup(); }, 1500);

async function migrationAction(suffix, body) {
  const response = await fetch('/api/jxl-migration' + suffix, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The migration operation could not be completed.');
  return result;
}

function migrationSizeList(list, totals, free) {
  const sizes = [
    ['Original JPEG size', totals.original], ['JPEG XL size', totals.encoded],
    ['Originals still retained', totals.retained], ['Reclaimed by cleanup', totals.reclaimed],
    ['Net file-size savings', totals.net], ['Net allocated space saved', totals.allocatedNet]
  ];
  if (free !== undefined) sizes.push(['Drive free now', free]);
  list.replaceChildren(...sizes.map(([label, value]) => {
    const row = el('div');
    row.append(el('dt', '', label), el('dd', '', formatBytes(value)));
    return row;
  }));
}

const migrationGroups = {
  ready: 'Ready to review',
  queued: 'Waiting for conversion',
  attention: 'Needs attention',
  blocked: 'Cleanup blocked',
  complete: 'Finished',
  unavailable: 'Unavailable'
};

function migrationGroup(gallery) {
  return Object.hasOwn(migrationGroups, gallery.readiness) ? gallery.readiness : 'unavailable';
}

function renderMigrationGroups(list, galleries) {
  const expandedGroups = new Map([...list.querySelectorAll('.migration-group')].map(group => [group.dataset.status, group.open]));
  const expandedGalleries = new Set([...list.querySelectorAll('.migration-gallery[open]')].map(gallery => gallery.dataset.id));
  const grouped = new Map(Object.keys(migrationGroups).map(status => [status, []]));
  for (const gallery of galleries) grouped.get(migrationGroup(gallery)).push(gallery);
  grouped.get('ready').sort((a, b) => b.totals.retained - a.totals.retained || a.name.localeCompare(b.name));

  const groups = document.createDocumentFragment();
  for (const [status, members] of grouped) {
    const drawer = el('details', 'migration-group');
    drawer.dataset.status = status;
    drawer.open = expandedGroups.get(status) ?? status === 'ready';
    const heading = el('summary');
    heading.append(el('span', 'migration-readiness ' + status, migrationGroups[status]),
      el('span', 'migration-group-count', members.length + (members.length === 1 ? ' gallery' : ' galleries')));
    drawer.append(heading);
    for (const gallery of members) drawer.append(renderMigrationGallery(gallery, expandedGalleries.has(gallery.id || gallery.name)));
    if (!members.length) drawer.append(el('p', 'migration-group-empty', 'No galleries with this status.'));
    groups.append(drawer);
  }
  list.replaceChildren(groups);
}

function renderMigrationGallery(gallery, expanded) {
  const section = el('details', 'migration-gallery');
  section.dataset.id = gallery.id || gallery.name;
  section.open = expanded;
  const counts = gallery.counts;
  const messages = {
    queued: 'Waiting for JPEG conversion',
    ready: 'Ready to review for cleanup',
    complete: 'Finished · no originals to clean up',
    attention: 'Needs attention',
    blocked: 'Cleanup blocked · a retained original or its replacement is unavailable',
    unavailable: 'Gallery unavailable'
  };
  const readiness = migrationGroup(gallery);
  const status = messages[gallery.readiness] || 'Restart ImageWorks to see migration readiness';
  const summary = el('summary');
  summary.append(el('span', 'migration-gallery-name', gallery.name),
    el('span', 'migration-readiness ' + readiness, status));
  const indicators = [];
  if (readiness === 'ready') indicators.push(formatBytes(gallery.totals.retained) + ' reclaimable');
  if (counts?.pending) indicators.push(counts.pending + ' JPEGs pending');
  if (counts?.skipped || counts?.failed) indicators.push('JPEG exceptions listed below');
  if (counts) indicators.push(counts.retained + ' retained originals / ' + counts.images + ' gallery images');
  if (indicators.length) summary.append(el('span', 'migration-summary-counts', indicators.join(' · ')));
  const breakdown = el('p', 'migration-counts');
  if (counts) {
    const details = [
      [counts.other, 'non-JPEG images'], [counts.pending, 'JPEGs pending'], [counts.removed, 'originals already cleaned up'],
      [counts.skipped, 'JPEGs skipped'], [counts.failed, 'JPEGs failed'], [counts.restored, 'originals restored'],
      [counts.needsAttention, 'files needing attention'], [counts.videos, 'videos excluded']
    ].filter(([count]) => count > 0).map(([count, label]) => count + ' ' + label);
    breakdown.textContent = counts.retained + ' retained JPEG originals / ' + counts.images + ' gallery images' +
      (details.length ? ' · ' + details.join(' · ') : '');
  } else breakdown.textContent = 'Gallery image count unavailable.';
  const sizes = el('dl', 'storage-sizes');
  migrationSizeList(sizes, gallery.totals);
  const actions = el('div', 'migration-actions');
  if (gallery.active) {
    const open = el('button', 'text-button', 'Open gallery');
    open.addEventListener('click', async () => {
      const response = await fetch('/api/albums?id=' + encodeURIComponent(gallery.name));
      const album = (await response.json()).albums?.[0];
      if (album) openAlbum(album);
      else migrationStatus.textContent = 'Gallery unavailable.';
    });
    actions.append(open);
  }
  if (gallery.review) {
    for (const [action, label, question] of [
      ['restore', 'Restore retained originals', 'Restore the retained JPEGs and remove their JPEG XL replacements?'],
      ['cleanup', gallery.readiness === 'queued' ? 'Remove reviewed originals so far' : 'Remove retained originals',
        gallery.readiness === 'queued' ? 'JPEGs are still pending. Permanently remove only the originals already verified and listed here?'
          : 'Permanently remove the reviewed JPEG originals for this gallery?']
    ]) {
      const button = el('button', 'text-button' + (action === 'cleanup' ? ' danger-button' : ''), label);
      button.addEventListener('click', async () => {
        if (!window.confirm(gallery.name + ' · ' + question)) return;
        for (const control of actions.querySelectorAll('button')) control.disabled = true;
        try {
          await migrationAction('/' + action, { id: gallery.id, revision: gallery.review });
          await refreshMigration();
          await refresh(true);
        } catch (error) { migrationStatus.textContent = error.message; }
        finally { for (const control of actions.querySelectorAll('button')) control.disabled = false; }
      });
      actions.append(button);
    }
  }
  const files = el('ul', 'migration-files');
  const descriptions = { retained: 'Verified · original retained', removed: 'Verified · original removed',
    restored: 'Original restored', failed: 'Failed', skipped: 'Skipped', retry: 'Queued for retry',
    publishing: 'Publication interrupted', restoring: 'Restore interrupted', cleaning: 'Cleanup interrupted' };
  for (const file of gallery.files) {
    const row = el('li');
    row.append(el('strong', '', file.path));
    const date = file.removedAt || file.restoredAt || file.convertedAt || file.at;
    const detail = [descriptions[file.state] || file.state];
    if (file.encodedBytes) detail.push(formatBytes(file.originalBytes) + ' → ' + formatBytes(file.encodedBytes));
    if (date) detail.push(new Date(date).toLocaleString());
    if (file.message) detail.push(file.message);
    row.append(el('span', '', detail.join(' · ')));
    files.append(row);
  }
  section.append(summary, breakdown, sizes, actions, files);
  return section;
}

async function refreshMigration() {
  const request = ++migrationRequest;
  try {
    const response = await fetch('/api/jxl-migration', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not read the JPEG XL migration report.');
    const report = await response.json();
    if (request !== migrationRequest) return;
    migrationEnabled = report.enabled;
    cleanupSelection = Array.isArray(report.cleanupAll?.ids) ? report.cleanupAll : null;
    migrationCleanupButton.disabled = cleanupBusy() || !cleanupSelection?.revision;
    if (!cleanupBusy() && !cleanupJob) {
      migrationCleanupStatus.textContent = !cleanupSelection ? 'Restart ImageWorks to enable bulk cleanup.'
        : cleanupSelection.galleries ? cleanupSelection.galleries +
          (cleanupSelection.galleries === 1 ? ' gallery ready' : ' galleries ready') + ' · ' +
          formatBytes(cleanupSelection.bytes) + ' reclaimable.'
        : 'No galleries ready for bulk cleanup.';
    }
    migrationToggle.disabled = false;
    migrationToggle.textContent = report.enabled ? 'Pause background migration' : 'Start background migration';
    const status = report.current ? report.current.name + ' · ' + report.current.relative : report.message;
    migrationStatus.textContent = (report.enabled ? 'Migration enabled.' : 'Migration paused.') +
      (status ? ' ' + status : '') + ' Free-space floor ' + formatBytes(report.minFree) +
      ' · Retained originals limit ' + formatBytes(report.maxRetained) + '.';
    migrationSizeList(document.querySelector('#migration-totals'), report.totals, report.free);
    renderMigrationGroups(document.querySelector('#migration-galleries'), report.galleries);
  } catch (error) { if (request === migrationRequest) migrationStatus.textContent = error.message; }
}
document.querySelector('#migration-refresh').addEventListener('click', refreshMigration);
migrationToggle.addEventListener('click', async () => {
  migrationToggle.disabled = true;
  try { await migrationAction('', { enabled: !migrationEnabled }); await refreshMigration(); }
  catch (error) { migrationStatus.textContent = error.message; migrationToggle.disabled = false; }
});

migrationCleanupButton.addEventListener('click', async () => {
  if (cleanupBusy() || !cleanupSelection?.revision) return;
  const { revision, ids, galleries, bytes } = cleanupSelection;
  if (!window.confirm('Permanently remove ' + formatBytes(bytes) + ' of retained JPEG originals across ' + galleries +
    (galleries === 1 ? ' gallery' : ' galleries') + ' marked Ready to review?')) return;
  cleanupGeneration++;
  cleanupStarting = true;
  migrationCleanupButton.disabled = true;
  migrationCleanupProgress.hidden = false;
  migrationCleanupProgress.removeAttribute('value');
  migrationCleanupStatus.textContent = 'Starting bulk cleanup…';
  try {
    const { job } = await migrationAction('/cleanup-all', { revision, ids });
    renderCleanup(job);
  } catch (error) {
    cleanupJob = null;
    migrationCleanupProgress.hidden = true;
    migrationCleanupStatus.textContent = error.message;
  } finally {
    cleanupStarting = false;
    migrationCleanupButton.disabled = cleanupBusy() || !cleanupSelection?.revision;
  }
});

let workerRefreshPending = false;
let workerLogFingerprint = '';

async function refreshMigrationWorker() {
  if (workerRefreshPending) return;
  workerRefreshPending = true;
  const status = document.querySelector('#migration-worker-status');
  const file = document.querySelector('#migration-worker-file');
  const logStatus = document.querySelector('#migration-worker-log-status');
  try {
    const response = await fetch('/api/jxl-migration/worker', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not read the worker status.');
    const worker = await response.json();
    const label = worker.cleanup?.status === 'working' ? cleanupProgressText(worker.cleanup) : worker.current ? worker.current.stage : worker.message || (worker.enabled ? 'Waiting for work.' : 'Worker paused.');
    if (status.textContent !== label) status.textContent = label;
    file.hidden = !worker.current;
    file.textContent = worker.current ? worker.current.name + ' · ' + worker.current.relative : '';
    logStatus.textContent = worker.events.length ? '' : 'No migration events recorded yet.';
    const fingerprint = JSON.stringify(worker.events);
    if (fingerprint === workerLogFingerprint) return;
    const labels = {
      started: 'Processing started', converted: 'Verified and converted', skipped: 'Skipped',
      failed: 'Conversion failed', cleaned_up: 'Retained original removed', restored: 'Original restored',
      paused: 'Worker paused', enabled: 'Worker enabled', status: 'Worker status'
    };
    const events = document.createDocumentFragment();
    for (const event of worker.events) {
      const row = el('li', event.level === 'error' ? 'activity-entry activity-error' : 'activity-entry');
      const time = el('time', '', new Date(event.timestamp).toLocaleString());
      time.dateTime = event.timestamp;
      row.append(time, el('strong', '', labels[event.event] || event.event));
      const details = [event.album, event.file];
      if (event.event === 'converted') details.push(formatBytes(event.originalBytes) + ' → ' + formatBytes(event.encodedBytes));
      if (event.message) details.push(event.message);
      row.append(el('p', '', details.filter(Boolean).join(' · ')));
      events.append(row);
    }
    document.querySelector('#migration-worker-events').replaceChildren(events);
    workerLogFingerprint = fingerprint;
  } catch (error) {
    status.textContent = error.message;
    file.hidden = true;
  } finally { workerRefreshPending = false; }
}
setInterval(() => { if (!migrationWorkerPage.hidden) refreshMigrationWorker(); }, 2000);

async function refreshStorage() {
  const message = document.querySelector('#storage-message');
  message.textContent = 'Calculating storage usage…';
  try {
    const response = await fetch('/api/storage', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not read storage usage.');
    const data = await response.json();
    const list = document.querySelector('#storage-sizes');
    list.replaceChildren();
    for (const [label, bytes] of [['Gallery media', data.sizes.gallery], ['Inbox', data.sizes.inbox], ['Processed archives', data.sizes.processed], ['Gallery Trash', data.sizes.trash], ['Image Trash', data.sizes.imageTrash], ['Retained JPEG originals', data.sizes.jpegOriginals], ['Download cache', data.sizes.downloads], ['Image previews', data.sizes.previews], ['Video posters', data.sizes.posters], ['Drive free', data.free], ['Drive total', data.total]]) {
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
    const labels = { 'service.started': 'ImageWorks started', 'archive.import_started': 'Import started', 'archive.import_completed': 'Import completed', 'archive.moved_to_processed': 'Archive moved to Processed', 'archive.import_failed': 'Import failed', 'archive.move_failed': 'Could not move archive', 'download.started': 'Download started', 'download.completed': 'Download completed', 'download.failed': 'Download failed', 'gallery.trash_move': 'Gallery moved to Trash', 'gallery.trash_restore': 'Gallery restored', 'gallery.trash_delete': 'Gallery permanently deleted', 'gallery.created': 'Gallery created', 'gallery.image_uploaded': 'Image uploaded', 'gallery.cover_changed': 'Gallery cover changed', 'image.trash_move': 'File moved to Image Trash', 'image.trash_restore': 'File restored', 'image.trash_delete': 'File permanently deleted', 'image.trash_forget': 'File re-import allowed' };
    for (const event of events) {
      const item = el('li', event.level === 'error' ? 'activity-entry activity-error' : 'activity-entry');
      const date = new Date(event.timestamp);
      const time = el('time', '', Number.isNaN(date.getTime()) ? event.timestamp : date.toLocaleString());
      time.dateTime = event.timestamp;
      item.append(time, el('strong', '', labels[event.event] || event.event.replaceAll('.', ' ').replaceAll('_', ' ')));
      const details = [];
      if (event.archive) details.push(event.archive);
      if (event.file) details.push(event.file);
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

function tagChip(tag) { return el('span', `tag-chip tag-colour-${tag.colour || 'default'}`, tag.name); }
function renderViewerTags(album) {
  const container = document.querySelector('#viewer-tags');
  container.replaceChildren();
  for (const tag of tagLibrary.filter(tag => (album?.tagIds || []).includes(tag.id))) container.append(tagChip(tag));
}
async function tagRequest(action, body) {
  const response = await fetch(`/api/tags/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not update tags.');
  tagLibrary = data.tags;
  renderAlbums();
  if (currentAlbum) renderViewerTags(currentAlbum);
  return data;
}
function renderTagDialog() {
  const query = (document.querySelector('#tags-search').value || '').trim().toLocaleLowerCase();
  const options = document.querySelector('#tags-options');
  const manage = document.querySelector('#tags-manage-list');
  options.replaceChildren(); manage.replaceChildren();
  for (const tag of [...tagLibrary].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!query || tag.name.toLocaleLowerCase().includes(query)) {
      const label = el('label', 'tag-option');
      const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = tagDraft.has(tag.id);
      checkbox.addEventListener('change', () => { if (checkbox.checked) tagDraft.add(tag.id); else tagDraft.delete(tag.id); });
      label.append(checkbox, tagChip(tag)); options.append(label);
    }
    const row = el('div', 'tag-manage-row'); row.append(tagChip(tag));
    const colour = el('select', 'tag-colour-select'); colour.setAttribute('aria-label', `Colour for ${tag.name}`);
    for (const value of ['default', 'red', 'orange', 'gold', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown', 'grey']) {
      const option = el('option', '', value[0].toUpperCase() + value.slice(1));
      option.value = value;
      colour.append(option);
    }
    colour.value = tag.colour || 'default';
    colour.addEventListener('change', async () => { try { await tagRequest('colour', { id: tag.id, colour: colour.value }); document.querySelector('#tags-error').textContent = ''; renderTagDialog(); } catch (error) { colour.value = tag.colour || 'default'; document.querySelector('#tags-error').textContent = error.message; } });
    row.append(colour);
    const rename = el('button', 'text-button', 'Rename'); rename.type = 'button'; rename.setAttribute('aria-label', `Rename tag ${tag.name}`);
    rename.addEventListener('click', async () => {
      const name = window.prompt(`Rename tag “${tag.name}” for all galleries:`, tag.name);
      if (name === null) return;
      try { await tagRequest('rename', { id: tag.id, name }); document.querySelector('#tags-error').textContent = ''; renderTagDialog(); }
      catch (error) { document.querySelector('#tags-error').textContent = error.message; }
    });
    const remove = el('button', 'text-button danger-button', 'Delete'); remove.type = 'button'; remove.setAttribute('aria-label', `Delete tag ${tag.name}`);
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete tag “${tag.name}” from the library and all galleries, including Trash?`)) return;
      try { await tagRequest('delete', { id: tag.id }); tagDraft.delete(tag.id); document.querySelector('#tags-error').textContent = ''; renderTagDialog(); }
      catch (error) { document.querySelector('#tags-error').textContent = error.message; }
    });
    row.append(rename, remove); manage.append(row);
  }
  if (!options.children.length) options.append(el('p', 'field-help', query ? 'No matching tags. Create one using the name above.' : 'No tags yet. Create one above.'));
}
document.querySelector('#tag-filter').addEventListener('change', renderAlbums);
document.querySelector('#edit-tags').addEventListener('click', () => {
  if (!currentAlbum) return;
  tagEditingAlbum = currentAlbum.id;
  tagDraft = new Set((currentAlbum.tagIds || []).filter(id => tagLibrary.some(tag => tag.id === id)));
  document.querySelector('#tags-search').value = '';
  document.querySelector('#tags-error').textContent = '';
  renderTagDialog(); document.querySelector('#tags-dialog').showModal();
});
document.querySelector('#tags-search').addEventListener('input', renderTagDialog);
document.querySelector('#tags-create').addEventListener('click', async () => {
  try {
    const data = await tagRequest('create', { name: document.querySelector('#tags-search').value });
    tagDraft.add(data.tag.id); document.querySelector('#tags-search').value = '';
    document.querySelector('#tags-error').textContent = ''; renderTagDialog();
  } catch (error) { document.querySelector('#tags-error').textContent = error.message; }
});
document.querySelector('#tags-cancel').addEventListener('click', () => document.querySelector('#tags-dialog').close());
document.querySelector('#tags-save').addEventListener('click', async event => {
  event.target.disabled = true;
  try {
    const ids = [...tagDraft];
    await tagRequest('assign', { album: tagEditingAlbum, ids });
    if (currentAlbum?.id === tagEditingAlbum) { currentAlbum.tagIds = ids; renderViewerTags(currentAlbum); }
    document.querySelector('#tags-dialog').close();
    await refresh(true);
  } catch (error) { document.querySelector('#tags-error').textContent = error.message; }
  finally { event.target.disabled = false; }
});

async function collectionRequest(action, body) {
  const response = await fetch(`/api/collections/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not update collection.');
  return data.result;
}
async function getCollections() {
  const response = await fetch('/api/collections', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load collections.');
  return (await response.json()).collections;
}
function imageSource() {
  const item = currentImages[currentIndex];
  return { album: collectionContext ? item?.sourceAlbumId : currentAlbum?.id, path: item?.relativePath };
}
async function refreshCollections() {
  const status = document.querySelector('#collections-status');
  try {
    const all = await getCollections();
    const list = document.querySelector('#collections-list'); list.replaceChildren();
    for (const collection of all) {
      const button = el('button', 'collection-card'); button.type = 'button';
      button.append(el('strong', '', collection.name), el('span', '', `${collection.count} ${collection.count === 1 ? 'item' : 'items'}`));
      button.addEventListener('click', () => openCollection(collection.id)); list.append(button);
    }
    status.textContent = '';
    if (activeCollection) await openCollection(activeCollection, collectionPageIndex);
  } catch (error) { status.textContent = error.message; }
}
async function openCollection(id, page = 0) {
  const status = document.querySelector('#collection-status');
  try {
    const response = await fetch(`/api/collections?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load collection.');
    const collection = data.collection;
    activeCollection = collection.id;
    document.querySelector('#collections-home').hidden = true;
    document.querySelector('#collection-detail').hidden = false;
    document.querySelector('#collection-title').textContent = collection.name;
    document.querySelector('#collection-delete').hidden = collection.id === 'favourites';
    const list = document.querySelector('#collection-items'); list.replaceChildren();
    const available = collection.items.filter(item => item.state === 'available');
    const pages = Math.max(1, Math.ceil(collection.items.length / pageSize));
    collectionPageIndex = Math.max(0, Math.min(page, pages - 1));
    const start = collectionPageIndex * pageSize;
    document.querySelector('#collection-pagination').hidden = pages <= 1;
    document.querySelector('#collection-previous').disabled = collectionPageIndex === 0;
    document.querySelector('#collection-next').disabled = collectionPageIndex >= pages - 1;
    document.querySelector('#collection-page-label').textContent = `Page ${collectionPageIndex + 1} of ${pages}`;
    for (const item of collection.items.slice(start, start + pageSize)) {
      const card = el('article', 'collection-item');
      if (item.state === 'available') {
        const open = el('button', 'collection-image'); open.type = 'button'; open.setAttribute('aria-label', `View ${item.name}`);
        const image = new Image(); image.loading = 'lazy'; image.src = item.preview; image.alt = item.name; open.append(image);
        if (item.type === 'video') open.append(el('span', 'video-badge', '▶ WEBM'));
        open.addEventListener('click', () => { collectionContext = true; currentImages = available; currentPage = 0; openImage(available.findIndex(media => media.id === item.id)); });
        card.append(open);
      } else {
        const labels = { trashed: 'Source gallery is in Trash', 'image-trashed': 'Image is in Trash', 'image-deleted': 'Image permanently deleted', missing: 'Source not found', conflict: 'Source identity is duplicated' };
        card.append(el('div', 'collection-placeholder', labels[item.state] || 'Source unavailable'));
      }
      const meta = el('div', 'collection-item-meta');
      meta.append(el('strong', '', item.name));
      if (item.state === 'available') {
        const source = el('button', 'collection-source', `From: ${item.sourceName}`); source.type = 'button';
        source.addEventListener('click', async () => {
          await refresh(true);
          const album = albums.find(album => album.id === item.sourceAlbumId);
          if (album) openAlbum(album); else status.textContent = 'The source gallery is no longer available.';
        });
        meta.append(source);
      } else meta.append(el('span', '', `From: ${item.sourceName}`));
      const remove = el('button', 'text-button', 'Remove from collection'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${item.name} from ${collection.name}`);
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try { await collectionRequest('remove', { collection: collection.id, item: item.id }); await openCollection(collection.id, collectionPageIndex); status.textContent = 'Removed from this collection. The source file was not changed.'; }
        catch (error) { status.textContent = error.message; remove.disabled = false; }
      });
      meta.append(remove); card.append(meta); list.append(card);
    }
    status.textContent = collection.items.length ? `Showing ${start + 1}–${Math.min(start + pageSize, collection.items.length)} of ${collection.items.length} ${collection.items.length === 1 ? 'item' : 'items'}.` : 'This collection is empty. Open an image in a gallery to add it.';
  } catch (error) { status.textContent = error.message; }
}
document.querySelector('#collection-previous').addEventListener('click', () => activeCollection && openCollection(activeCollection, collectionPageIndex - 1));
document.querySelector('#collection-next').addEventListener('click', () => activeCollection && openCollection(activeCollection, collectionPageIndex + 1));
document.querySelector('#collections-back').addEventListener('click', () => { activeCollection = null; document.querySelector('#collections-home').hidden = false; document.querySelector('#collection-detail').hidden = true; refreshCollections(); });
document.querySelector('#collection-create').addEventListener('click', async event => {
  event.target.disabled = true;
  try { const created = await collectionRequest('create', { name: document.querySelector('#collection-name').value }); document.querySelector('#collection-name').value = ''; await refreshCollections(); await openCollection(created.id); }
  catch (error) { document.querySelector('#collections-status').textContent = error.message; }
  finally { event.target.disabled = false; }
});
document.querySelector('#collection-delete').addEventListener('click', async () => {
  if (!activeCollection || !window.confirm('Delete this collection? The original gallery files will be kept.')) return;
  try { await collectionRequest('delete', { collection: activeCollection }); activeCollection = null; document.querySelector('#collections-home').hidden = false; document.querySelector('#collection-detail').hidden = true; await refreshCollections(); }
  catch (error) { document.querySelector('#collection-status').textContent = error.message; }
});
document.querySelector('#favourite-image').addEventListener('click', async event => {
  event.target.disabled = true;
  try { const result = await collectionRequest('add', { collection: 'favourites', ...imageSource() }); document.querySelector('#collection-image-status').textContent = result.alreadyAdded ? 'Already in Favourites.' : 'Added to Favourites.'; }
  catch (error) { document.querySelector('#collection-image-status').textContent = error.message; }
  finally { event.target.disabled = false; }
});
async function openCollectionPicker(source) {
  try {
    const all = await getCollections();
    collectionPickerSource = source;
    document.querySelector('#collection-picker-new').value = ''; const select = document.querySelector('#collection-picker-select'); select.replaceChildren();
    for (const collection of all) { const option = el('option', '', collection.name); option.value = collection.id; select.append(option); }
    document.querySelector('#collection-picker-error').textContent = ''; document.querySelector('#collection-picker').showModal();
  } catch (error) { document.querySelector(selectingImages ? '#batch-status' : '#collection-image-status').textContent = error.message; }
}
document.querySelector('#add-to-collection').addEventListener('click', () => openCollectionPicker(imageSource()));
document.querySelector('#collection-picker-cancel').addEventListener('click', () => document.querySelector('#collection-picker').close());
document.querySelector('#collection-picker-create').addEventListener('click', async event => {
  event.target.disabled = true;
  try {
    const created = await collectionRequest('create', { name: document.querySelector('#collection-picker-new').value });
    const option = el('option', '', created.name); option.value = created.id;
    const select = document.querySelector('#collection-picker-select'); select.append(option); select.value = created.id;
    document.querySelector('#collection-picker-new').value = ''; document.querySelector('#collection-picker-error').textContent = '';
  } catch (error) { document.querySelector('#collection-picker-error').textContent = error.message; }
  finally { event.target.disabled = false; }
});
document.querySelector('#collection-picker-save').addEventListener('click', async event => {
  event.target.disabled = true;
  try {
    const batch = Array.isArray(collectionPickerSource.paths);
    const result = await collectionRequest(batch ? 'add-many' : 'add', { collection: document.querySelector('#collection-picker-select').value, ...collectionPickerSource });
    document.querySelector('#collection-picker').close();
    if (batch) { document.querySelector('#batch-status').textContent = `${result.added} added; ${result.alreadyAdded} already in the collection.`; selectedImages.clear(); updateBatchControls(); renderPhotoPage(currentPage); }
    else document.querySelector('#collection-image-status').textContent = result.alreadyAdded ? 'Already in that collection.' : 'Added to collection.';
  } catch (error) { document.querySelector('#collection-picker-error').textContent = error.message; }
  finally { event.target.disabled = false; }
});

function updateBatchControls() {
  document.querySelector('#batch-toolbar').hidden = !selectingImages;
  document.querySelector('#batch-count').textContent = `${selectedImages.size} selected`;
  document.querySelector('#batch-add').disabled = selectedImages.size === 0;
  const toggle = document.querySelector('#select-images');
  toggle.textContent = selectingImages ? 'Done selecting' : 'Select images';
  toggle.setAttribute('aria-pressed', selectingImages ? 'true' : 'false');
}
document.querySelector('#select-images').addEventListener('click', () => {
  selectingImages = !selectingImages; selectedImages.clear(); document.querySelector('#batch-status').textContent = '';
  updateBatchControls(); renderPhotoPage(currentPage);
});
document.querySelector('#batch-page').addEventListener('click', () => {
  for (const item of currentImages.slice(currentPage * pageSize, (currentPage + 1) * pageSize)) {
    if (selectedImages.has(item.relativePath)) continue;
    if (selectedImages.size >= 500) { document.querySelector('#batch-status').textContent = 'Select up to 500 files at a time.'; break; }
    selectedImages.add(item.relativePath);
  }
  updateBatchControls(); renderPhotoPage(currentPage);
});
document.querySelector('#batch-clear').addEventListener('click', () => { selectedImages.clear(); document.querySelector('#batch-status').textContent = ''; updateBatchControls(); renderPhotoPage(currentPage); });
document.querySelector('#batch-add').addEventListener('click', () => { if (currentAlbum && selectedImages.size) openCollectionPicker({ album: currentAlbum.id, paths: [...selectedImages] }); });

let metadataBackupData = null;
async function metadataPost(action, data) {
  const response = await fetch(`/api/metadata-restore/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not process metadata backup.');
  return result;
}
document.querySelector('#metadata-download').addEventListener('click', async event => {
  event.target.disabled = true;
  const status = document.querySelector('#metadata-status'); status.textContent = 'Preparing metadata backup…';
  try {
    const response = await fetch('/api/metadata-backup', { cache: 'no-store' });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Could not create backup.'); }
    const blob = await response.blob(); const url = URL.createObjectURL(blob);
    const link = el('a'); link.href = url; link.download = 'imageworks-metadata-backup.json'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = 'Metadata backup download started. Store it separately from your gallery files.';
  } catch (error) { status.textContent = error.message; }
  finally { event.target.disabled = false; }
});
document.querySelector('#metadata-file').addEventListener('change', () => { metadataBackupData = null; document.querySelector('#metadata-restore').disabled = true; document.querySelector('#metadata-status').textContent = ''; });
document.querySelector('#metadata-preview').addEventListener('click', async event => {
  const status = document.querySelector('#metadata-status'); const restore = document.querySelector('#metadata-restore');
  metadataBackupData = null; restore.disabled = true; event.target.disabled = true;
  try {
    const file = document.querySelector('#metadata-file').files[0];
    if (!file) throw new Error('Choose a metadata backup file first.');
    if (file.size > 20 * 1024 * 1024) throw new Error('Backup exceeds the 20 MB restore limit.');
    const data = JSON.parse(await file.text());
    const result = await metadataPost('preview', data);
    const lines = [`${result.filesToRestore} missing metadata files can be restored.`];
    if (result.matchedByName.length) lines.push(`Matched by folder name (check these are the original galleries): ${result.matchedByName.join(', ')}`);
    if (result.missing.length) lines.push(`Gallery not found; its metadata will be skipped: ${result.missing.join(', ')}`);
    if (result.conflicts.length) lines.push(`Restore blocked; existing metadata differs: ${result.conflicts.join('; ')}`);
    else if (result.filesToRestore) { metadataBackupData = data; restore.disabled = false; }
    else lines.push('Nothing needs restoring.');
    status.textContent = lines.join('\n');
  } catch (error) { status.textContent = error.message; }
  finally { event.target.disabled = false; }
});
document.querySelector('#metadata-restore').addEventListener('click', async event => {
  if (!metadataBackupData || !window.confirm('Restore the missing metadata shown in the preview? Galleries matched by name must be the original galleries. Existing different metadata will not be overwritten.')) return;
  event.target.disabled = true;
  try {
    const result = await metadataPost('apply', metadataBackupData); metadataBackupData = null;
    document.querySelector('#metadata-status').textContent = `Restored ${result.restored} metadata files. ${result.missing.length} galleries were not found.`;
    await refresh(true);
  } catch (error) { document.querySelector('#metadata-status').textContent = error.message; metadataBackupData = null; }
});

document.querySelectorAll('.viewer-more button').forEach(button => button.addEventListener('click', () => { document.querySelector('.viewer-more').open = false; }));

let uploadInProgress = false;
document.querySelector('#create-gallery').addEventListener('click', () => {
  document.querySelector('#create-gallery-name').value = ''; document.querySelector('#create-gallery-error').textContent = '';
  document.querySelector('#create-gallery-dialog').showModal(); document.querySelector('#create-gallery-name').focus();
});
document.querySelector('#create-gallery-cancel').addEventListener('click', () => document.querySelector('#create-gallery-dialog').close());
document.querySelector('#create-gallery-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = document.querySelector('#create-gallery-save'); button.disabled = true;
  try {
    const response = await fetch('/api/albums/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('#create-gallery-name').value }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not create gallery.');
    document.querySelector('#create-gallery-dialog').close(); await refresh(true);
    const album = albums.find(item => item.id === data.id); if (album) openAlbum(album);
  } catch (error) { document.querySelector('#create-gallery-error').textContent = error.message; }
  finally { button.disabled = false; }
});
importLinksButton.addEventListener('click', () => {
  importLinksForm.hidden = !importLinksForm.hidden;
  importLinksButton.setAttribute('aria-expanded', String(!importLinksForm.hidden));
  if (!importLinksForm.hidden) importLinksInput.focus();
});
importLinksForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentAlbum || importLinksSubmit.disabled) return;
  importLinksSubmit.disabled = true;
  showLinkImportProgress();
  importLinksStatus.textContent = 'Starting import…';
  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gallery: currentAlbum.id, links: importLinksInput.value })
    });
    const result = await response.json();
    if (result.error === 'Paste a valid 4chan thread, GoonBox album or Bunkr album link.') {
      throw new Error('Restart the ImageWorkx service to enable gallery link imports, then try again.');
    }
    if (!response.ok) throw new Error(result.error || 'Could not start the import.');
    renderDownload(result.download);
  } catch (error) {
    importLinksProgress.hidden = true;
    importLinksStatus.textContent = error.message;
    importLinksSubmit.disabled = false;
  }
});
document.querySelector('#add-images').addEventListener('click', () => { if (!uploadInProgress) document.querySelector('#upload-images').click(); });
document.querySelector('#upload-images').addEventListener('change', async event => {
  const files = [...event.target.files], albumId = currentAlbum?.id;
  event.target.value = '';
  if (!files.length || !albumId || uploadInProgress) return;
  uploadInProgress = true; document.querySelector('#add-images').disabled = true;
  let added = 0; const errors = [];
  const status = document.querySelector('#upload-status');
  try {
    for (const [index, file] of files.entries()) {
      if (viewer.open && currentAlbum?.id === albumId) status.textContent = `Uploading ${index + 1} of ${files.length}: ${file.name}`;
      try {
        let response;
        for (let attempt = 0; attempt < 30; attempt++) {
          response = await fetch(`/api/albums/upload?id=${encodeURIComponent(albumId)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
          if (response.status !== 409) break;
          if (attempt === 29) break;
          await response.text();
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Upload failed.');
        added++;
      } catch (error) { errors.push(`${file.name}: ${error.message}`); }
    }
    await refresh(true);
    if (viewer.open && currentAlbum?.id === albumId) {
      const updated = albums.find(album => album.id === albumId);
      if (updated) await openAlbum(updated, currentPage);
      status.textContent = `${added} of ${files.length} images added.${errors.length ? ` ${errors.join(' · ')}` : ''}`;
    }
  } finally { uploadInProgress = false; document.querySelector('#add-images').disabled = false; }
});
document.querySelector('#set-gallery-cover').addEventListener('click', async event => {
  const source = imageSource(); event.target.disabled = true;
  try {
    const response = await fetch('/api/albums/cover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: source.album, path: source.path }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not set the cover.');
    document.querySelector('#collection-image-status').textContent = 'Gallery cover updated.'; await refresh(true);
  } catch (error) { document.querySelector('#collection-image-status').textContent = error.message; }
  finally { event.target.disabled = false; }
});

document.querySelector('#trash-image').addEventListener('click', async event => {
  const item = currentImages[currentIndex], source = imageSource();
  if (collectionContext || !item || !source.album || !source.path) return;
  if (!window.confirm(`Move “${item.name}” from “${source.album}” to Image Trash? You can restore it from Storage.`)) return;
  event.target.disabled = true;
  try {
    const response = await fetch('/api/image-trash/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(source) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not move the file to Trash.');
    lightbox.close(); await refresh(true);
    if (viewer.open && currentAlbum?.id === source.album) {
      const updated = albums.find(album => album.id === source.album);
      if (updated) await openAlbum(updated, currentPage);
    }
  } catch (error) { document.querySelector('#collection-image-status').textContent = error.message; }
  finally { event.target.disabled = false; }
});
async function refreshImageTrash() {
  const status = document.querySelector('#image-trash-status'); status.textContent = 'Loading Image Trash…';
  try {
    const response = await fetch('/api/image-trash', { cache: 'no-store' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load Image Trash.');
    const list = document.querySelector('#image-trash-list'); list.replaceChildren();
    for (const entry of data.entries) {
      const item = el('li', 'trash-entry'), details = el('div');
      details.append(el('strong', '', entry.name), el('p', '', `From: ${entry.sourceName} · ${entry.deleted ? 'Permanently deleted; re-import blocked' : `${formatBytes(entry.sizeBytes)} · moved ${new Date(entry.trashedAt).toLocaleString()}`}`));
      const actions = el('div', 'trash-actions');
      if (!entry.deleted) {
        const download = el('a', 'text-button', 'Download stored file'); download.href = `/api/image-trash/file?id=${encodeURIComponent(entry.id)}&download=1`; download.download = entry.downloadName; actions.append(download);
      }
      for (const [action, label] of entry.deleted ? [['forget', 'Allow re-import']] : [['restore', 'Restore'], ['delete', 'Delete permanently']]) {
        const button = el('button', action === 'delete' ? 'text-button danger-button' : 'text-button', label); button.type = 'button'; button.setAttribute('aria-label', `${label}: ${entry.name}`);
        button.addEventListener('click', async () => {
          if (action === 'delete' && !window.confirm(`Permanently delete “${entry.name}” from Image Trash? This cannot be undone. Archives and download caches are separate.`)) return;
          if (action === 'forget' && !window.confirm(`Allow “${entry.name}” to be imported again? Existing collection entries may then link to a file with the same name.`)) return;
          button.disabled = true;
          try {
            const response = await fetch(`/api/image-trash/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: entry.id }) });
            const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not update Image Trash.');
            await Promise.all([refreshImageTrash(), refreshStorage(), refresh(true)]);
            status.textContent = action === 'restore' ? 'File restored.' : action === 'delete' ? 'File permanently deleted; re-import remains blocked.' : 'Re-import is allowed again.';
          } catch (error) { status.textContent = error.message; button.disabled = false; }
        }); actions.append(button);
      }
      item.append(details, actions); list.append(item);
    }
    status.textContent = data.entries.length ? `${data.entries.length} ${data.entries.length === 1 ? 'entry' : 'entries'} in Image Trash and deletion records.` : 'Image Trash is empty.';
  } catch (error) { status.textContent = error.message; }
}
document.querySelector('#image-trash-refresh').addEventListener('click', refreshImageTrash);

document.querySelector('#remove-from-collection').addEventListener('click', async event => {
  const item = currentImages[currentIndex], collectionId = activeCollection;
  if (!collectionContext || !collectionId || !item?.id) return;
  event.target.disabled = true;
  try {
    await collectionRequest('remove', { collection: collectionId, item: item.id });
    lightbox.close();
    await openCollection(collectionId, collectionPageIndex);
    document.querySelector('#collection-status').textContent = 'Removed from this collection. The source file was not changed.';
  } catch (error) { document.querySelector('#collection-image-status').textContent = error.message; }
  finally { event.target.disabled = false; }
});

showPage();
