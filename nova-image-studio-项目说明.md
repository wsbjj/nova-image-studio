# Nova Image Studio 项目说明

> 生成日期：2026-08-17
>
> 本文档根据本机 `C:\Users\28010\Desktop\nova-image-studio` 的 `dev` 分支源码、README、Compose 文件和前后端清单整理。它是独立项目说明，不覆盖仓库原有 `README.md`。

## 1. 项目定位

Nova Image Studio（Nova Image）是一个自托管 AI 图像生成工作台，面向个人或团队使用。前端负责工作台、模型设置、Agent、无限画布和素材管理；后端使用 Node.js 服务统一处理任务队列、SQLite 持久化、WebSocket 状态推送和图像 API 代理。

当前 `dev` 分支在原有能力上增加了 Nacos 远程模型配置、流式 ZIP64 大备份、Docker 开发预览和局域网 HTTPS 部署链路。

## 2. 项目快照

| 项目项 | 当前值 |
| --- | --- |
| 本地路径 | `C:\Users\28010\Desktop\nova-image-studio` |
| Git 分支 | `dev` |
| 生成文档时的 HEAD | `de7ff24f0da67aff06c8a42f2016a06d33f003a9` |
| 远程仓库 | `https://github.com/wsbjj/nova-image-studio.git` |
| 上游仓库 | `https://github.com/tianjiangqiji/nova-image-studio.git` |
| 包版本 | `package.json` 为 `3.1.3`；README 徽章仍标记 `v3.1.2` |
| 生成前工作区 | 存在画布 mention 编辑器修改及其新增测试文件 |

版本徽章与 `package.json` 不一致，发布前应统一版本来源。

## 3. 核心能力

### 工作模式

- 文本生图：纯提示词生成图片，支持并行任务。
- 图生图：上传参考图进行编辑、转换或风格化。
- Agent 智能体：通过对话完成方案、联网搜索、推理和出图。
- 反推提示词：上传图片并调用文字模型生成提示词。
- GIF 生成：多帧生图后在浏览器端编码 GIF。

同时提供提示词广场、模型注册表、无限画布、素材管理、任务队列和 PWA 能力。

### `dev` 分支增强

| 方向 | 当前实现 | 作用 |
| --- | --- | --- |
| Nacos 远程模型配置 | 后端代理读取 Nacos 3.x Client/Admin OpenAPI | 集中维护图片模型、文字模型和默认模型 |
| 大体积备份 | 流式 ZIP/ZIP64 写入和中央目录读取 | 降低内存峰值，支持超过 4 GB 的完整归档 |
| 备份交互性能 | IndexedDB、localforage 分批处理并报告进度 | 大量图片和画布素材导出时减少页面卡顿 |
| Docker 开发预览 | `Dockerfile.dev` + `docker-compose.dev.yml` | 容器内提供源码挂载、依赖隔离和 HMR |
| 当前源码部署 | `docker-compose.prod.yml` + Caddy 内部 CA | 在局域网通过 HTTPS 使用 PWA 和剪贴板能力 |

Nacos 远程下发是「拉取」：浏览器通过后端代理获取模型注册表并保存到本地，不会把本地配置反向发布到 Nacos，也不会同步任务历史、图片或画布数据。

## 4. 架构与数据边界

```text
浏览器 / PWA
  ├─ localStorage：模型注册表、默认模型和界面设置
  ├─ IndexedDB / localforage：任务、素材、画布和本地备份数据
  └─ HTTP + WebSocket
          |
          v
Node.js backend/server.js
  ├─ 静态文件与 Next 导出产物
  ├─ 图像 / 文字 API 代理
  ├─ 内存任务队列与限流
  ├─ WebSocket 状态推送
  └─ SQLite + backend/data/ 产物目录
          |
          +--> 上游图像 / 文字模型
          +--> Nacos 模型注册表（只读拉取）
```

浏览器中的模型配置可能包含 API Key。Nacos Namespace / Group 应限制读取权限，公网访问时使用 HTTPS，不要把真实配置或密钥提交到仓库。

## 5. 目录结构

```text
frontend/
  src/app/             # 页面与路由
  src/components/      # 生图、Agent、画布、设置、备份等组件
  src/lib/             # 模型、任务、WebSocket、ZIP64、Nacos 客户端
backend/
  server.js            # HTTP、WebSocket、SQLite、队列和上游代理
  prompts.json         # 提示词广场内容
  blacklist.json       # 敏感词过滤清单
  package.json         # better-sqlite3、undici、ws
data/                  # Docker 持久化数据目录
doc/                   # UI 截图与功能素材
docker-compose.dev.yml # Docker 开发预览
docker-compose.prod.yml# 当前 dev 源码生产部署
Caddyfile              # 局域网 HTTPS 反向代理
```

