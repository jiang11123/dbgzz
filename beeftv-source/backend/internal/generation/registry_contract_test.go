package generation_test

import (
	"testing"

	"infinite-canvas/backend/internal/generation"
)

// Engine/NewEngine/Deps 包装层已移除：生成域在生产里由 registry 与组合根的实际
// 调用面（app 的 generation_registry_bridge）使用，没有任何生产代码构造 Engine。
// 这里锁定被真实使用的 registry 发布合同，确保删除包装没有削弱协议回退表。
func TestGenerationRegistryKeepsOfficialDeclarativeContracts(t *testing.T) {
	if name, ok := generation.OfficialDeclarativeImageInterface("openai-image"); !ok || name == "" {
		t.Fatalf("openai-image whitelist = %q %v", name, ok)
	}
	registry := generation.LoadOfficialFallbackRegistry()
	if registry == nil {
		t.Fatal("LoadOfficialFallbackRegistry returned nil")
	}
	if _, ok := registry.Resolve("xai-video"); !ok {
		t.Fatal("official generation registry lost xai-video when non-generation packages are present")
	}
}
