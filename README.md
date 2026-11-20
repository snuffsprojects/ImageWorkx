# ImageWorkx

ImageWorkx is a self-hosted gallery for importing ZIP and RAR archives and downloading supported media. It has no npm dependencies. The provided installer targets Debian or Ubuntu systems with **apt, systemd and Node.js 22 or newer**. Other Linux distributions require a manual installation.

ImageWorkx is based on ImageWorks and retains the `imageworks` service and configuration names. It cannot be installed alongside an existing ImageWorks service without adapting those settings.

## Install and start

Clone the repository into a location that the account running ImageWorkx can read. Install Git first if needed:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/snuffsprojects/ImageWorkx.git
cd ImageWorkx
```

Review the proposed service settings without making changes, then install:

```bash
bash install-ubuntu.sh --dry-run
sudo bash install-ubuntu.sh
```

The installer installs the distribution packages for Node.js, 7-Zip, FFmpeg, ImageMagick and JPEG XL tools; runs the tests; and creates a systemd service. Node.js **22 or newer is required**. If your distribution's package is older, install Node.js 22 or newer system-wide from a trusted source and rerun the installer. RAR extraction also requires a RAR-capable 7-Zip package from your distribution; the installer warns if one is not available.

By default the service runs as the account that invoked `sudo`, stores data in that account's `~/.local/share/imageworks`, and listens **only on the server itself**. Open [http://localhost:4173](http://localhost:4173) there. Copy ZIP or RAR files (including all parts of multipart archives) into that data directory's `Inbox` folder. Processed archives are retained in `Processed`, and gallery files are stored in `Gallery`.

The installer does not replace an existing `imageworks.service` or change firewall rules. This keeps existing installations and their settings intact. Run `sudo systemctl restart imageworks` after updating source files in an existing installation.

### Optional: another storage location

The account running the service must be able to create and write the data directory. For a dedicated, already-mounted storage drive, specify both the directory and the mount point; the service will refuse to start if the mount is missing:

```bash
sudo env IMAGEWORKS_DATA=/mnt/your-drive/ImageWorkx \
  IMAGEWORKS_MOUNT=/mnt/your-drive bash install-ubuntu.sh
```

Choose paths for your system. To select a different existing non-root account or port, set `IMAGEWORKS_USER` or `IMAGEWORKS_PORT` in the same way. Run `bash install-ubuntu.sh --help` for all options. These settings are saved in the generated systemd service.

### Optional: access from your home network

ImageWorkx has **no user accounts or login**: devices allowed to connect can view the gallery and operate the app. Only enable LAN access on a trusted network. For example, if your network uses `192.168.1.0/24`:

```bash
sudo env IMAGEWORKS_LAN_PREFIX=192.168.1. bash install-ubuntu.sh
```

Use your own IPv4 /24 prefix, not necessarily the example above. Combine this with the storage settings in a single install command if needed. On the server, run `hostname -I` to find its LAN address, then open `http://YOUR-SERVER-IP:4173` from another device. If you configured a different port, use that instead. Configure any firewall separately to allow only your trusted network. Do not forward the port to the internet.

The installer does **not** configure a Samba share. Set one up separately if you want to copy files into Inbox from another computer.

Failed downloads retain completed files in the cache; submit the same link to resume. PNG-to-WebP optimisation is optional: originals are kept unless a smaller, pixel-identical WebP can be verified using ImageMagick's `magick` command.

## Gallery pagination

Opened galleries display 15 items per page by default. Use the Files per page menu to choose 15, 30, 60 or 100 items; the choice is remembered in the browser. Previous/Next controls appear at the top and bottom with a page/range indicator. The full-screen image viewer continues across pages.
Gallery summaries are shared in memory between browsers and refreshed after imports, downloads and renames. The gallery is also rescanned every minute for changes made outside ImageWorkx. Opening a gallery retrieves its full image list; images on other pages are not added to the grid.

Gallery tiles and covers use previews generated on demand with FFmpeg and stored in `.previews` outside Gallery. The full-screen viewer uses the original file. If preview generation fails, the original is displayed instead. Previews older than 30 days are cleaned up daily and regenerated when needed.

## JPEG XL pilot

Install `libjxl-tools` on the ImageWorkx server (`sudo apt-get install libjxl-tools`). Open a gallery and select **JPEG XL pilot** to create a separate gallery. JPG and JPEG files are converted using reversible JPEG recompression and checked by reconstructing and hashing the complete original. Other supported media, including WebP and WebM, are copied unchanged. The original gallery is kept, so a pilot uses additional storage; it does not save disk space until a separate, deliberate migration is implemented. The pilot does not carry thread update metadata or unsupported files.

