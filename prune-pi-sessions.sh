#!/usr/bin/env bash
# Delete Pi session transcripts older than a cutoff.
#
# Sessions live at <session-dir>/--<cwd>--/<timestamp>_<id>.jsonl. A session's
# age is its last-modified time, so a conversation still in use survives until
# it has been idle for the whole cutoff.
#
# Usage: prune-pi-sessions.sh [options] [DAYS]
set -euo pipefail

default_days=15
days="${SESSION_MAX_AGE_DAYS:-$default_days}"
dry_run=0
permanent=0
sessions_dir="${PI_CODING_AGENT_SESSION_DIR:-$HOME/.pi/agent/sessions}"

usage() {
	cat <<'EOF'
Delete Pi session transcripts older than a cutoff.

Usage: prune-pi-sessions.sh [options] [DAYS]

  DAYS                 Delete sessions idle for more than DAYS days (default 15).
  -d, --days N         Same as the DAYS argument.
  -n, --dry-run        Print what would be deleted without deleting.
  -p, --permanent      Delete with rm instead of the trash CLI.
  -h, --help           Show this help.

Environment:
  SESSION_MAX_AGE_DAYS         Default cutoff in days.
  PI_CODING_AGENT_SESSION_DIR  Session storage directory.

The active session ($PI_SESSION_FILE) is never deleted.
EOF
}

days_arg=""
while [ $# -gt 0 ]; do
	case "$1" in
		-h|--help) usage; exit 0 ;;
		-n|--dry-run) dry_run=1; shift ;;
		-d|--days)
			[ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }
			days_arg="$2"
			shift 2
			;;
		-p|--permanent) permanent=1; shift ;;
		-*) echo "error: unknown option $1" >&2; exit 2 ;;
		*)
			[ -z "$days_arg" ] || { echo "error: DAYS given twice" >&2; exit 2; }
			days_arg="$1"
			shift
			;;
	esac
done

if [ -n "$days_arg" ]; then
	days="$days_arg"
fi

case "$days" in
	''|*[!0-9]*)
		echo "error: DAYS must be a non-negative integer, got '$days'" >&2
		exit 2
		;;
esac

if [ ! -d "$sessions_dir" ]; then
	echo "no sessions directory at $sessions_dir"
	exit 0
fi

# -mmin counts whole minutes of age, so "+N*1440" is exactly "older than N
# days". -mtime counts whole days and would push the cutoff out by one.
cutoff_minutes=$((days * 1440))

use_trash=0
if [ "$permanent" -eq 0 ] && command -v trash >/dev/null 2>&1; then
	use_trash=1
fi

matched=0
deleted=0
while IFS= read -r -d '' file; do
	if [ -n "${PI_SESSION_FILE:-}" ] && [ "$file" = "$PI_SESSION_FILE" ]; then
		continue
	fi
	matched=$((matched + 1))
	if [ "$dry_run" -eq 1 ]; then
		printf 'would delete %s\n' "$file"
		continue
	fi
	if [ "$use_trash" -eq 1 ]; then
		trash "$file"
	else
		rm -- "$file"
	fi
	printf 'deleted %s\n' "$file"
	deleted=$((deleted + 1))
done < <(find "$sessions_dir" -type f -name '*.jsonl' -mmin "+$cutoff_minutes" -print0)

# Drop the project directories the deletions emptied.
find "$sessions_dir" -mindepth 1 -type d -empty -delete

if [ "$dry_run" -eq 1 ]; then
	echo "dry run: $matched session(s) older than ${days} day(s) would be deleted"
else
	echo "deleted $deleted session(s) older than ${days} day(s)"
fi
