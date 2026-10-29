package app

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"

	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
)

// executeCanvasWorkflowMedia lowers local operations into the existing durable
// timeline task. Its worker owns encoding, cancellation and resource recovery.
func (s *Service) executeCanvasWorkflowMedia(user, operation string, n cw.Node, edges []cw.Edge, steps map[string]*cw.Step) (*model.Task, error) {
	incoming := make([]cw.Edge, 0)
	for _, edge := range edges {
		if edge.To == n.ID {
			incoming = append(incoming, edge)
		}
	}
	sort.SliceStable(incoming, func(i, j int) bool { return incoming[i].Order < incoming[j].Order })
	switch n.OperationID {
	case "video.trim":
		if len(incoming) != 1 {
			return nil, workflowBad("视频裁剪需要一个视频输入")
		}
	case "video.merge":
		if len(incoming) < 2 {
			return nil, workflowBad("视频合并需要至少两个视频输入")
		}
	default:
		return nil, workflowBad("不支持的本地视频操作")
	}
	visible := true
	project := editing.Project{Version: editing.ProjectVersion, Tracks: []editing.Track{{ID: "video", Kind: editing.KindVideo, Visible: &visible}}}
	options := editing.Options{}
	for i, edge := range incoming {
		step := steps[edge.From]
		if step == nil || step.Status != "succeeded" || step.ResourceID == "" {
			return nil, workflowBad("视频输入尚未完成或没有已保存的素材")
		}
		resource, err := s.workflowResource(user, step.ResourceID, "video")
		if err != nil {
			return nil, err
		}
		start, duration := int64(0), resource.DurationMs
		if n.OperationID == "video.trim" {
			var end int64
			if value, ok := n.Config["startSeconds"]; ok {
				start, err = canvasWorkflowSeconds(value)
			}
			if err == nil {
				end, err = canvasWorkflowSeconds(n.Config["endSeconds"])
			}
			if err != nil || end <= start {
				return nil, workflowBad("裁剪起止时间无效，结束时间必须大于开始时间")
			}
			if resource.DurationMs > 0 && end > resource.DurationMs {
				return nil, workflowBad("裁剪结束时间不能超过视频时长")
			}
			duration = end - start
		}
		if duration <= 0 || duration > editing.MaxDurationMs-project.DurationMs {
			return nil, workflowBad("视频时长缺失或超出支持范围，请先更新素材信息")
		}
		if i == 0 && resource.Width > 0 && resource.Height > 0 {
			// H.264 requires even dimensions; retain the first video's framing.
			options.Width = (resource.Width + 1) / 2 * 2
			options.Height = (resource.Height + 1) / 2 * 2
		}
		id := fmt.Sprintf("video-%d", i)
		project.Clips = append(project.Clips, editing.Clip{
			ID: id, NodeID: id, TrackID: "video", Kind: editing.KindVideo,
			StartMs: project.DurationMs, DurationMs: duration, SourceStartMs: start,
			SourceDurationMs: resource.DurationMs, Volume: 1,
			DirectMedia: &editing.DirectMedia{ID: id, Kind: editing.KindVideo, StorageKey: "resource:" + resource.ID},
		})
		project.DurationMs += duration
	}
	return s.CreateTimelineRenderTask(user, TimelineRenderCreateRequest{Timeline: project, Options: options, ClientOperationID: operation})
}

func canvasWorkflowSeconds(value any) (int64, error) {
	var seconds float64
	switch number := value.(type) {
	case float64:
		seconds = number
	case int:
		seconds = float64(number)
	case int64:
		seconds = float64(number)
	case json.Number:
		var err error
		seconds, err = number.Float64()
		if err != nil {
			return 0, err
		}
	default:
		return 0, fmt.Errorf("时间必须是数字")
	}
	if math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < 0 || seconds > float64(editing.MaxDurationMs)/1000 {
		return 0, fmt.Errorf("时间超出支持范围")
	}
	return int64(math.Round(seconds * 1000)), nil
}
