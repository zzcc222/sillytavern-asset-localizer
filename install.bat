@echo off
chcp 65001 >nul
echo ======================================================
echo    SillyTavern 图池本地化管家 (ST-Asset-Localizer) 安装
echo ======================================================

if not exist "server.js" if not exist "plugins" (
    echo ❌ 错误: 请将此脚本放置于 SillyTavern 根目录运行！
    pause
    exit /b 1
)

set PLUGIN_DIR=plugins\st-asset-localizer
set EXT_DIR=data\default-user\extensions\st-asset-localizer

echo 📦 1. 正在获取最新服务端插件...
if exist "%PLUGIN_DIR%" (
    cd "%PLUGIN_DIR%"
    git pull
    cd ..\..
) else (
    git clone https://github.com/zzcc222/sillytavern-asset-localizer.git "%PLUGIN_DIR%"
)

echo 🎨 2. 正在部署前端扩展到 %EXT_DIR%...
if not exist "%EXT_DIR%" mkdir "%EXT_DIR%"
xcopy /Y /E "%PLUGIN_DIR%\client\*" "%EXT_DIR%\" >nul

echo 💾 3. 正在初始化存储目录...
if not exist "data\shared_card_assets" mkdir "data\shared_card_assets"

echo.
echo ✅ 安装完成！请重启酒馆即可畅享无梯秒开图池。
pause