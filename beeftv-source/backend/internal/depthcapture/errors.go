package depthcapture

import (
	"errors"
	"strings"
)

var (
	ErrCUDADevice    = errors.New("CUDA 设备或模型前向不可用")
	ErrNeedVideo     = errors.New("必须指定待处理视频")
	ErrMissingVideo  = errors.New("无法读取待处理视频，可能已被删除")
	ErrNotVideo      = errors.New("深度动作捕捉仅支持视频资源")
	ErrTooLong       = errors.New("视频超过 15 秒，请先使用视频剪辑缩短")
	ErrUnsupportedOS = errors.New("当前版本仅支持 Apple Silicon Mac 和 Windows x64")
	ErrMissingCUDA   = errors.New("缺少 CUDA 真实模型探针")
	ErrWindowsKey    = errors.New("Windows 深度处理组件尚未配置可信发布公钥，暂不可用")
	ErrBadInput      = errors.New("任务缺少有效的视频资源引用")
	ErrTempDir       = errors.New("无法创建安全的临时目录")
	ErrPrepareInput  = errors.New("无法准备输入视频")
	ErrReadInput     = errors.New("读取输入视频失败")
	ErrPrepareOutput = errors.New("无法准备输出目录")
	ErrCleanCUDA     = errors.New("无法清理未完成的 CUDA 输出")
	ErrReprepareOut  = errors.New("无法重新准备输出目录")
	ErrNoPreview     = errors.New("深度处理组件没有生成有效的视频文件")
	ErrOpenPreview   = errors.New("无法读取生成的视频文件")
	ErrEmptyPreview  = errors.New("生成的视频文件为空")
)

const (
	stageUnavailable = "深度处理不可用"
	stageFailed      = "深度处理失败"
	stageTooLong     = "视频过长"
	stageComponent   = "深度组件不可用"
	stageOutput      = "输出校验失败"
	stageSave        = "保存结果失败"
)

func workerFailureSummary(message string) string {
	// curl's progress meter can fill the whole diagnostic budget before its
	// error. The tail contains the exit reason and Python's final exception.
	runes := []rune(strings.TrimSpace(message))
	if len(runes) > 800 {
		return "…" + string(runes[len(runes)-800:])
	}
	return string(runes)
}
