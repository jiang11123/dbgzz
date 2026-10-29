package desktopupdate

import "errors"

const (
	StatusDisabled    = "disabled"
	StatusIdle        = "idle"
	StatusChecking    = "checking"
	StatusAvailable   = "available"
	StatusDownloading = "downloading"
	StatusReady       = "ready"
	StatusInstalling  = "installing"
	StatusError       = "error"
)

// UpdateState is the Wails JSON contract. Field names must stay stable.
type UpdateState struct {
	Phase           string `json:"phase,omitempty"`
	CompletedFiles  int    `json:"completedFiles,omitempty"`
	TotalFiles      int    `json:"totalFiles,omitempty"`
	InstallPrepared bool   `json:"installPrepared,omitempty"`
	Status          string `json:"status"`
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`
	ReleaseNotes    string `json:"releaseNotes"`
	DownloadedBytes int64  `json:"downloadedBytes"`
	TotalBytes      int64  `json:"totalBytes"`
	BytesPerSecond  int64  `json:"bytesPerSecond"`
	Reconnecting    bool   `json:"reconnecting"`
	Error           string `json:"error"`
}

var (
	ErrPreparationTimeout = errors.New("准备更新超时，请重试；当前版本未被替换。")
	ErrDisabled           = errors.New("自动更新未开启")
	ErrBusy               = errors.New("已有更新操作正在进行")
	ErrNotAvailable       = errors.New("没有可下载的更新")
	ErrNotReady           = errors.New("更新尚未准备好安装")
	ErrInvalidSignature   = errors.New("更新信息无法验证")
	ErrTampered           = errors.New("更新文件损坏或被篡改")
	ErrWrongPlatform      = errors.New("没有适合当前系统的更新包")
	ErrUnsupported        = errors.New("当前系统不支持自动更新")
	ErrNoDowngrade        = errors.New("更新源版本不是更新的版本")
	ErrTimeout            = errors.New("网络长时间没有响应")
	ErrInvalidArchive     = errors.New("更新包格式无效")
	ErrInstallFailed      = errors.New("安装更新失败")
	ErrIncompleteConfig   = errors.New("更新配置不完整")
	ErrProxyUnavailable   = errors.New("连不上代理，请检查代理软件")
	ErrNetworkOffline     = errors.New("连不上更新服务器，请检查网络")
	ErrSecureConnection   = errors.New("安全连接失败，请检查代理设置")
	ErrServerBusy         = errors.New("更新服务器暂时不可用")
	ErrConnectionDropped  = errors.New("网络连接中断")
	ErrNetworkUnstable    = errors.New("网络不稳定，已保留下载进度")
)

func (s UpdateState) clone() UpdateState {
	return s
}

func preparationTimeoutMessage(phase string) string {
	stage := "准备安装"
	switch phase {
	case "verifying":
		stage = "校验更新包"
	case "extracting":
		stage = "解压更新包"
	}
	return stage + "超时，当前版本未被替换。请重试；再次失败时请导出诊断包。"
}
