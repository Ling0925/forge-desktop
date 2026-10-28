# Forge Desktop 开发约定

- 本仓只拥有 Electron 桌面生命周期、安全边界、装配和打包。运行时通过兄弟仓 `@forge/core` 导入，界面使用 `forge-web-ui` 的构建产物；不复制两者的源码，不依赖旧单体。
- 子代理遵循主仓模型约定：`cn:deepseek-v4.1-flash`，除非用户明确另选；失败不自动换模型或重放。
- 构建与验收见 README。临时数据、截图、日志放在主仓 `.forge/tmp/<任务名>/`；独立检出时显式指定外部临时目录。
- Electron 渲染器必须保持 sandbox、contextIsolation、禁用 Node 和 webview。Core 只监听 loopback，HTTP 与 WebSocket 均须通过应用实例令牌检查；不将令牌暴露给页面或日志。
- 启动验收必须用临时 `FORGE_HOME`、工作区和 Electron userData，不读真实密钥或调用真实 Provider。不覆盖已有安装或启动器。
- 变更后跑聚焦 Node 测试、装配构建和真实 Electron 渲染交互检查。macOS 包在目标架构验证；ad-hoc 签名不等于 Developer ID 签名或公证。
- 只提交自己的源码、锁文件和必要文档，不提交产物；主仓 gitlink 单独提交。默认不 push。
