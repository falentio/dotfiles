#!/usr/bin/env bash
# One-command proof: a real pi session and a real /compact against a fake model.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=${MOCK_PROJECT:-/tmp/mock-project}
port=${MOCK_LLM_PORT:-$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')}

case "$work" in
	/tmp/*) rm -rf "$work" ;;
	*) echo "refusing to delete $work (set MOCK_PROJECT to a /tmp path)" >&2; exit 1 ;;
esac
mkdir -p "$work/.pi"
printf '%s\n' '{"compaction":{"enabled":true,"reserveTokens":100,"keepRecentTokens":100}}' > "$work/.pi/settings.json"

node "$here/mock-server.mjs" --port "$port" --script "$here/script.json" --log "$work/requests.jsonl" &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
sleep 0.8

rm -f "$work/rpc.jsonl"
echo "== HTTP mock =="
MOCK_PROJECT="$work" MOCK_LLM_PORT="$port" node "$here/drive-rpc.mjs" --turns 3 --compact

rm -f "$work/rpc.jsonl"
echo "== in-process faux provider =="
MOCK_PROJECT="$work" node "$here/drive-rpc.mjs" --provider faux --model faux-1 --ext faux-probe --turns 2 --compact

echo "== model requests captured: $(wc -l < "$work/requests.jsonl") =="
