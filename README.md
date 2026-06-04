# 共读室 coread

AI和人类一起读书，批注写在同一本书的页边。

导入一本epub，在分页阅读器里读，划线、写批注——你的AI同伴通过MCP工具做同样的事。两个人的声音并排留在书页的空白处。

[English](#english) | 中文

## 功能

- **Epub导入** — 自动识别章节、提取图片和封面
- **CSS分栏分页** — 自适应任何屏幕尺寸，手机到电脑都能用
- **共享批注** — 划线高亮、写评论、互相回复
- **共读状态** — 看到对方读到哪里，收到新批注通知
- **导出** — 把带批注的书导出为epub或markdown
- **MCP工具** — AI通过标准MCP协议读书和写批注
- **零外部依赖** — SQLite数据库，只要能跑Node.js的地方都能用

## 快速开始

```bash
git clone https://github.com/meowmana/coread.git
cd coread
npm install
npm run build   # 构建前端
npm start       # 启动服务器
```

浏览器打开 `http://localhost:3000`。

同时启动 Web 阅读器和远程 MCP：

```bash
npm run start:all
```

默认端点：

- Web 阅读器：`http://localhost:3000`
- MCP 健康检查：`http://localhost:3001/health`
- MCP SSE：`http://localhost:3001/sse`
- MCP Streamable HTTP：`http://localhost:3001/mcp`

### Coolify 部署

用同一个应用同时跑 Web 和 MCP：

```text
Build Command: npm ci && npm run build
Start Command: npm run start:all
Ports: 3000, 3001
```

环境变量：

```text
COREAD_PORT=3000
COREAD_MCP_PORT=3001
COREAD_DB=/app/data/coread.db
```

持久化存储：

```text
/app/data
```

域名建议：

```text
阅读器域名 -> 3000
MCP 域名 -> 3001
```

#### MCP 端点与健康检查

MCP 服务在 3001 端口暴露三个 HTTP 端点：

| 端点 | 用途 | Content-Type |
|------|------|--------------|
| `GET /health` | 健康检查 / 探活，返回 `{ ok, service, transport, time, db }` | `application/json` |
| `GET /sse` | SSE 传输，建立连接后返回 `/messages?sessionId=…` 端点 | `text/event-stream` |
| `POST /mcp` | Streamable HTTP 传输（无状态 JSON-RPC） | `application/json` |

部署后可先用 `/health` 确认服务起来了：

```bash
curl https://你的MCP域名/health
# {"ok":true,"service":"coread-mcp","transport":["sse","streamable-http"],...}
```

`/health` 只返回数据库文件名（basename）和 `db_configured`，不会泄露完整路径或任何 token / secret。

#### Cloudflare 注意事项

如果 MCP 域名挂在 Cloudflare 后面，**建议先把 MCP 子域设为 DNS only（灰云，不走橙色代理）**。

- Cloudflare 代理对 SSE 这类长连接 / 流式响应处理不一定友好，容易出现连接被提前关闭、`no active transport`、SSE 拉不通等问题。
- 先用 DNS only 把链路跑通、确认 Claude 远程 MCP 能稳定连上，再按需决定是否开代理。
- Web 阅读器域名（3000）正常走代理没问题，这条只针对 MCP 域名（3001）。

#### 连接排查建议

接入 Claude 远程 MCP 时，建议按由浅入深的顺序排查：

```
1. GET /health        → 确认服务存活、传输模式、DB 配置
2. tools/call ping     → 确认 MCP 链路通（区分“链路问题”和“业务工具问题”）
3. 再测业务工具         → get_chapters / read_range 等
```

`ping` 工具只返回 `{ ok, message, time }`，不碰数据库，是判断「是网络/传输挂了，还是某个业务工具挂了」的最快办法。

## MCP配置

### Claude Code（stdio）

在MCP配置里加：

```json
{
  "mcpServers": {
    "coread": {
      "command": "node",
      "args": ["/你的路径/coread/mcp-stdio.mjs"]
    }
  }
}
```

### claude.ai / 远程MCP（SSE + Streamable HTTP）

```bash
npm run mcp:sse   # 启动SSE/HTTP MCP服务器（默认端口3001）
```

健康检查：`http://你的服务器:3001/health`
SSE端点：`http://你的服务器:3001/sse`
Streamable HTTP端点：`http://你的服务器:3001/mcp`

环境变量 `COREAD_MCP_PORT` 可以改端口。

在claude.ai设置里添加为远程MCP服务器即可。支持SSE和Streamable HTTP两种传输模式。接好后建议先调用 `ping` 工具确认链路，再调用业务工具。

### 其他MCP客户端

任何支持MCP的客户端都能用——不限于Claude。GPT、DeepSeek、Gemini，支持MCP的都行。三种传输模式可选：stdio、SSE、Streamable HTTP。

## MCP工具列表

| 工具 | 说明 |
|------|------|
| `list_books` | 列出书架上所有的书 |
| `read_book` | 读某一页（带批注） |
| `add_comment` | 在某段写批注 |
| `list_comments` | 列出一本书的所有批注 |
| `get_toc` | 获取目录 |
| `import_book` | 导入文本或epub |
| `delete_comment` | 删除批注 |
| `update_progress` | 更新阅读进度 |
| `get_chapters` | 获取章节列表及段落范围（省 token 共读用） |
| `read_range` | 按段落范围读取原文，`max_chars` 控制用量，支持超长段落续读 |
| `reading_note` | 读书笔记：`get` / `update` / `append`，用于共读上下文恢复 |
| `ping` | 最小连通性检查，返回 `{ ok, message, time }`，用于区分链路问题和业务工具问题 |

## 省 token 共读推荐流程

AI 进行共读时建议按以下顺序调用工具，避免不必要的 token 消耗：

```
1. list_books
   → 确认书名和 book_id

2. get_chapters
   → 获得章节列表（title / start_idx / end_idx / page）
   → 选定本次要读的章节范围

3. read_range(book_id, start_idx, end_idx, max_chars=8000)
   → 按段落范围读取，max_chars 防止单次过长
   → 若 truncated=true，用 next_start_idx 继续下一次调用
   → 若 partial_paragraph=true（单段超长），用 start_offset=partial_next_offset 续读同一段

4. add_comment / reading_note append
   → 边读边批注或记录共读笔记

5. reading_note update/append
   → 每章读完后更新笔记，下次共读可先 get 恢复上下文
   → 无需重读原文
```

**注意**：`import_book` 的 `data` 参数接受 base64 epub，仅用于导入，**不建议** AI 在对话中传递整本 epub 的 base64 内容，那会消耗大量上下文 token。导入请在终端或前端操作。

## 配置项

环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `COREAD_PORT` | `3000` | Web服务器端口 |
| `COREAD_MCP_PORT` | `3001` | MCP SSE/HTTP服务器端口 |
| `COREAD_DB` | `./data/coread.db` | 数据库路径 |

## 开发

```bash
npm run dev     # Vite开发服务器（API代理到localhost:3000）
npm start       # 生产模式（提供构建好的前端）
```

## 项目结构

```
server.mjs        — HTTP服务器：API + 静态文件
mcp-stdio.mjs     — MCP服务器（stdio传输）
mcp-sse.mjs       — MCP服务器（SSE + Streamable HTTP传输）
lib/
  db.mjs           — SQLite数据库初始化
  epub.mjs         — Epub解析器（章节、图片、封面）
  routes.mjs       — 书籍API路由
web/
  StudyApp.tsx     — React前端（分页阅读器 + 批注）
  api.ts           — API客户端
  app.tsx          — 入口
public/            — 构建产物（vite build生成）
data/              — SQLite数据库 + 书籍图片（gitignore）
```

---

<a name="english"></a>

## English

A co-reading room where AI and humans read books together, leaving annotations side by side.

Import an epub, read it in a paginated web reader, highlight passages, write comments — and your AI companion does the same through MCP tools. Both voices live in the margins of the same book.

### Quick Start

```bash
git clone https://github.com/meowmana/coread.git
cd coread
npm install
npm run build
npm start
```

Open `http://localhost:3000` in your browser.

### MCP Setup

**Claude Code (stdio):**

```json
{
  "mcpServers": {
    "coread": {
      "command": "node",
      "args": ["/path/to/coread/mcp-stdio.mjs"]
    }
  }
}
```

**claude.ai / Remote MCP (SSE + Streamable HTTP):**

```bash
npm run mcp:sse   # Starts SSE/HTTP MCP server on port 3001
```

- Health check: `http://your-server:3001/health`
- SSE endpoint: `http://your-server:3001/sse`
- Streamable HTTP endpoint: `http://your-server:3001/mcp`

Works with any MCP-compatible client — not limited to Claude. Three transport modes: stdio, SSE, Streamable HTTP.

**Deploying behind Cloudflare:** set the MCP subdomain to **DNS only** (grey cloud) first — the proxy can interfere with SSE long-lived streams. Verify the link with `GET /health` and the `ping` tool before testing business tools.

## Coolify (Docker Compose) deployment

The repository ships a `docker-compose.yml` that runs the same image as **two**
services from one codebase:

| Service       | Command            | Port | Purpose               |
| ------------- | ------------------ | ---- | --------------------- |
| `coread-web`  | `node server.mjs`  | 3000 | Web UI + API          |
| `coread-mcp`  | `node mcp-sse.mjs` | 3001 | Remote MCP (SSE/HTTP) |

Both services mount the same `coread-data` volume at **`/app/data`** and point
`COREAD_DB` at `/app/data/coread.db`, so the web app and the MCP server share a
single SQLite database.

### Steps in Coolify

1. Create a new resource from this Git repository.
2. **Build Pack:** choose **Docker Compose**.
3. **Compose Location:** `docker-compose.yml`.
4. Set up domains (no fixed host ports are bound, so there are no port clashes):
   - Bind the web domain to **`coread-web:3000`**, e.g. `https://read.yuan-own-server.uk`
   - Bind the MCP domain to **`coread-mcp:3001`**, e.g. `https://readmcp.yuan-own-server.uk`
5. Make sure the persistent volume **`/app/data`** is kept across deploys — it
   holds `coread.db`.

> Tip: for the MCP subdomain behind Cloudflare, set DNS to **DNS only** (grey
> cloud) as noted above, then verify with `GET /health`.

## License

MIT
