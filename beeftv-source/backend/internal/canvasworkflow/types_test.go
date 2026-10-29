package canvasworkflow

import "testing"

func TestCanvasWorkflowGraphValidation(t *testing.T) {
	valid := Definition{Version: 1, Nodes: []Node{{ID: "depth", Title: "Depth", Role: "depth", MediaType: "video"}, {ID: "video", Title: "Video", Role: "input", MediaType: "video"}}, Edges: []Edge{{From: "video", To: "depth"}}, OutputNodeIDs: []string{"depth"}}
	order, err := Validate(valid)
	if err != nil || len(order) != 2 || order[0].ID != "video" {
		t.Fatalf("dependency order=%+v err=%v", order, err)
	}
	for _, variant := range []string{"cycle", "disconnected input", "missing output", "no execution", "duplicate edge"} {
		t.Run(variant, func(t *testing.T) {
			d := valid
			d.Nodes = append([]Node(nil), valid.Nodes...)
			d.Edges = append([]Edge(nil), valid.Edges...)
			switch variant {
			case "cycle":
				d.Nodes[1].Role = "depth"
				d.Edges = append(d.Edges, Edge{From: "depth", To: "video"})
			case "disconnected input":
				d.Edges = nil
			case "missing output":
				d.OutputNodeIDs = []string{"unknown"}
			case "no execution":
				d.Nodes[0].Role = "constant"
			case "duplicate edge":
				d.Edges = append(d.Edges, d.Edges[0])
			}
			if _, err := Validate(d); err == nil {
				t.Fatal("invalid graph accepted")
			}
		})
	}
}
