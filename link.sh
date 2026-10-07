#!/bin/sh
# Symlink ~/.pi and ~/.agents to this dotfiles repo.
# Idempotent: safe to re-run on this or a fresh machine.
# - correct symlink already in place -> no-op
# - real file/dir at target -> moved to ~/.<name>.bak.<timestamp>, then linked
# - symlink pointing elsewhere -> left alone with a warning
set -eu

REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"

link_one() {
	name="$1"
	src="$REPO_DIR/$name"
	dst="$HOME/$name"

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

	ln -s "$src" "$dst"
	echo "linked: $dst -> $src"
}

fail=0
for n in .pi .agents; do
	link_one "$n" || fail=1
done
exit "$fail"
