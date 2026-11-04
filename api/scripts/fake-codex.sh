#!/usr/bin/env bash
# Test fake of `codex exec --json`. Emits real-shape JSONL: one event object per
# line (thread.started / turn.started / item.completed[agent_message] /
# turn.completed), matching codex-cli >= 0.130. The assistant reply lives in the
# `agent_message` item — see extractAgentMessage() in codex-cli.ts.
set -u
for arg in "$@"; do
  case "$arg" in
    --version|-v) echo "${FAKE_CODEX_VERSION:-codex-cli 0.5.0-fake}"; exit 0 ;;
  esac
done
# 测试用：把收到的命令行参数逐行写进文件，供断言 --model / -m 等参数
if [[ -n "${FAKE_CODEX_ARGS_FILE:-}" ]]; then printf '%s\n' "$@" > "$FAKE_CODEX_ARGS_FILE"; fi
cat > /dev/null
if [[ "${FAKE_CODEX_ERROR:-}" == "auth" ]]; then
  echo "Codex CLI not authenticated" >&2
  exit 1
fi
reply="${FAKE_CODEX_REPLY:-codex-hi}"
python3 - "$reply" <<'PY'
import json, sys
reply = sys.argv[1]
for evt in (
    {"type": "thread.started", "thread_id": "test-thread"},
    {"type": "turn.started"},
    {"type": "item.completed", "item": {"id": "item_0", "type": "agent_message", "text": reply}},
    {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}},
):
    print(json.dumps(evt))
PY
