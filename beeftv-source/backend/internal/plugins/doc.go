package plugins

// 本包是协议插件域：官方包与自定义包的 registry、校验、安装/卸载、并发缓存，
// 以及启用/停用、用户/平台可用性，和面向渠道设置的 provider 能力目录。
// 生产环境以 SQLite SystemSetting plugin_registry 为已提交权威，包字节是
// 哈希寻址的文件系统 blob。live registry 快照归属于单个 Runtime，不使用
// 进程级回调表。组合根在 internal/app 绑定 Store 后再暴露适配器；本包不得
// import internal/app。
