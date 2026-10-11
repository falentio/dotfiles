#!/bin/sh
# Symlink this repo's managed config into $HOME.
# Idempotent: safe to re-run on this or a fresh machine.
# - correct symlink already in place -> no-op
# - real file/dir at target -> moved to <target>.bak.<timestamp>, then linked
# - symlink pointing elsewhere -> left alone with a warning
set -eu

REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"

link_one() {
	src_rel="$1"
	dst_rel="$2"
	src="$REPO_DIR/$src_rel"
	dst="$HOME/$dst_rel"

	if [ ! -e "$src" ] && [ ! -L "$src" ]; then
		echo "error: source $src does not exist, skipping $dst" >&2
		return 1
	fi

	if [ -L "$dst" ]; then
		if [ "$(readlink "$dst")" = "$src" ]; then
			echo "ok: $dst -> $src"
			return 0
		fi
		echo "warn: $dst points elsewhere ($(readlink "$dst")), leaving it alone" >&2
		return 1
	fi

	if [ -e "$dst" ]; then
		bak="$dst.bak.$(date +%Y%m%d%H%M%S)"
		echo "info: moving existing $dst to $bak"
		mv "$dst" "$bak"
	fi

	mkdir -p "$(dirname "$dst")" || return 1
	ln -s "$src" "$dst" || return 1
	echo "linked: $dst -> $src"
}

fail=0
while read -r src_rel dst_rel; do
	[ -n "$src_rel" ] && [ -n "$dst_rel" ] || continue
	link_one "$src_rel" "$dst_rel" || fail=1
done <<'LINKS'
.pi            .pi
.agents        .agents
config/fish    .config/fish
config/kitty   .config/kitty
LINKS
exit "$fail"
