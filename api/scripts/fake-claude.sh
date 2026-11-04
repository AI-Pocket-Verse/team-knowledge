#!/usr/bin/env bash
# Test fake of `claude -p --output-format=stream-json --allowedTools= --max-turns=1`.
# Reads prompt from stdin (ignored), emits stream-json frames, exits.
# Behavior is controlled by env vars so tests can drive the shape:
#   FAKE_CLAUDE_REPLY="hello\nworld"   content to stream as tokens
#   FAKE_CLAUDE_ERROR=auth             emit auth-error stderr and exit 1
#   FAKE_CLAUDE_VERSION=2.1.300-test   printed by --version (must be >= MIN_CLAUDE_VERSION to count as ready)
#   FAKE_CLAUDE_TOOLGAP=N              N 个 tool_use 帧(间隔 ~0.15s)后才出正文
set -u

for arg in "$@"; do
  case "$arg" in
    --version|-v)
      echo "${FAKE_CLAUDE_VERSION:-2.1.318 (Claude Code)}"
      exit 0
      ;;
  esac
done

# 测试用：把收到的命令行参数逐行写进文件，供断言 --model / -m 等参数
if [[ -n "${FAKE_CLAUDE_ARGS_FILE:-}" ]]; then printf '%s\n' "$@" > "$FAKE_CLAUDE_ARGS_FILE"; fi
# 测试用：记录工作目录与 stdin 收到的提示词
if [[ -n "${FAKE_CLAUDE_CWD_FILE:-}" ]]; then pwd -P > "$FAKE_CLAUDE_CWD_FILE"; fi
if [[ -n "${FAKE_CLAUDE_STDIN_FILE:-}" ]]; then cat > "$FAKE_CLAUDE_STDIN_FILE"; else cat > /dev/null; fi

if [[ "${FAKE_CLAUDE_ERROR:-}" == "auth" ]]; then
  echo "Please run \`claude login\`" >&2
  exit 1
fi

reply="${FAKE_CLAUDE_REPLY:-hi there}"
i=0
len=${#reply}
# Mirror real Claude CLI 2.x stream-json output (with --include-partial-messages):
# message_start → content_block_start → N×content_block_delta → content_block_stop
# → message_stop → result. The parser only consumes content_block_delta + result;
# the other frames are emitted for fidelity (and to exercise discard paths).
printf '{"type":"stream_event","event":{"type":"message_start","message":{"id":"fake","type":"message","role":"assistant","content":[]}}}\n'

# Optional thinking block (extended thinking models). When
# FAKE_CLAUDE_THINKING is set, emit a leading thinking block at
# index 0 — empty value → only the open/close pair (signature-only
# case, matches what current Claude CLI emits today); non-empty
# value → also stream thinking_delta chunks carrying the text.
# The answer text block shifts to index 1 in either case so the
# parser must use index-keyed block-type tracking, not "first one wins".
text_index=0
think_block=0
if [[ -n "${FAKE_CLAUDE_THINKING:-}" ]]; then
  think_block=1
  text_index=1
  printf '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}}\n'
  if [[ "${FAKE_CLAUDE_THINKING}" != "1" ]]; then
    think="${FAKE_CLAUDE_THINKING}"
    tjson=$(printf '%s' "$think" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')
    printf '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":%s}}}\n' "$tjson"
  fi
  printf '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}\n'
fi

# Optional tool-use gap. When FAKE_CLAUDE_TOOLGAP=N,emit N 个 tool_use 块,
# 每个间隔 ~0.15s,且全部在正文之前 —— 这正是 webTools 路径(助手自答开
# WebSearch/WebFetch)的真实形态:连续若干轮工具往返,期间一个 text_delta 都
# 没有。用来守住「工具帧也算 liveness」:否则一次正常的联网检索会被 idle
# 计时器当成卡死 SIGKILL 掉。
if [[ -n "${FAKE_CLAUDE_TOOLGAP:-}" ]]; then
  n="${FAKE_CLAUDE_TOOLGAP}"
  g=0
  while (( g < n )); do
    sleep 0.15
    idx=$((text_index + g + 1))
    printf '{"type":"stream_event","event":{"type":"content_block_start","index":%d,"content_block":{"type":"tool_use","id":"tu_%d","name":"WebSearch","input":{}}}}\n' "$idx" "$g"
    printf '{"type":"stream_event","event":{"type":"content_block_delta","index":%d,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"q%d\\"}"}}}\n' "$idx" "$g"
    printf '{"type":"stream_event","event":{"type":"content_block_stop","index":%d}}\n' "$idx"
    g=$((g + 1))
  done
fi

printf '{"type":"stream_event","event":{"type":"content_block_start","index":%d,"content_block":{"type":"text","text":""}}}\n' "$text_index"
while (( i < len )); do
  chunk="${reply:$i:4}"
  json=$(printf '%s' "$chunk" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')
  printf '{"type":"stream_event","event":{"type":"content_block_delta","index":%d,"delta":{"type":"text_delta","text":%s}}}\n' "$text_index" "$json"
  i=$((i + 4))
done
printf '{"type":"stream_event","event":{"type":"content_block_stop","index":%d}}\n' "$text_index"
printf '{"type":"stream_event","event":{"type":"message_stop"}}\n'

# Optional web-search/fetch citations. When FAKE_CLAUDE_WEB is set, emit an
# `assistant` message event carrying a web_search_tool_result block (two hits,
# one duplicated to exercise dedup) plus a WebFetch tool_use — mirrors how the
# real CLI surfaces联网命中的网页 URL. The parser extracts citation chunks from these.
if [[ -n "${FAKE_CLAUDE_WEB:-}" ]]; then
  printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://a.example/1","title":"页面一"},{"type":"web_search_result","url":"https://a.example/2","title":"页面二"},{"type":"web_search_result","url":"https://a.example/1","title":"页面一(重复)"}]},{"type":"server_tool_use","name":"WebFetch","input":{"url":"https://b.example/doc"}}]}}'
fi
full_json=$(printf '%s' "$reply" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')
printf '{"type":"result","subtype":"success","is_error":false,"result":%s}\n' "$full_json"

# If HANG=1, close stdout (so Node's reader sees EOF) and then sleep
# forever — used to exercise the wall-clock timeout and abort paths.
# Closing fd 1 first is critical: otherwise the `sleep` child inherits
# the open pipe and the Node-side stdout never sees EOF, hanging the
# for-await loop even after we SIGKILL the parent bash.
if [[ "${FAKE_CLAUDE_HANG:-}" == "1" ]]; then
  exec 1>&-
  sleep 999
fi
