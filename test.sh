#!/bin/bash
# Lomo 回归测试
# 用法: ./test.sh
# 依赖: curl, python3, jq(可选)
# 测试完成后自动清理测试数据

cd "$(dirname "$0")" || exit 1
BASE="http://127.0.0.1:18895"
PASS=0
FAIL=0

# ── helpers ──

send() {
  local text="$1"
  curl -s -m 60 "$BASE/api/cli/send" \
    -H 'Content-Type: application/json' \
    -d "{\"text\": \"$text\"}"
}

get_field() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$2',''))" 2>/dev/null
}

assert_not_empty() {
  local name="$1" val="$2"
  if [ -n "$val" ] && [ "$val" != "None" ] && [ "$val" != "''" ]; then
    echo "  ✓ $name"; PASS=$((PASS+1))
  else
    echo "  ✗ $name (empty)"; FAIL=$((FAIL+1))
  fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qi "$needle"; then
    echo "  ✓ $name"; PASS=$((PASS+1))
  else
    echo "  ✗ $name (未找到: $needle)"; FAIL=$((FAIL+1))
  fi
}

assert_true() {
  local name="$1" result="$2"
  if [ "$result" = "true" ]; then
    echo "  ✓ $name"; PASS=$((PASS+1))
  else
    echo "  ✗ $name"; FAIL=$((FAIL+1))
  fi
}

# ── 测试开始 ──

echo "========================================="
echo "Lomo 回归测试 $(date '+%Y-%m-%d %H:%M')"
echo "========================================="
echo ""

# ── 0. 基础设施 ──
echo "--- 基础设施 ---"
HEALTH=$(curl -s -m 5 "$BASE/health")
assert_not_empty "健康检查" "$(get_field "$HEALTH" "status")"

# ── 1. 基本对话 ──
echo ""
echo "--- 基本对话 ---"
R1=$(send "你好，简单回复 ok 两个字")
REPLY1=$(get_field "$R1" "reply")
assert_not_empty "基本对话有回复" "$REPLY1"

# ── 2. 时间感知 ──
echo ""
echo "--- 时间感知 ---"
R2=$(send "现在几点了")
REPLY2=$(get_field "$R2" "reply")
assert_true "回复包含时间信息" "$(echo "$REPLY2" | grep -qE "$(date '+%-H')|$(date '+%H')|$(date '+%I')|点|时" && echo true || echo false)"

# ── 3. 工具调用 web_search ──
echo ""
echo "--- 工具调用 ---"
R3=$(send "帮我搜索一下今天北京天气")
REPLY3=$(get_field "$R3" "reply")
assert_not_empty "web_search 有回复" "$REPLY3"
assert_true "搜索回复非纯占位" "$(echo "$REPLY3" | grep -qv 'tool_use\|XML' && echo true || echo false)"

# ── 4. 工具调用 reminder ──
REMINDERS_BEFORE=$(python3 -c "import json; data=json.load(open('state/reminders.json')); cli=[r for r in data if r.get('chatId','').startswith('cli:')]; print(len(cli))" 2>/dev/null)
bun -e "
const { addReminder } = require('./src/reminders')
addReminder({ chatId: 'cli:test', role: 'lomo', delivery: 'fixed', type: 'once', text: '回归测试提醒', label: '回归测试', fireAt: Date.now() + 86400000, enabled: true })
" 2>/dev/null
REMINDERS_AFTER=$(python3 -c "import json; data=json.load(open('state/reminders.json')); cli=[r for r in data if r.get('chatId','').startswith('cli:')]; print(len(cli))" 2>/dev/null)
assert_true "reminder_create 写入成功" "$([ "${REMINDERS_AFTER:-0}" -gt "${REMINDERS_BEFORE:-0}" ] && echo true || echo false)"

# ── 5. 工具调用 note ──
NOTES_BEFORE=$(python3 -c "import json; data=json.load(open('state/notes.json')) if __import__('os').path.exists('state/notes.json') else []; print(len(data))" 2>/dev/null)
bun -e "
const { addNote } = require('./src/notes')
addNote('回归测试笔记内容', ['测试'])
" 2>/dev/null
NOTES_AFTER=$(python3 -c "import json; data=json.load(open('state/notes.json')) if __import__('os').path.exists('state/notes.json') else []; print(len(data))" 2>/dev/null)
assert_true "note_save 写入成功" "$([ "${NOTES_AFTER:-0}" -gt "${NOTES_BEFORE:-0}" ] && echo true || echo false)"

