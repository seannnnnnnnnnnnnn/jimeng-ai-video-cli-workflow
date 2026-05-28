# 即梦AI视频CLI工作流

把即梦 CLI 从命令行工具变成一条可视化 AI 视频生产线。

`即梦AI视频CLI工作流` 是一个 Electron 桌面应用，面向短视频、AI 漫剧和批量分镜创作场景。它把 OpenAI 兼容 LLM、即梦官方 `dreamina` CLI、本地多账号积分调度、图片审核重生成、图生视频和轻量剪辑串成一套桌面工作流。

> 非官方项目：本项目不是即梦、剪映、字节跳动的官方产品。使用前请自行安装并登录即梦官方 `dreamina` CLI，遵守相关平台条款和素材版权要求。

## 一句话定位

**让创作者用一个桌面应用完成“故事想法 → 分镜脚本 → 分镜图 → 图生视频 → 初剪导出”的完整 AI 视频流水线。**

## 适合谁

- AI 漫剧、短剧、分镜视频创作者
- 批量测试即梦图片/视频提示词的内容团队
- 已经在使用 `dreamina` CLI，但希望减少命令行切换、账号切换和文件整理成本的用户
- 想把 LLM 分镜和即梦生成串成半自动生产流程的开发者

## 核心功能

- **LLM 分镜生成**：输入故事主题，自动拆成多镜头分镜，生成图片提示词和视频运动提示词。
- **即梦 CLI 自动化**：调用本地 `dreamina` CLI 执行文生图、图生视频、结果查询和素材下载。
- **图片审核模块**：图片生成后不会直接进入视频阶段；可查看大图、编辑每个分镜的图片提示词并二次生成。
- **导演模式**：对已有项目的单个分镜重新生成图片或视频，并自动保留历史备份。
- **本地多账号 CLI Router**：每个即梦账号只需登录一次，应用内切换账号、刷新积分，并可自动选择有积分账号。
- **项目库**：保存每次创作的项目元数据、输出目录、分镜状态和生成参数。
- **轻量剪辑器**：导入生成视频或本地素材，进行简单时间线排列、裁剪、转场和 MP4 导出。
- **跨平台打包**：基于 Electron，支持 macOS / Windows 打包。

## 工作流

```mermaid
flowchart LR
  A["故事/主题输入"] --> B["LLM 生成分镜"]
  B --> C["即梦 CLI 文生图"]
  C --> D["图片审核与二次生成"]
  D --> E["确认后图生视频"]
  E --> F["项目库 / 导演模式"]
  F --> G["剪辑与导出"]
  H["多账号 CLI Router"] --> C
  H --> E
```

## 展示建议

开源仓库建议在 `docs/assets/` 放 3-5 张截图：

- 工作流首页：故事输入、分镜数量、生成参数
- 图片审核模块：大图预览、提示词编辑、重新生成
- 多账号管理：账号切换、积分刷新、自动选择可用账号
- 导演模式：单镜头图片/视频重生成
- 剪辑器：素材区、预览区、时间线、导出弹窗

截图命名可参考：

```text
docs/assets/workflow.png
docs/assets/image-review.png
docs/assets/account-router.png
docs/assets/director-mode.png
docs/assets/editor.png
```

## 安装和运行

### 1. 安装依赖

```bash
npm install
```

### 2. 安装即梦 CLI

请按即梦官方方式安装 `dreamina` CLI，并确保命令可用：

```bash
dreamina --version
dreamina user_credit
```

默认路径会优先查找：

```text
~/.local/bin/dreamina
/usr/local/bin/dreamina
/opt/homebrew/bin/dreamina
```

### 3. 启动开发版

```bash
npm run dev
```

### 4. 配置 LLM

进入应用的“设置”页，填写 OpenAI 兼容接口：

- Base URL，例如 `https://api.openai.com/v1`
- API Key
- Model，例如 `gpt-4o` 或其他兼容模型

API Key 保存在本机 Electron 用户数据目录，不应提交到仓库。

## 打包

仅构建前端：

```bash
npm run build:web
```

macOS 打包：

```bash
npm run pack:mac
```

Windows 打包：

```bash
npm run pack:win
```

构建产物位于 `dist-electron/`。安装包体积较大，建议通过 GitHub Releases 分发，不要提交到 git。

## 多账号 CLI Router 说明

即梦 CLI 的登录态涉及本地文件和 macOS Keychain。为了避免账号串号：

- 默认账号使用当前系统真实 HOME。
- 新增账号使用独立 HOME 和独立 keychain 数据库。
- 应用内所有生成任务都通过 Router 获取当前账号环境。
- 账号积分不足时，可以刷新全部积分并自动选择可用账号。

历史上通过复制 `~/.dreamina_cli` 得到的账号并不可靠，建议在账号管理中重新登录每个账号。

## 开源风险说明

提交到 GitHub 前请确认：

- 不提交 `node_modules/`
- 不提交 `dist/`、`dist-electron/`、`package_build/`
- 不提交 `.exe`、`.dmg`、`.blockmap` 等安装包
- 不提交 API Key、账号登录态、Keychain、`~/.dreamina_cli` 或 `~/.jimeng-accounts`
- 不使用官方 logo 或让用户误以为这是官方客户端
- 生成内容、提示词和素材版权由使用者自行负责

## 技术栈

- Electron
- Vite
- 原生 JavaScript / HTML / CSS
- `dreamina` CLI
- OpenAI 兼容 Chat Completions 接口
- FFmpeg / ffprobe，用于剪辑导出和素材信息读取

## 项目结构

```text
.
├── electron/              # Electron 主进程与业务模块
│   ├── main.js            # IPC、窗口、工作流入口
│   ├── account-router.js  # 本地多账号 CLI Router
│   ├── workflow.js        # 分镜 -> 图片 -> 视频编排
│   ├── jimeng-runner.js   # dreamina CLI 封装
│   ├── director.js        # 单镜头重生成和备份
│   └── editor-exporter.js # FFmpeg 导出
├── src/                   # 渲染进程 UI
│   ├── index.html
│   ├── main.js
│   ├── editor.js
│   └── styles/
├── docs/                  # 项目文档和展示素材
├── package.json
└── vite.config.js
```

## License

MIT
