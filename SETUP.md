# Lomo 冷启动指南

从零开始部署 Lomo 飞书个人助手。

## 前置条件

- **Bun** >= 1.0（`curl -fsSL https://bun.sh/install | bash`）
- **Python 3** + **pip**（米家脚本依赖）
- **ffmpeg**（语音转码：`apt install ffmpeg` / `brew install ffmpeg`）
- **飞书开发者账号**（用于创建 Bot）

## 第一步：创建飞书应用

1. 打开 [飞书开发者后台](https://open.feishu.cn/app)
2. 创建「企业自建应用」
3. 记下 **App ID** 和 **App Secret**
4. 添加能力 → **机器人**
5. 权限管理 → 开通以下权限：
   - `im:message` — 获取与发送消息
   - `im:message:send_as_bot` — 以 Bot 身份发消息
   - `im:resource` — 获取消息中的资源文件
6. 事件订阅 → 请求地址：`WebSocket` 模式（无需填 URL）
7. 订阅事件：`im.message.receive_v1`
8. 版本管理 → 发布版本

## 第二步：获取 API Keys

### 必需

| 服务 | 用途 | 获取方式 |
|------|------|----------|
| 飞书 App | 消息收发 | 上一步创建 |
| MiniMax | 对话/搜索/生图/识图 | [MiniMax 开放平台](https://platform.minimaxi.com/) → Token Plan |
| DeepSeek | 对话（备用） | [DeepSeek Platform](https://platform.deepseek.com/) |

### 可选

| 服务 | 用途 | 获取方式 |
|------|------|----------|
| Agnes AI | 多模态对话 + 生图 + 生视频 | [Sapiens AI](https://sapiens-ai.ai) |
| MiMo | TTS 语音输出 | [MiMo Token Plan](https://token-plan.xiaomimimo.com/) |
| 豆包 | ASR 语音转写 | [火山引擎](https://console.volcengine.com/) → 豆包 |
| Claude | 对话（Anthropic API） | [Anthropic Console](https://console.anthropic.com/) |
| 高德地图 | 周边 POI 搜索 | [高德开放平台](https://lbs.amap.com/) → Web 服务 Key |

## 第三步：安装与配置

```bash
# 克隆项目
git clone <your-repo-url> Lomo
cd Lomo

# 安装依赖
bun install

# 配置环境变量
cp state/.env.example state/.env
```

编辑 `state/.env`，填入你的 API Keys：

```env
# 飞书 App
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx

# LLM（至少配一个，默认 MiniMax M3）
MINIMAX_API_KEY=sk-cp-xxxxxxxxxxxx
DEEPSEEK_API_KEY=sk-xxxxxxxx

# 可选：Agnes / Claude
AGNES_API_KEY=sk-xxxxxxxx
# ANTHROPIC_API_KEY=sk-ant-xxxxxxxx

# 可选：语音
MIMO_API_KEY=tp-xxxxxxxx
DOUBAO_API_KEY=ark-xxxxxxxx

# 可选：地图
AMAP_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 服务器
CHAT_AGENT_PORT=18895
CRON_TOKEN=change-me-to-a-long-random-string
```

## 第四步：米家智能家居（可选）

如果需要控制米家设备：

```bash
# 安装 Python 依赖
cd scripts
python3 -m venv venv
source venv/bin/activate
pip install mijiaAPI
deactivate
cd ..

# 扫码登录米家账号
./scripts/venv/bin/python3 scripts/mijia.py login
```

登录后 token 缓存在 `~/.lomo-mijia/token.json`，无需重复登录。

## 第五步：启动

```bash
# 开发模式（自动重载）
bun run dev

# 生产模式
bun run start

# 或直接
bun run src/server.ts
```

启动后：
- 飞书 WebSocket 自动连接
- HTTP 服务监听 `127.0.0.1:18895`
- 管理后台：http://127.0.0.1:18895/admin

## 第六步：测试

```bash
# CLI 测试（另开终端）
./cli.sh "你好"

# 交互模式
./cli.sh

# 回归测试（自动清理测试数据）
./test.sh
```

## 第七步：部署到服务器

### systemd 服务

```bash
# 上传代码到服务器
scp -r ./ user@your-server:~/lomo/

# SSH 到服务器
ssh user@your-server

# 安装依赖
cd ~/lomo && bun install

# 配置 .env
cp state/.env.example state/.env
nano state/.env  # 填入 API Keys

# 创建 systemd 服务
sudo tee /etc/systemd/system/lomo.service << 'EOF'
[Unit]
Description=Lomo Feishu Bot
After=network.target

[Service]
Type=simple
User=user
WorkingDirectory=/home/user/lomo
ExecStart=/home/user/.bun/bin/bun run src/server.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# 启动
sudo systemctl daemon-reload
sudo systemctl enable lomo
sudo systemctl start lomo

# 查看状态
sudo systemctl status lomo

# 查看日志
journalctl -u lomo -f
```

### 注意事项

- 本地和服务器**不能同时运行**，会抢飞书 WebSocket 连接
- 服务器重启后 systemd 自动拉起
- 日志通过 journalctl 查看

## 自定义角色

编辑 `src/presets.ts` 修改 Lomo 的人设：

```typescript
export const PRESETS: CharacterPreset[] = [
  {
    id: 'lomo',
    name: 'Lomo',
    persona: `你是 Lomo，一个运行在飞书上的 AI 个人助手...`,
    scene: `你是一个运行在服务器上的智能助手...`,
    voice: 'mimo_default',      // TTS 音色
    voiceStyle: 'gentle', // 默认情感
  },
]
```

## 添加定时任务

启动后，对 Lomo 说：

- "每天早上 8 点给我发天气预报" → 自动创建 cron 任务
- "工作日 9 点提醒我打卡" → 自动创建 cron 任务
- "/task" → 查看所有定时任务
- "/task off <id>" → 删除任务

也可以手动编辑 `state/reminders.json`。

## 故障排查

| 问题 | 排查 |
|------|------|
| 飞书收不到消息 | 检查 App ID/Secret，确认事件订阅已配置 |
| LLM 返回错误 | 检查 API Key，`/model dsf` 切换模型试试 |
| TTS 无声 | 检查 MIMO_API_KEY，确认 ffmpeg 已安装 |
| 搜索不可用 | 检查 MINIMAX_API_KEY |
| 米家控制失败 | 重新登录：`./scripts/venv/bin/python3 scripts/mijia.py login` |
| 端口被占 | `lsof -ti :18895` 查看占用进程 |

## 数据目录

```
state/
├── .env                 — 环境变量（API Keys）
├── active.json          — 活跃会话映射
├── sessions/            — Session JSON 文件
├── memory/
│   └── lomo/
│       ├── memory.json  — 记忆条目
│       ├── profile.json — Core Profile
│       ├── diary.md     — 日记
│       └── raw/         — L0 原始对话归档
├── reminders.json       — 提醒/定时任务
├── notes.json           — 随手记
├── proactive.json       — 主动消息状态
├── tts.json             — TTS 开关状态
├── location.json        — 位置缓存（2h TTL）
├── llm-logs.jsonl       — LLM 调用日志
└── inbox/               — 临时文件（语音/图片）
```