The pilot appears in the gallery once all files pass verification. ImageWorkx creates previews from JPEG XL and reconstructs the exact original JPEG for full-size viewing and downloads, so the pilot works even in browsers without JPEG XL support. Reconstruction requires `djxl` on the server for every full-size request. Only ImageWorkx-produced `.jpg.jxl` and `.jpeg.jxl` files are supported; other JPEG XL files are not imported. A failed pilot is not published. Do not restart the service while a pilot is running; an unexpected interruption can leave temporary `.jxl-pilot-*` and `.jxl-work-*` folders under the data directory for manual inspection.

## Gallery Trash

Open a gallery and choose **Move to Trash**. The entire gallery folder is moved to `.gallery-trash` under the ImageWorkx data folder, including any nested files and gallery metadata. It can be restored or permanently deleted from **Storage → Gallery Trash**. Trash uses disk space until permanently deleted and is not automatically emptied. Restoring refuses to replace a gallery with the same name. Archive files in Processed and download cache entries are separate and remain untouched. Gallery moves, restores and permanent deletions wait until imports, downloads and JPEG XL pilots are idle.

## Storage usage

Open the **Storage** tab for an on-demand breakdown of gallery media, Inbox, processed archives, download cache, image previews and video posters, plus drive capacity and free space. Folder sizes represent file lengths and may differ from allocated disk usage. Image previews can be cleared from this panel; they are regenerated when needed. Processed archives and download cache are not deleted by that control. Use **Load cached downloads** to inspect and remove individual download cache folders. Their completion status is not tracked, so review before removing: retries may re-download files and updates may create duplicates. Removal is disabled while downloads are active; gallery files are kept.

## WebM videos

Check **Include WebM videos** when downloading a 4chan thread. For an existing
thread, open its gallery, check **WebM videos**, then choose **Update thread**.
The choice is saved for future updates. Turning it off skips new videos and
preserves videos already in the gallery. GoonBox downloads remain image-only.
Renamed thread galleries receive updates in their existing folder. When 4chan returns 404 for a thread, the update control is marked unavailable for the current browser session; refresh the page to try again. Other errors remain retryable. Saved gallery files remain in place.

Videos use static preview tiles with a WebM badge. Opening one shows a muted
player with native controls; press Play to start. Closing it or moving to another
item stops playback and releases the source. Image zoom controls are hidden for
videos. An original-file download is available if a browser cannot play a clip.
Video byte-range requests support seeking. Media counts and storage totals
include both images and videos.

Install FFmpeg for local poster generation (`sudo apt-get install ffmpeg`). The
installer includes it. Posters are generated on demand, one at a time, and cached
in `.posters` under the data folder, outside Gallery. Without FFmpeg, or if a clip
cannot be decoded, a generic WebM tile is shown. Failed posters are retried after
service restart; cached posters can be regenerated by removing `.posters`.

See [WEBM-PLAN.md](WEBM-PLAN.md) for the implemented design and validation scope.

## Activity and logs

The **Activity** tab shows up to 200 recent import, download, service start and error events, including their local dates and times. It refreshes every 15 seconds while open and reads the existing rotating logs, so older events eventually expire. A service start is shown after each restart; shutdowns are not currently recorded.


The service logs to the system journal and to `Logs/imageworks.log` under the configured ImageWorkx data directory. Each line is a JSON record with
a UTC timestamp, severity, event name, and relevant context. Import failures
include the archive path, attempt count, next retry delay, error stack, extractor
command, exit code, and up to 16 KiB each of stdout and stderr. Import starts and
successes include archive names; successes include image counts and elapsed time.
Startup, download failures, request failures, and state-file errors are also logged.
Files rotate at 5 MiB with three backups (`.1` is newest), about 20 MiB total.
Failed archives retry after 30 seconds, increasing to a maximum of five minutes;
changing the archive resets the delay. Successful archives remain tracked as before.

```bash
journalctl -u imageworks -n 50 --no-pager
tail -n 20 "$HOME/.local/share/imageworks/Logs/imageworks.log"
```

After source updates, run `sudo systemctl restart imageworks` to load the changes.

## Archive retention

Original imported archives remain in `Processed` by default. The installer does not enable automatic deletion of archives.

## Administration

```bash
systemctl status imageworks
journalctl -u imageworks -n 50 --no-pager
sudo systemctl restart imageworks
sudo systemctl disable --now imageworks
```

The final command stops the app and disables automatic startup without deleting
media. Configuration lives in `/etc/systemd/system/imageworks.service`.

## Validation

```bash
node --check server.js
node --check public/app.js
node --test test/*.test.js
```

Tests use synthetic media and mocked source responses. They check download
deduplication, filename collisions, partial failure cleanup, album pagination,
Referer headers, gallery enumeration, image serving, renaming, invalid links,
and cross-origin write rejection. Live external downloads, real RAR extraction,
conversion, visual browser behaviour, and reboot persistence require installation
and real-world verification.

## License

ImageWorkx is available under the [MIT License](LICENSE).
