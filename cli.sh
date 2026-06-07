#!/bin/bash
# Lomo CLI 测试工具
# 用法: ./cli.sh "你的消息"
#       ./cli.sh            # 交互模式

BASE="http://127.0.0.1:18895"

send() {
  curl -s "$BASE/api/cli/send" \
    -H 'Content-Type: application/json' \
    -d "{\"text\": \"$1\"}" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  if 'error' in d: print(f'ERROR: {d[\"error\"]}')
  else: print(d.get('reply', '(empty)'))
except: print('(invalid response)')
"
}

if [ -n "$1" ]; then
  # 单条模式
  send "$1"
else
  # 交互模式
  echo "Lomo CLI (输入 /quit 退出)"
  echo "---"
  while true; do
    read -r -p "> " input
    [ "$input" = "/quit" ] && break
    [ -z "$input" ] && continue
    send "$input"
    echo ""
  done
fi
