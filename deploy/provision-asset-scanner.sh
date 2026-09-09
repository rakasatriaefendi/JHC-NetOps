#!/usr/bin/env bash
set -euo pipefail

[[ "${EUID}" -eq 0 ]] || { echo "Run as root after operator review." >&2; exit 1; }
runtime_user="${1:-mini-pc}"
[[ "$runtime_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "Invalid runtime user." >&2; exit 1; }
id "$runtime_user" >/dev/null 2>&1 || { echo "Runtime user does not exist." >&2; exit 1; }
[[ -x /usr/bin/nmap ]] || { echo "/usr/bin/nmap must be installed first." >&2; exit 1; }
[[ -x /usr/sbin/visudo ]] || { echo "visudo is required." >&2; exit 1; }

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
helper=/usr/local/libexec/jhc-netops-asset-scan
sudoers=/etc/sudoers.d/jhc-netops-asset-scan
temporary="$(mktemp)"
trap 'rm -f -- "$temporary"' EXIT

install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$script_dir/jhc-netops-asset-scan" "$helper"
printf '%s ALL=(root) NOPASSWD: %s *\n' "$runtime_user" "$helper" >"$temporary"
chmod 0440 "$temporary"
/usr/sbin/visudo -cf "$temporary"
install -o root -g root -m 0440 "$temporary" "$sudoers"

echo "Installed the bounded JHC NetOps asset scanner helper for $runtime_user."
