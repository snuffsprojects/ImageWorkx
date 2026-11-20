#!/usr/bin/env bash
# Installs ImageWorks on Debian/Ubuntu systems using apt and systemd.
set -euo pipefail
usage() {
  cat <<'HELP'
Usage: sudo bash install-ubuntu.sh [--dry-run]

Run from a checked-out ImageWorks source directory. By default the service runs
as the invoking sudo user, stores data in ~/.local/share/imageworks, and listens
on localhost only. Optional environment variables (pass with sudo env):
  IMAGEWORKS_USER         Existing non-root service account
  IMAGEWORKS_DATA         Absolute data directory writable by that account
  IMAGEWORKS_PORT         TCP port (default 4173)
  IMAGEWORKS_LAN_PREFIX   Enable LAN access for an IPv4 /24, e.g. 192.168.1.
  IMAGEWORKS_MOUNT        Require this absolute path to be an active mount

--dry-run prints the proposed service configuration without changing the system.
The installer refuses to replace an existing ImageWorks systemd unit.
HELP
}
dry_run=0
case "${1:-}" in
  '') ;;
  --dry-run) dry_run=1 ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }
if (( ! dry_run )) && [[ $EUID -ne 0 ]]; then echo 'Run the installer with sudo.' >&2; exit 1; fi
app_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
app_user=${IMAGEWORKS_USER:-${SUDO_USER:-}}
if [[ -z $app_user && $EUID -ne 0 ]]; then app_user=$(id -un); fi
[[ -n $app_user && $app_user != root ]] || { echo 'Set IMAGEWORKS_USER to an existing non-root account.' >&2; exit 1; }
id "$app_user" >/dev/null 2>&1 || { echo "User not found: $app_user" >&2; exit 1; }
app_group=$(id -gn "$app_user")
app_home=$(getent passwd "$app_user" | cut -d: -f6)
[[ $app_home == /* ]] || { echo 'Could not determine the account home directory.' >&2; exit 1; }
data_dir=${IMAGEWORKS_DATA:-"$app_home/.local/share/imageworks"}
port=${IMAGEWORKS_PORT:-4173}
lan_prefix=${IMAGEWORKS_LAN_PREFIX:-}
required_mount=${IMAGEWORKS_MOUNT:-}
[[ $data_dir == /* ]] || { echo 'IMAGEWORKS_DATA must be an absolute path.' >&2; exit 1; }
data_dir=$(realpath -m -- "$data_dir")
[[ $data_dir != / ]] || { echo 'IMAGEWORKS_DATA cannot be the filesystem root.' >&2; exit 1; }
[[ $port =~ ^[0-9]{1,5}$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || { echo 'IMAGEWORKS_PORT must be between 1 and 65535.' >&2; exit 1; }
host=127.0.0.1
if [[ -n $lan_prefix ]]; then
  [[ $lan_prefix =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.$ ]] || { echo 'IMAGEWORKS_LAN_PREFIX must be an IPv4 /24 prefix such as 192.168.1.' >&2; exit 1; }
  for octet in "${BASH_REMATCH[@]:1}"; do (( 10#$octet <= 255 )) || { echo 'Invalid IPv4 prefix.' >&2; exit 1; }; done
  host=0.0.0.0
fi
if [[ -n $required_mount ]]; then
  [[ $required_mount == /* ]] || { echo 'IMAGEWORKS_MOUNT must be an absolute path.' >&2; exit 1; }
  required_mount=$(realpath -m -- "$required_mount")
  [[ $required_mount != / && $data_dir == "$required_mount"/* ]] || { echo 'IMAGEWORKS_DATA must be within the specified non-root mount.' >&2; exit 1; }
  if (( ! dry_run )); then mountpoint -q -- "$required_mount" || { echo 'The required storage mount is not mounted.' >&2; exit 1; }; fi
fi
# Avoid ambiguous or interpolated systemd unit syntax in configurable values.
for value in "$app_dir" "$app_user" "$app_group" "$data_dir" "$required_mount"; do
  [[ $value != *$'\n'* && $value != *$'\r'* && $value != *'"'* && $value != *'\'* && $value != *'%'* ]] || { echo 'Paths and account names cannot contain quotes, backslashes, percent signs or newlines.' >&2; exit 1; }
done
node_bin=$(command -v node || printf /usr/bin/node)
[[ $node_bin == /* && $node_bin != *'%'* && $node_bin != *'"'* && $node_bin != *'\'* ]] || { echo 'Unsupported Node.js executable path.' >&2; exit 1; }
unit=/etc/systemd/system/imageworks.service
if (( ! dry_run )) && [[ -e $unit || -L $unit ]]; then
  echo "An ImageWorks service already exists at $unit. No configuration was changed; review it before reinstalling." >&2
  exit 1
fi
mount_unit=''
mount_check=''
if [[ -n $required_mount ]]; then
  mount_unit="RequiresMountsFor=\"$required_mount\""
  mount_check="ExecStartPre=/usr/bin/mountpoint -q \"$required_mount\""
fi
unit_text=$(cat <<UNIT
[Unit]
Description=ImageWorks gallery and importer
After=network-online.target
Wants=network-online.target
$mount_unit

[Service]
Type=simple
User=$app_user
Group=$app_group
WorkingDirectory=$app_dir
Environment="IMAGEWORKS_DATA=$data_dir"
Environment="HOST=$host"
Environment="PORT=$port"
Environment="LAN_PREFIX=$lan_prefix"
$mount_check
ExecStart="$node_bin" "$app_dir/server.js"
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths="$data_dir"
UMask=0027

[Install]
WantedBy=multi-user.target
UNIT
)
if (( dry_run )); then
  printf '%s\n' 'Dry run: no changes made. Proposed unit:' "$unit_text"
  exit 0
fi
command -v apt-get >/dev/null && command -v systemctl >/dev/null && command -v systemd-analyze >/dev/null || { echo 'This installer requires apt and systemd.' >&2; exit 1; }
apt-get update
packages=(nodejs ffmpeg imagemagick libjxl-tools)
if apt-cache show 7zip >/dev/null 2>&1; then packages+=(7zip)
elif apt-cache show p7zip-full >/dev/null 2>&1; then packages+=(p7zip-full)
else echo 'No 7-Zip package found. Enable the appropriate distribution repositories.' >&2; exit 1; fi
if apt-cache show 7zip-rar >/dev/null 2>&1; then packages+=(7zip-rar)
elif apt-cache show p7zip-rar >/dev/null 2>&1; then packages+=(p7zip-rar)
else echo 'RAR extraction support is unavailable from enabled repositories; ZIP imports will still work.' >&2; fi
apt-get install -y "${packages[@]}"
"$node_bin" -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or newer is required. Install it from a trusted source and run the installer again."); process.exit(1); }'
"$node_bin" --check "$app_dir/server.js"
"$node_bin" --check "$app_dir/public/app.js"
"$node_bin" --test "$app_dir/test/"*.test.js
runuser -u "$app_user" -- mkdir -p -- "$data_dir/Inbox" "$data_dir/Gallery" "$data_dir/.downloads"
unit_tmp=$(mktemp --suffix=.service)
unit_candidate=''
trap 'rm -f -- "$unit_tmp"; if [[ -n $unit_candidate ]]; then rm -f -- "$unit_candidate"; fi' EXIT
printf '%s\n' "$unit_text" > "$unit_tmp"
systemd-analyze verify "$unit_tmp"
unit_candidate=$(mktemp /etc/systemd/system/.imageworks-XXXXXX.service)
install -m 0644 "$unit_tmp" "$unit_candidate"
if ! ln "$unit_candidate" "$unit"; then
  echo 'The ImageWorks service appeared during installation; it was not replaced.' >&2
  exit 1
fi
systemctl daemon-reload
systemctl enable --now imageworks.service
systemctl --no-pager --full status imageworks.service
printf '\nImageWorks is available on this machine at http://localhost:%s\n' "$port"
printf 'Inbox: %s/Inbox\n' "$data_dir"
if [[ -n $lan_prefix ]]; then
  printf 'LAN access enabled for %s0/24. Find the server IP with: hostname -I\n' "$lan_prefix"
  echo 'Configure your firewall separately if needed; the installer does not change firewall rules.'
fi
