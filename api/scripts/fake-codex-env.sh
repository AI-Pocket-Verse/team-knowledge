#!/usr/bin/env bash
# 测试用假 codex：把自己的 cwd、参数、环境变量当作回复吐出来，用来验证子进程隔离。
set -u
for arg in "$@"; do
  case "$arg" in
    --version|-v) echo "0.5.0-fake"; exit 0 ;;
  esac
done
cat > /dev/null
python3 - "$PWD" "$*" <<'PY'
import json, os, sys
text = "cwd=%s args=%s env=%s" % (sys.argv[1], sys.argv[2], json.dumps(dict(os.environ)))
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}))
PY
