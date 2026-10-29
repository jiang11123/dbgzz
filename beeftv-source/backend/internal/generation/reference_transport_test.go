package generation

import "testing"

func TestReferenceTransportErrorsRemainActionable(t *testing.T) {
	for _, raw := range []string{
		"当前模型协议要求公网素材地址，本地工作区请改用支持内嵌素材的模型",
		"当前 JSON 视频协议的参考素材不能使用内嵌数据，请先上传到本地资源目录",
		"当前模型暂不支持参考视频，请移除此素材或选择支持该素材的模型",
		"当前模型最多支持 1 个参考图片，请移除多余素材后重新生成",
	} {
		got := ClassifyText(raw)
		if got.Category != CategoryInvalidParams || got.Action == "" {
			t.Fatalf("unclassified error: %#v", got)
		}
		readback := ClassifyText(got.UserMessage())
		if readback.Category != got.Category || readback.Reason != got.Reason {
			t.Fatalf("lost on persistence: %#v", readback)
		}
	}
}
