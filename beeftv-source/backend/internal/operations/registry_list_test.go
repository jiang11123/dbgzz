package operations

import (
	"encoding/json"
	"testing"
)

type filterGetOnly struct{}

func (*filterGetOnly) Allows(*Op, json.RawMessage) error { return nil }

func (*filterGetOnly) Visible(op *Op) bool {
	return op != nil && op.ID == "canvas.get"
}

func TestTypedNilAuthorizerDoesNotFilterOwnerCatalog(t *testing.T) {
	var typedNil *filterGetOnly
	var scope Authorizer = typedNil
	registry := NewRegistry(nil, nil)
	RegisterDefaultOps(registry)

	listed := registry.List(Caller{Kind: CallerManual, Scope: scope})
	if len(listed) != 41 {
		t.Fatalf("带类型的空范围不应收窄 owner 目录，得到 %d: %v", len(listed), descriptorIDs(listed))
	}
	if !containsOp(listed, "conversation.message.attach") {
		t.Fatalf("owner 应看到消息绑定: %v", descriptorIDs(listed))
	}
	if !containsOp(listed, "canvas.document.commit") {
		t.Fatalf("owner 应看到文档提交: %v", descriptorIDs(listed))
	}
	if !containsOp(listed, "asset.list") || !containsOp(listed, "canvas.search") {
		t.Fatalf("owner 应看到工作区级操作: %v", descriptorIDs(listed))
	}

	restricted := registry.List(Caller{Kind: CallerAssistant, Scope: &filterGetOnly{}})
	if len(restricted) != 1 || restricted[0].ID != "canvas.get" {
		t.Fatalf("真实范围仍应过滤: %v", descriptorIDs(restricted))
	}

	external := registry.List(ExternalCaller(false))
	if len(external) != 41 {
		t.Fatalf("外部调用方应看到完整目录 %d: %v", len(external), descriptorIDs(external))
	}
	for _, descriptor := range external {
		if !descriptor.ReadOnly && !jsonContainsOp(descriptor.Params, "operationId") {
			t.Fatalf("外部写操作 schema 必须带 operationId: %s", descriptor.ID)
		}
		if descriptor.ID == "canvas.generation.propose" && !descriptor.ReadOnly {
			t.Fatal("付费提议必须是只读操作")
		}
	}
}

func descriptorIDs(items []Descriptor) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.ID)
	}
	return out
}

func containsOp(items []Descriptor, id string) bool {
	for _, item := range items {
		if item.ID == id {
			return true
		}
	}
	return false
}

func jsonContainsOp(raw json.RawMessage, needle string) bool {
	return len(raw) > 0 && string(raw) != "" && (func() bool {
		body := string(raw)
		for i := 0; i+len(needle) <= len(body); i++ {
			if body[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
