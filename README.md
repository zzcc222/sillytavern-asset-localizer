# 🖼️ SillyTavern 图池本地化管家 (ST-Asset-Localizer)

[![SillyTavern](https://img.shields.io/badge/SillyTavern-%3E%3D1.12.0-blue?style=flat-square)](https://github.com/SillyTavern/SillyTavern)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0-green?style=flat-square)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/Version-2.1.0-emerald?style=flat-square)](https://github.com/zzcc222/sillytavern-asset-localizer)

**SillyTavern 图池本地化管家** 是一款专为解决酒馆角色卡远程图池网络卡顿、必须开梯子、多设备重复下载而设计的**全平台无缝插件与扩展**。

它能智能解析角色卡内的外链（GitHub Raw、Catbox 图床、动态 baseUrl 宏与立绘变量），并将图片高速持久化到酒馆服务器本地；无论您使用手机、平板还是电脑访问，立绘均由酒馆主机直接极速加载，**彻底告别网络梯子依赖**！

---

## ✨ 核心特性

- ⚡ **纯本地加速，多端免梯秒开**：
  - 数据统一存放于酒馆主机 (`data/shared_card_assets/`)。
  - 一台设备本地化，手机、平板、网页端全部受益，无需重复下载，不浪费客户端流量与储存空间。
- 🔍 **全架构图池深度解析**：
  - 支持 `charactersData`（多立绘变量：`sfwBase`、`nsfwBase`、`pregBase`、表情分类组合）。
  - 支持 `baseUrlMap` 动态宏映射图池。
  - 支持 Catbox 图床直链与哈希命名图池。
  - 支持 GitHub Raw commit hash 与 Releases 直链。
- 📁 **全角色卡专属【图池资产】面板**：
  - 每张卡片均拥有独立的资产控制面板，清晰掌握本地服务接口、本地存储目录、立绘总张数与磁盘占用大小。
  - 内置立绘文件清单浏览器，支持实时关键字搜索（如 `calm`, `naked`, `uniform` 等），方便快速查阅与复制本地调用路由。
- 🧹 **无主孤儿图清理**：
  - 自动扫描清理因角色卡已被删除而遗留在硬盘上的无用立绘文件夹，释放宝贵磁盘空间。
- 🌐 **跨平台原生 Express 静态路由**：
  - 自带 Express 静态路由分发 (`/api/plugins/st-asset-localizer/assets/...`)。
  - 完美兼容 Windows、Linux、macOS 与 Docker，无需额外配置 Nginx 或本地网页服务器。

---

## 📸 界面预览

### 1. 主控制面板
清晰展示所有角色卡的本地化状态、调用统计、磁盘占用与立绘张数，支持模糊搜索与状态筛选。

![主列表](https://raw.githubusercontent.com/zzcc222/sillytavern-asset-localizer/main/docs/st_localizer_2_1_main.png)

### 2. 图池资产详情
每一张角色卡均可打开专属资产弹窗，查看本地服务状态、存储健康度以及完整的立绘文件清单。

![图池资产详情](https://raw.githubusercontent.com/zzcc222/sillytavern-asset-localizer/main/docs/st_card_assets_modal.png)

---

## 🚀 快速安装

### 推荐：一键安装（适用于 Linux / macOS / Docker）

在您的 SillyTavern 根目录下执行：

```bash
git clone https://github.com/zzcc222/sillytavern-asset-localizer.git plugins/st-asset-localizer
cp -rf plugins/st-asset-localizer/client data/default-user/extensions/st-asset-localizer
```

或者使用内置安装脚本：
```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/zzcc222/sillytavern-asset-localizer/main/install.sh)"
```

### Windows 系统一键安装

1. 进入您的 SillyTavern 根目录；
2. 执行以下命令：
```cmd
git clone https://github.com/zzcc222/sillytavern-asset-localizer.git plugins\st-asset-localizer
xcopy /Y /E "plugins\st-asset-localizer\client\*" "data\default-user\extensions\st-asset-localizer\"
```
3. 重启 SillyTavern。

> 💡 **提示**：本插件已内置自同步逻辑，启动服务端时会自动检测并同步前端扩展文件。

---

## 🛠️ 项目目录结构

```text
sillytavern-asset-localizer/
├── index.js               # 服务端插件入口 (Express 路由与扩展自动就绪)
├── package.json           # 插件规范与版本定义
├── install.sh             # Linux / Docker 一键安装脚本
├── install.bat            # Windows 一键安装脚本
├── src/
│   ├── api.js             # REST API 与原生 Express 静态立绘分发
│   ├── constants.js       # 多平台路径解析与文件名 Windows 安全转义
│   ├── downloader.js      # 多线程高并发断点下载器 (带镜像加速与 Magic Byte 校验)
│   ├── localizer.js       # 核心本地化引擎与孤儿清理器
│   ├── png-parser.js      # 低层 PNG Text Chunk 无损编解码器
│   └── scanner.js         # 角色卡元数据递归扫描与图源提取器
├── client/                # 前端交互扩展 (SillyTavern UI Extension)
│   ├── index.js           # 前端业务逻辑、事件响应与模态框渲染
│   ├── manifest.json      # 酒馆扩展清单
│   └── style.css          # 现代化深色主题样式表
└── docs/                  # 预览截图与使用文档
```

---

## ⚙️ 常见问题 (FAQ)

### Q1: 图片下载后保存在哪里？
所有立绘文件统一存放在 SillyTavern 根目录下的 `data/shared_card_assets/<安全卡名>/` 中。

### Q2: 为什么部分纯文字卡片显示立绘为 0？
如果卡片本身没有立绘图池或外链，插件会识别为无外部资源卡，无需执行本地化。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。欢迎提交 Issue 与 Pull Request！
