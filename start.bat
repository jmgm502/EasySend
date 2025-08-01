@echo off
chcp 65001 >nul
echo.
echo ==========================================
echo           轻松互传 - 文件传输系统
echo ==========================================
echo.
echo 正在启动轻松传文件传输服务器...
echo.

REM 停止可能运行的Python服务器
taskkill /f /im python.exe >nul 2>&1

REM 检查Node.js是否安装
node --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到Node.js，请先安装Node.js
    echo 下载地址: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM 检查依赖是否安装
if not exist "node_modules" (
    echo [信息] 正在安装依赖包...
    npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络连接
        pause
        exit /b 1
    )
    echo [成功] 依赖包安装完成
    echo.
)

REM 启动服务器
echo [启动] 服务器启动中...
echo [地址] http://localhost:3000
echo [提示] 按 Ctrl+C 停止服务器
echo [功能] 支持发送方关闭传送、断开所有传送、接收方关闭传送
echo [快捷键] Ctrl+Shift+C 打开传输控制面板
echo.
echo ==========================================
echo.
node server.js

echo.
echo [信息] 服务器已停止运行
pause