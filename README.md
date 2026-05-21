# MacMirror

MacMirror 是一个轻量的本地 macOS 投屏和控制工具。你只需要在 Mac 上启动服务，然后用手机浏览器打开终端打印的局域网地址或扫描二维码，就可以查看 Mac 主屏幕，并执行简单的鼠标操作。

当前默认使用长期维护的采集和传输路径：

- 使用 ScreenCaptureKit 采集 macOS 屏幕
- 使用 VideoToolbox 硬件编码 H.264
- 使用 WebRTC 传输 H.264 RTP 媒体流
- 使用 RTCDataChannel 传输指针输入事件
- WebSocket 只用于 SDP/ICE 信令和状态消息

浏览器端通过原生 `<video>` 元素渲染远端画面。Node 服务使用 `werift` 作为 WebRTC 栈，并把 VideoToolbox 输出的 Annex-B H.264 按 RFC 6184 打包为 RTP。

## 环境要求

- macOS 12.3 或更高版本
- Node.js 18 或更高版本
- Swift 命令行工具，用于本地开发或构建 `.app`
- 支持 WebRTC H.264 的浏览器
- 手机和 Mac 需要位于同一个局域网

本地开发时，`http://127.0.0.1` 上的 Chrome 是最稳定的测试目标。手机浏览器访问时，请使用终端打印的局域网 URL 或二维码。

## macOS 权限

MacMirror 需要以下系统权限：

- 屏幕录制：用于实时采集屏幕
- 辅助功能：用于鼠标控制

如果画面是黑屏，或鼠标控制没有反应，请给启动 MacMirror 的应用授予对应权限，然后重启服务。

通常需要在系统设置中打开：

- 系统设置 -> 隐私与安全性 -> 屏幕录制
- 系统设置 -> 隐私与安全性 -> 辅助功能

本地开发时，请给 Terminal、iTerm、VS Code 或实际执行 `npm start` 的应用授权。使用 `dist/MacMirror.app` 时，请给 MacMirror.app 授权；如果 macOS 单独列出了辅助二进制文件，也需要给这些 helper 授权。

如果浏览器页面提示 `Captured black frames`，说明信令已经连接，但 macOS 仍在向采集 helper 返回空白画面。

如果 MacMirror.app 的屏幕录制授权状态异常，或权限弹窗不再出现，可以重置该 App 的屏幕录制权限：

```sh
tccutil reset ScreenCapture local.macmirror.app
```

执行后重新打开 MacMirror.app，并在系统弹窗或系统设置中重新授予屏幕录制权限。

## 本地预览反馈

如果在被采集的同一台 Mac 显示器上打开 MacMirror 页面，页面会采集到自己，从而形成递归嵌套画面。这是正常的屏幕反馈现象。实际使用时请在手机或另一台设备上打开 URL；本地调试时也可以把浏览器窗口移到非被采集的显示器上。

## 手机观看

手机页面提供横屏按钮，会尝试进入全屏并锁定横屏。不支持方向锁定的浏览器仍然可以手动旋转屏幕。如果把 MacMirror 添加到手机主屏幕，Web App manifest 会请求以横屏全屏模式打开。

## 启动服务

```sh
npm start
```

常用参数：

```sh
npm start -- --port 8080
npm start -- --host 192.168.1.10
npm start -- --quality smooth
```

画质模式：

- `smooth`：目标 720p，30 fps，2.5 Mbps
- `balanced`：目标 1080p，30 fps，5 Mbps
- `high`：原生显示器尺寸，30 fps，8 Mbps

WebRTC 发送端使用 constrained-baseline H.264，并会在浏览器发送 PLI 时请求新的关键帧。内部 native helper 会以 JSONL/base64 包的形式把帧发送给 Node，这只是本机 IPC，不影响浏览器端的传输协议。

终端会打印本机 URL 和 ASCII 二维码。使用 `Ctrl+C` 停止服务。

## macOS App

构建可从 Finder 启动的 App bundle：

```sh
npm run build:macos
```

构建完成后打开 `dist/MacMirror.app`。App 会启动本地投屏服务，选择一个可用端口，并显示二维码窗口。用同一局域网内的手机扫描二维码即可打开投屏页面。

构建、签名并安装到 `/Applications/MacMirror.app`：

```sh
npm run install:macos
```

安装脚本会重新构建 `dist/MacMirror.app`，签名 App 和 native helpers，干净替换已有的 `/Applications/MacMirror.app`，并校验安装后的 bundle。默认使用本地 ad-hoc 签名。如果你有 Developer ID 或 Apple Development 签名身份，可以设置 `MACMIRROR_CODESIGN_IDENTITY`，这样 macOS 隐私权限在重建后更容易保持稳定：

```sh
MACMIRROR_CODESIGN_IDENTITY="Developer ID Application: Example" npm run install:macos
```

如果安装目录不可写，脚本可能会请求 `sudo`。如需安装到其他目录，可以设置 `MACMIRROR_INSTALL_DIR`：

```sh
MACMIRROR_INSTALL_DIR="$HOME/Applications" npm run install:macos
```

App bundle 已包含编译后的 native 采集和输入 helper，但 Mac 上仍需要安装 Node.js 18 或更高版本。如果画面黑屏或控制无效，请给 MacMirror.app 授予屏幕录制和辅助功能权限；如果 macOS 单独列出了 helper 二进制文件，也需要给这些 helper 授权，然后重启 App。

## 其他说明

- 服务默认绑定第一个私有局域网 IPv4 地址。只有明确需要监听所有网卡时，才使用 `--host 0.0.0.0`。
- 允许多个观看端连接。第一个连接的客户端拥有控制权，其他客户端仍可观看。
- `native/MacMirrorCapture.swift` 保留为旧的 JPEG helper，默认服务路径是 `native/MacMirrorH264Capture.swift`。
