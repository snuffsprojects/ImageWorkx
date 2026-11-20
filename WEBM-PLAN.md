# WebM implementation

Implemented WebM support for 4chan as an opt-in download setting. Keep original files;
no video conversion is needed for the first version. Existing galleries should
continue to work, including thread updates and download deduplication.

## Viewing behaviour

- Use a static poster with a WebM/play badge in the gallery, including video-only
  albums. Do not put running video players in the grid.
- Open a single video player in the existing lightbox. Show native controls,
  start muted, and require the user to press Play. Do not autoplay or loop.
- Attach the video source only when that item is opened. Pause, remove the source,
  and reset the player when navigating or closing, including Escape.
- Hide image zoom and pan controls for videos. Previous/Next should navigate
  mixed images and videos, including across gallery page boundaries.
- Offer an original-file download if the browser cannot decode a particular clip.

## Implementation details

1. Add an include-WebM setting to the download form and request, and persist the
   choice in the thread source metadata so Update thread honours it.
2. Allow .webm in the 4chan branch of downloader.js. Keep GoonBox filtering and
   PNG conversion separate. Existing file size checks and indexes can be reused.
3. Extend gallery enumeration and download-to-gallery copying in server.js to
   include WebM. Return an explicit media type and poster URL; count and label
   items as media rather than images where appropriate.
4. Create local static posters with FFmpeg, retaining a generic video tile if
   generation fails. Cache posters outside the enumerated gallery files so they
   are not counted as extra images. Add FFmpeg to installation dependencies.
5. Serve video/webm and implement HTTP byte ranges (206, Content-Range,
   Accept-Ranges, and 416 for unsatisfiable ranges) for seeking and efficient
   playback. The current file server sends only whole-file 200 responses.
6. Add the lightbox video player and explicit teardown for navigation and close.

## Verification before enabling

Test image-only, video-only and mixed threads; opt-out and opt-in updates;
deduplication; poster failures; correct counts and album covers; range responses;
video navigation across page boundaries; close/reopen; and unsupported playback.
Check on the actual desktop and phone browsers that only the selected video can
play and leaving it stops playback and releases its source.

WebM downloads are now available as an opt-in setting. Automated tests cover
filtering, deduplication, opt-out with previously cached videos, updates to renamed
threads, video-only gallery enumeration, range responses, poster caching and
fallbacks, and player teardown across pagination and close. Actual browser codec
compatibility and visual playback on desktop/phone remain manual checks.
