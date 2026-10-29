package app

import "infinite-canvas/backend/internal/canvas/capability"

// 画布节点能力来自 canvas 域注册表。创作提交与本地渠道目录共用这一份，
// 不再经过旧 Agent 运行时。
type canvasNodeCapability = capability.Descriptor

var canvasCapabilityRegistry = capability.BuiltinRegistry()

var generationModeAdapters = map[string]struct{}{
	"image": {}, "video": {}, "audio": {},
}

func canvasNodeCapabilityForType(nodeType string) (canvasNodeCapability, bool) {
	return canvasCapabilityRegistry.Resolve(nodeType)
}

func generationModeSupported(mode string) bool {
	_, implemented := generationModeAdapters[mode]
	return implemented && canvasCapabilityRegistry.SupportsGenerationMode(mode)
}

// 其他工作树仍按旧名字编译：creation_canvas.go、local_channel_models.go。
func cloudAgentNodeCapabilityForType(nodeType string) (canvasNodeCapability, bool) {
	return canvasNodeCapabilityForType(nodeType)
}

func cloudAgentGenerationModeSupported(mode string) bool {
	return generationModeSupported(mode)
}
