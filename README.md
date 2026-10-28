# Forge Desktop

独立 Electron 桌面壳，复用 `@forge/core` 运行时和 `forge-web-ui` 的完整静态构建。没有第二套 Core/React 源码，不需要用户安装 Node 才能启动应用。

## 构建 Apple Silicon 版

推荐在 Forge 装配主仓中，使用 Node 22.23.1+（22.x）与 pnpm 11.18.0：

```sh
git submodule update --init repos/forge-core repos/forge-web-ui repos/forge-desktop
pnpm setup:desktop      # 首次安装三个模块各自的锁定依赖
pnpm build:desktop      # Core → Web → Desktop；不改变 CLI 启动器
pnpm desktop           # 开发产物
pnpm package:mac       # 在 arm64 Mac 上构建并生成 DMG，不自动上传
```

独立检出时，将 Core、Web、Desktop 放在相邻目录。先分别安装并构建 Core/Web，再在本仓 `pnpm install --frozen-lockfile && pnpm build`。`FORGE_RENDERER_DIR` 可指定已经构建好的 Web 目录，不能指向源码。产物位于 `release/Forge-0.1.0-arm64.dmg` 与 `release/mac-arm64/Forge.app`。

当前包采用 **ad-hoc 签名**，没有 Developer ID 签名或 Apple 公证，不属于可直接绕过 Gatekeeper 的正式分发版。无需、也不会自动关闭系统安全检查。正式分发需要拥有者提供签名/公证流程；不要把证书或 Apple 凭据写进仓库。

## 运行与安全边界

- Electron 主进程负责单实例、窗口、菜单和退出；独立 utilityProcess 持有一个 Core runtime。
- Core 只监听随机 `127.0.0.1` 端口，HTTP 和 WebSocket 请求都必须携带每次启动新生成的令牌。令牌仅由 Electron 主进程给同源请求添加，不写盘、不放进 URL 或 preload。
- 渲染器使用当前 Web 的 HTTP/WebSocket 桥：sandbox、contextIsolation 开启，Node/webview 关闭；外部 HTTP(S) 链接交给系统浏览器。
- 多工作区使用现有 Web 目录选择器；附件、图表使用浏览器下载。macOS 关闭最后一个窗口不停止 Core；Cmd+Q 才关闭监听器并释放 runtime。退出会停止应用持有的任务。
- Core 数据沿用 `FORGE_HOME`，缺省 `~/.local/share/forge`；默认工作区为 home，可在 UI 中切换。不会复制构建机或开发机的配置、密钥与会话。不要让独立 CLI/Core 服务与 Desktop 同时持有同一数据目录，需要并用时为其中一个指定独立 `FORGE_HOME`。
- Chromium 状态放在 Electron userData。端口每次启动变化，基于 origin 的 Web 本地缓存/草稿不保证跨应用重启保留；已保存会话由 Core 持久化。
- 可用 `FORGE_WORKSPACE` 指定初始工作区，`FORGE_DESKTOP_USER_DATA` 指定隔离的 Chromium profile。

### 当前边界

此壳使用 Web 能力集，不恢复旧 IPC 专属功能：原生会话 JSON 导出、LAN 开关和多工作区任意 HTML 文件预览不在首版范围。内联 HTML 预览仍由 Core 提供。浏览器/Office 等外部工具依赖不随包嵌入；需要时在插件设置中配置已安装工具的明确可执行路径。终端工具仍须在本机安装；应用本身包含 Electron 的 Node runtime。

## 聚焦验证

在主仓构建后：

```sh
pnpm --dir repos/forge-desktop --config.verify-deps-before-run=false test
pnpm --dir repos/forge-desktop --config.verify-deps-before-run=false test:smoke
# 检查真正的 .app，而非开发 Electron：
FORGE_DESKTOP_EXECUTABLE="$PWD/repos/forge-desktop/release/mac-arm64/Forge.app/Contents/MacOS/Forge" \
  pnpm --dir repos/forge-desktop --config.verify-deps-before-run=false test:smoke
```

烟测使用隔离 HOME、FORGE_HOME、工作区和 userData，不读取真实配置、不调用外部 Provider。验证实际渲染、HTTP/WS 认证、工作区选择、设置懒加载、会话持久化、输入、Blob 下载、退出和重启。默认报告/截图在主仓 `.forge/tmp/desktop-smoke/`；独立克隆时必须用 `FORGE_DESKTOP_TEST_DIR` 指向外部临时目录。测试数据在结束后删除。

DMG 还应 `hdiutil verify` 并挂载只读检查 `.app`，用 `codesign --verify --deep --strict` 与 `file` 核对签名/架构。编译或签名检查不能代替 Electron 交互验收。`dist/versions.json` 记录参与构建的模块提交与 Core 构建标识。

应用图标从 Forge 归档基线 `a568d4568ebe73057e8ef002c29117179b05bbef` 的 `assets/brand/forge-icon-v3.png` 恢复；仅恢复品牌素材，未恢复旧单体实现。