## 6. 本地运行

### npm 开发模式

```powershell
cd C:\Users\28010\Desktop\nova-image-studio
npm install
npm run install:all
Copy-Item backend\.env.example backend\.env
# 确认 backend/.env 中的 NOVA_TASK_DB 和 NOVA_IMAGE_DIR 指向 ./data/...
npm run dev
```

`npm run dev` 会先构建前端，再以生产模式启动 `backend/server.js`。需要前端 HMR 时可拆开运行：

```powershell
npm run dev:frontend
npm run dev:backend
```

首次启动后，在设置页至少配置一个图片模型、一个文字模型，并为任务类型设置默认模型。

### Docker 开发预览

```powershell
cd C:\Users\28010\Desktop\nova-image-studio
docker compose -f docker-compose.dev.yml up --build
```

该模式使用源码 bind mount，并将前后端依赖放在独立 volume。停止时执行：

```powershell
docker compose -f docker-compose.dev.yml down
```

## 7. 部署方式

### 当前 `dev` 源码部署

```powershell
cd C:\Users\28010\Desktop\nova-image-studio
Copy-Item deploy.env .env
# 按部署机器修改 .env
docker compose -f docker-compose.prod.yml up -d --build nova-image-studio
```

应用默认监听 `3000`。需要局域网 HTTPS 时，先把 `Caddyfile` 中的主机地址改为实际服务器地址，再启动完整 Compose 服务：

```powershell
docker compose -f docker-compose.prod.yml up -d --build
```

升级时只重建应用容器即可：

```powershell
docker compose -f docker-compose.prod.yml build nova-image-studio
docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate nova-image-studio
```

不要使用 `down -v` 删除数据卷；`./data` 中的 SQLite、WAL/SHM 和图片目录属于持久化数据。

## 8. 关键接口与配置

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/api/nova/tasks` | 创建图像任务，返回任务 ID |
| `GET` | `/api/nova/tasks/:id` | 查询任务状态和结果 |
| `POST` | `/api/nova/tasks/:id/ack` | 延长任务 TTL |
| `GET` | `/api/nova/queue-status` | 查询并发、排队和接单状态 |
| `POST` | `/api/nova/remote-config/nacos/fetch` | 通过后端代理获取并校验 Nacos 模型配置 |
| `GET` | `/api/nova/images/:taskId/:index` | 获取任务产物图片 |
| `WS` | `/api/nova/ws` | 实时订阅任务和队列状态 |

运行时配置分两类：Docker 使用项目根目录 `.env`，本地 npm 使用 `backend/.env`。重点变量包括 `PORT`、`HOSTNAME`、`NODE_ENV`、`NOVA_TASK_DB`、`NOVA_IMAGE_DIR`、并发/限流参数和 `PROMPT_GALLERY_MODE`。`NODE_ENV`、端口、数据库和图片目录属于启动级配置，修改后需要重启。

## 9. 备份与恢复

完整备份会覆盖浏览器的 localStorage、IndexedDB、localforage 和相关二进制素材。当前 `dev` 分支使用流式 ZIP64 导出，并按中央目录读取归档，兼容旧版 JSZip 备份和超过 4 GB 的归档。

服务端数据仍需单独保留：

- `backend/data/nova-tasks.sqlite`（包括可能存在的 WAL/SHM 文件）。
- `backend/data/nova-images/` 或 Docker 宿主机挂载的 `./data/nova-images/`。
- `backend/prompts.json` 和 `backend/blacklist.json`（如果有定制内容）。

## 10. 测试与维护

前端测试和静态检查可运行：

```powershell
npm run test:run
npm run lint
npm run build
```

生成本文档时未重新执行完整测试；仓库已有未提交的画布 mention 修改和测试文件，发布前应先查看 `git diff`，再按目标部署方式做构建、健康检查和 WebSocket 验收。

## 11. 运行风险

- 模型 API Key 由浏览器配置和任务请求携带，必须通过 HTTPS、访问控制和最小权限保护。
- Caddy 内部 CA 只在客户端安装了对应根证书时可信，不能把 `root.key` 分发给终端用户。
- 生产部署需要保证 `better-sqlite3` 在目标平台本地安装或在目标平台构建，不能直接复用其他系统的 `node_modules`。
- Docker、SQLite 数据目录和 Caddy 容器应保持隔离；升级只替换应用容器，保留 `./data`。

