#!/bin/bash
set -e

echo "======================================================"
echo "   SillyTavern 图池本地化管家 (ST-Asset-Localizer) 安装"
echo "======================================================"

if [ ! -d "plugins" ] && [ ! -f "server.js" ]; then
    echo "❌ 错误: 请进入 SillyTavern 根目录后执行此脚本！"
    exit 1
fi

PLUGIN_DIR="plugins/st-asset-localizer"
EXT_DIR="data/default-user/extensions/st-asset-localizer"

echo "📦 1. 安装/更新服务端插件..."
if [ -d "$PLUGIN_DIR" ]; then
    echo "发现已有插件，正在拉取最新代码..."
    (cd "$PLUGIN_DIR" && git pull)
else
    git clone https://github.com/zzcc222/sillytavern-asset-localizer.git "$PLUGIN_DIR"
fi

echo "🎨 2. 部署前端交互扩展..."
mkdir -p "$EXT_DIR"
cp -rf "$PLUGIN_DIR/client/"* "$EXT_DIR/"

echo "💾 3. 确保本地立绘存储目录就绪..."
mkdir -p "data/shared_card_assets"

echo ""
echo "✅ 安装成功！请重启 SillyTavern 容器或服务进程后即可使用。"