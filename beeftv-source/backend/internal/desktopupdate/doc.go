// Package desktopupdate implements BeefTV's signed desktop auto-update engine.
//
// 更新只替换当前应用包或可执行文件，以及随包分发的官方 plugin-packages 和 agent-host。
// 用户数据目录（项目、素材、设置、BeefAPI 登录态、用户上传的插件）不在更新包内，
// 也不会被递归替换。保持应用包路径和可执行文件路径不变，以便 WebView IndexedDB 继续可用。
//
// 安装与健康检查的限制：
//
//   - 真正换文件发生在独立 helper 进程中，且必须等原进程退出。helper 由当前受信任的
//     可执行文件复制而来，用参数数组启动，不经过 shell 拼接。
//   - helper 只能判断“新文件是否就位、进程是否能启动”。它看不到窗口、WebView、
//     或首次启动后的 SQLite 迁移是否成功。
//   - 新进程一旦成功启动，不会因为后续 schema 迁移或业务初始化失败而自动回滚应用。
//     用户数据没有与应用包绑定的完整备份/还原，回滚二进制可能让新库结构配上旧程序。
//   - 换文件或启动失败时，helper 会尝试把备份的应用包/可执行文件放回原位，并写入
//     内部恢复状态（result 文件：阶段、是否已退出父进程、是否已还原、是否已启动）。
//   - 未公证的 macOS 包可能被 Gatekeeper 拦住；未签名的 Windows 可执行文件可能被
//     SmartScreen 拦住。本包不依赖 Apple 证书，包签名是独立的 Ed25519 信封。
//   - 官方插件源在安装包内，更新时整目录替换。用户在数据目录里上传的插件会保留。
package desktopupdate
