package editing

import "errors"

var (
	ErrNoMedia              = errors.New("时间线没有可渲染的媒体片段")
	ErrOverlap              = errors.New("服务端渲染暂不支持重叠的视频或图片片段")
	ErrNegativeTime         = errors.New("片段时间不能为负数")
	ErrMissingSource        = errors.New("找不到素材")
	ErrMissingMediaRef      = errors.New("片段缺少有效媒体引用")
	ErrInsufficientDuration = errors.New("素材时长不足，请调整裁剪范围")
	ErrMissingAudioTrack    = errors.New("独立音频素材没有可用音轨")
	ErrMissingVideoTrack    = errors.New("素材缺少所需音视频轨")
	ErrInvalidClip          = errors.New("片段时间无效")
	ErrInvalidVolume        = errors.New("片段裁剪或音量无效")
	ErrUnreadableSource     = errors.New("无法解析素材")
	ErrUnsupportedVersion   = errors.New("不支持的时间线版本")
	ErrDuplicateID          = errors.New("时间线存在重复的轨道或片段")
	ErrInvalidID            = errors.New("轨道或片段缺少有效编号")
	ErrUnknownTrack         = errors.New("片段引用了不存在的轨道")
	ErrUnsupportedKind      = errors.New("不支持的片段类型")
	ErrInvalidOutput        = errors.New("输出尺寸、帧率或采样率无效")
	ErrInvalidDuration      = errors.New("时间线或片段时长无效")
)
