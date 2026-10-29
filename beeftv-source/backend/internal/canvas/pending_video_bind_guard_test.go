package canvas

import "testing"

func TestPendingVideoBindingRejectsEveryExistingMediaIdentity(t *testing.T) {
	patch := TaskOutputBind{PendingClientOperationID: "same-admission", MediaType: "video"}
	for _, where := range []string{"node", "metadata"} {
		for _, field := range []string{"taskId", "content", "storageKey", "assetId", "resourceId", "url", "dataUrl"} {
			t.Run(where+"/"+field, func(t *testing.T) {
				metadata := map[string]any{"taskClientOperationId": "same-admission"}
				node := map[string]any{"type": "video", "metadata": metadata}
				if where == "node" {
					node[field] = "existing-result"
				} else {
					metadata[field] = "existing-result"
				}
				if canBindPendingVideoNode(node, patch) {
					t.Fatal("pending recovery accepted an already occupied media node")
				}
			})
		}
	}
}