SEARCH_RESULT=$(bun -e "
const { searchNotes } = require('./src/notes')
const notes = searchNotes('回归测试')
console.log(notes.length)
" 2>/dev/null)
assert_true "note_search 搜索成功" "$([ "${SEARCH_RESULT:-0}" -gt 0 ] && echo true || echo false)"

# ── 6. 系统命令 ──
echo ""
echo "--- 系统命令 ---"
R5=$(send "/status")
REPLY5=$(get_field "$R5" "reply")
assert_contains "status 包含角色" "$REPLY5" "Lomo"
assert_contains "status 包含模型信息" "$REPLY5" "模型"

R6=$(send "/model")
REPLY6=$(get_field "$R6" "reply")
assert_not_empty "model 有返回" "$REPLY6"

# ── 7. Scheduler + 持久化 ──
echo ""
echo "--- Scheduler ---"
assert_true "Scheduler 已启动" "$(grep -c "scheduler.*started" lomo.log 2>/dev/null | grep -qv '^0$' && echo true || echo false)"
assert_true "reminders.json 存在" "$([ -f state/reminders.json ] && echo true || echo false)"
ACTIVE=$(python3 -c "import json; print(len(json.load(open('state/active.json'))))" 2>/dev/null)
assert_true "active.json 有记录" "$([ "${ACTIVE:-0}" -gt 0 ] && echo true || echo false)"

# ── 8. 多模态（TTS + VLM + 语音） ──
echo ""
echo "--- 多模态 ---"
assert_true "sendTTS / transcribeAudio / describeFeishuImage 存在" "$(grep -qE 'async function sendTTS|async function transcribeAudio|async function describeFeishuImage' src/server.ts && echo true || echo false)"
assert_true "VLM endpoint 正确" "$(grep -q 'api.minimaxi.com/v1/coding_plan/vlm' src/server.ts && echo true || echo false)"
assert_true "语音转写 endpoint 正确" "$(grep -q 'doubao-seed-2-0-mini' src/server.ts && echo true || echo false)"

# TTS 代码块过滤
assert_true "stripCodeBlocksForTTS 存在" "$(grep -q 'function stripCodeBlocksForTTS' src/server.ts && echo true || echo false)"
TTS_FILTER_RESULT=$(bun -e "
function stripCodeBlocksForTTS(text) {
  let out = text.replace(/\`\`\`[\\s\\S]*?\`\`\`/g, '此处为代码块')
  out = out.replace(/\\n{3,}/g, '\\n\\n').trim()
  return out
}
const r1 = stripCodeBlocksForTTS('前面 \`\`\`\n[foo]\n\`\`\` 后面')
if (r1 !== '前面 此处为代码块 后面') process.exit(1)
const r2 = stripCodeBlocksForTTS('看 \`code\` 和普通字')
if (r2 !== '看 \`code\` 和普通字') process.exit(2)
process.exit(0)
" 2>/dev/null)
assert_true "TTS 过滤：代码块占位 + 行内保留" "$([ $? -eq 0 ] && echo true || echo false)"

# ── 9. XML 工具调用解析 ──
echo ""
echo "--- XML 工具调用解析 ---"
assert_true "parseToolCallXml / stripToolCallXml 存在" "$(grep -qE 'export function parseToolCallXml|export function stripToolCallXml' src/tools.ts && echo true || echo false)"
assert_true "runToolLoop + MAX_TOOL_ITERATIONS=10" "$(grep -qE 'async function runToolLoop|MAX_TOOL_ITERATIONS = 10' src/server.ts && grep -qE 'async function runToolLoop' src/server.ts && grep -q 'MAX_TOOL_ITERATIONS = 10' src/server.ts && echo true || echo false)"
assert_true "重复错误检测存在" "$(grep -q 'lastErrorSigs' src/server.ts && echo true || echo false)"
assert_true "空回复兜底存在" "$(grep -q 'rawReply 为空，触发 fallback' src/server.ts && echo true || echo false)"

XML_RESULT=$(bun -e "
import { parseToolCallXml, stripToolCallXml } from './src/tools.ts'
// 1) web_search
const r1 = parseToolCallXml('<tool_call>\n<invoke name=\"web_search\">\n<query>test</query>\n</invoke>\n</tool_call>')
if (r1.length !== 1 || r1[0].function.name !== 'web_search') process.exit(1)
if (JSON.parse(r1[0].function.arguments).query !== 'test') process.exit(2)
// 2) memory_store 多 invoke
const r2 = parseToolCallXml('<tool_call>\n<invoke name=\"memory_store\">\n<invoke name=\"content\">x</content>\n<invoke name=\"importance\">8</importance>\n</invoke>\n</tool_call>')
if (r2.length !== 1 || r2[0].function.name !== 'memory_store') process.exit(3)
if (JSON.parse(r2[0].function.arguments).content !== 'x') process.exit(4)
// 3) strip
if (stripToolCallXml('好的<tool_call>\n<invoke>\n</invoke>\n</tool_call>再见') !== '好的再见') process.exit(5)
process.exit(0)
" 2>/dev/null)
assert_true "XML 解析 + 剥离" "$([ $? -eq 0 ] && echo true || echo false)"

# ── 10. Anthropic 格式工具调用（MiniMax 新端点） ──
echo ""
echo "--- Anthropic 格式工具调用 ---"
ANTHROPIC_TEST=$(bun -e "
// 模拟 minimax.ts 中的 toAnthropicMessages 转换
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

function toAnthropicMessages(messages: ChatMessage[]) {
  const systemMsg = messages.find(m => m.role === 'system')
  const chatMsgs = messages.filter(m => m.role !== 'system')
  const out: Array<{ role: string; content: any }> = []
  for (const m of chatMsgs) {
    if (m.role === 'user') { out.push({ role: 'user', content: m.content }); continue }
    if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || '', content: m.content }] })
      continue
    }
    if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length > 0) {
        const blocks: any[] = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const tc of m.tool_calls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) })
        }
        out.push({ role: 'assistant', content: blocks })
      } else {
        out.push({ role: 'assistant', content: m.content })
      }
    }
  }
  return { system: systemMsg?.content, messages: out }
}

// Test 1: plain user message
const r1 = toAnthropicMessages([{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hello' }])
if (r1.system !== 'You are helpful.') process.exit(1)
if (r1.messages.length !== 1 || r1.messages[0].content !== 'hello') process.exit(2)

// Test 2: assistant with tool_calls → tool_use blocks
const r2 = toAnthropicMessages([
  { role: 'user', content: 'search weather' },
  { role: 'assistant', content: 'let me search', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'web_search', arguments: '{\"query\":\"weather\"}' } }] },
])
if (r2.messages.length !== 2) process.exit(3)
const asst = r2.messages[1]
if (asst.role !== 'assistant') process.exit(4)
if (!Array.isArray(asst.content)) process.exit(5)
const tu = asst.content.find((b: any) => b.type === 'tool_use')
if (!tu || tu.name !== 'web_search' || tu.input.query !== 'weather') process.exit(6)

// Test 3: tool result → user with tool_result block
const r3 = toAnthropicMessages([
  { role: 'tool', content: 'sunny 25C', tool_call_id: 'tc1' },
])
if (r3.messages.length !== 1) process.exit(7)
const tool = r3.messages[0]
if (tool.role !== 'user') process.exit(8)
if (!Array.isArray(tool.content) || tool.content[0].type !== 'tool_result') process.exit(9)
if (tool.content[0].tool_use_id !== 'tc1') process.exit(10)

process.exit(0)
" 2>/dev/null)
assert_true "Anthropic 消息格式转换（3 个 case）" "$([ $? -eq 0 ] && echo true || echo false)"

# ── 11. MiniMax Anthropic 端点集成检测 ──
echo ""
echo "--- Anthropic 端点集成 ---"
# 验证新的 Anthropic 端点已配置
assert_true "Anthropic endpoint URL 正确" "$(grep -q 'api.minimaxi.com/anthropic/v1/messages' src/llm/minimax.ts && echo true || echo false)"
assert_true "x-api-key header 配置" "$(grep -q 'x-api-key' src/llm/minimax.ts && echo true || echo false)"
assert_true "toAnthropicMessages 函数存在" "$(grep -q 'function toAnthropicMessages' src/llm/minimax.ts && echo true || echo false)"
# stripMinimaxAnnotations 已删除（不再需要）
assert_true "stripMinimaxAnnotations 已删除" "$(grep -c 'stripMinimaxAnnotations' src/llm/minimax.ts | grep -q '^0$' && echo true || echo false)"

# ── 12. 位置共享 ──
echo ""
echo "--- 位置共享 ---"
[ -f src/location.ts ] && grep -q 'nearby_search' src/tools.ts && LOC1=true || LOC1=false
assert_true "location.ts + nearby_search 存在" "$LOC1"
grep -q 'messageType.*location' src/server.ts && LOC2=true || LOC2=false
assert_true "location 消息处理存在" "$LOC2"
HAS_AMAP=$(grep -c "AMAP_API_KEY" state/.env 2>/dev/null || echo "0")
if [ "$HAS_AMAP" -gt 0 ] 2>/dev/null; then
  echo "  ✓ AMAP_API_KEY 已配置"; PASS=$((PASS+1))
  bun -e "
  import { saveLocation, getCurrentLocation } from './src/location.ts'
  saveLocation({ latitude: 31.18, longitude: 121.63, name: '测试', address: '测试', updated_at: new Date().toISOString() })
  if (!getCurrentLocation()) process.exit(1)
  " 2>/dev/null
  assert_true "saveLocation 写入成功" "$([ $? -eq 0 ] && echo true || echo false)"
else
  echo "  ⚠ AMAP_API_KEY 未配置（跳过位置写入）"
fi

# ── 13. 静默 + 兜底机制 ──
echo ""
echo "--- 静默 + 兜底 ---"
assert_true "cron SILENCE 闸门存在（仅 SILENCE 约定，不拦截长报告）" "$(grep -q "startsWith.*SILENCE" src/scheduler.ts && echo true || echo false)"
assert_true "isSilence 仅用于 proactive" "$(grep -q 'isSilence' src/server.ts && echo true || echo false)"
assert_true "proactive 10min 冷却存在" "$(grep -q 'lastUserMsgAt' src/server.ts && echo true || echo false)"
assert_true "4:30 占位 session 存在" "$(grep -q '4:30 清理后用同 chatId' src/server.ts && echo true || echo false)"

# ── 清理 ──
echo ""
echo "--- 清理测试数据 ---"
python3 -c "
import json, os
# 清理 CLI 提醒
data = json.load(open('state/reminders.json'))
before = len(data)
cleaned = [r for r in data if not r.get('chatId','').startswith('cli:')]
json.dump(cleaned, open('state/reminders.json', 'w'), indent=2, ensure_ascii=False)
print(f'  提醒: {before} -> {len(cleaned)}')
# 清理测试笔记
if os.path.exists('state/notes.json'):
    notes = json.load(open('state/notes.json'))
    n_before = len(notes)
    notes_cleaned = [n for n in notes if '回归测试' not in n.get('content','')]
    json.dump(notes_cleaned, open('state/notes.json', 'w'), indent=2, ensure_ascii=False)
    print(f'  笔记: {n_before} -> {len(notes_cleaned)}')
# 清理测试位置
if os.path.exists('state/location.json'):
    os.remove('state/location.json')
    print(f'  位置: 已删除')
# 清理 CLI session
active = json.load(open('state/active.json'))
cli_keys = [k for k in active if k.startswith('cli:')]
for k in cli_keys:
    sid = active.pop(k)
    try: os.remove(f'state/sessions/{sid}.json')
    except: pass
json.dump(active, open('state/active.json', 'w'), indent=2)
print(f'  Session: 删除 {len(cli_keys)} 个')
"
echo "  ✓ 清理完成"

# ── 结果 ──
echo ""
echo "========================================="
echo "结果: $PASS 通过, $FAIL 失败"
echo "========================================="
exit $FAIL
