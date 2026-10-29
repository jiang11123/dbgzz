package operations

import (
	"regexp"
	"strconv"
	"strings"
)

// This is a proposal precondition, not a scheduler. The frontend submits every
// target independently, so a batch must never depend on another batch output.
// Keep input selection aligned with canvas-resource-references.ts and
// buildNodeGenerationContext; unlike resource lists, retain empty media nodes
// here so a connected prerequisite cannot silently disappear.
func validateGenerationDependencies(doc map[string]any, nodes map[string]map[string]any, targets []string, kind string) error {
	graph := generationDependencyGraph{nodes: nodes, incoming: map[string][]string{}, config: map[string]string{}}
	connections, _ := doc["connections"].([]any)
	for _, raw := range connections {
		edge, _ := raw.(map[string]any)
		from, to := dependencyString(edge, "fromNodeId"), dependencyString(edge, "toNodeId")
		graph.incoming[to] = append(graph.incoming[to], from)
		if dependencyString(nodes[to], "type") == "config" && graph.config[from] == "" {
			graph.config[from] = to
		}
	}
	batch := map[string]bool{}
	for _, id := range targets {
		batch[id] = true
	}
	unready, blocked := []string{}, []string{}
	seen := map[string]bool{}
	for _, target := range targets {
		failed := false
		targetKind := kind
		if targetKind == "" {
			targetKind = nodeGenerationKind(nodes[target])
		}
		for _, id := range graph.references(target, targetKind) {
			if !graph.ready(id, map[string]bool{}) || (id != target && batch[id]) {
				failed = true
				if !seen[id] {
					seen[id] = true
					unready = append(unready, id)
				}
			}
		}
		if failed {
			blocked = append(blocked, target)
		}
	}
	if len(unready) == 0 {
		return nil
	}
	return PreconditionFailed("generation_dependencies_not_ready",
		"参考素材尚未就绪，不能与依赖它的节点一起生成。请先完成节点 "+strings.Join(unready, "、")+"，确认产物就绪后再提议节点 "+strings.Join(blocked, "、"),
		map[string]any{"unreadyNodeIds": unready, "blockedNodeIds": blocked})
}

type generationDependencyGraph struct {
	nodes    map[string]map[string]any
	incoming map[string][]string
	config   map[string]string
}

var generationDependencyMention = regexp.MustCompile(`@\[(node|asset):([^\]]+)\]|@(图片|视频|音频|文本|角色|绘图)(\d+)`)
var generationDependencyNodeMention = regexp.MustCompile(`@\[node:([^\]]+)\]`)

func (g generationDependencyGraph) references(target, kind string) []string {
	inputs := g.inputs(target, "")
	if config := g.config[target]; config != "" {
		if configured := g.inputs(config, target); len(configured) > 0 {
			inputs = configured
		}
	}
	meta := dependencyMetadata(g.nodes[target])
	prompt, ok := meta["composerContent"].(string)
	if !ok {
		prompt = dependencyString(meta, "prompt")
	}
	mentions := inputs
	if len(mentions) == 0 && g.label(target) != "" {
		mentions = []string{target}
	}
	slots, counts := map[string]string{}, map[string]int{}
	nodeSlots := map[string]string{}
	for _, id := range mentions {
		label := g.label(id)
		// Empty placeholders are not numbered by the frontend. Pending nodes with
		// an old result still occupy their original slot, but fail readiness below.
		if label == "" || !g.materialized(id) {
			continue
		}
		counts[label]++
		token := "@" + label + strconv.Itoa(counts[label])
		slots[token] = id
		nodeSlots[id] = token
	}
	// The frontend normalizes known node IDs before applying numbered-token
	// boundaries: @[node:ready]suffix becomes @图片1suffix, not an explicit input.
	prompt = generationDependencyNodeMention.ReplaceAllStringFunc(prompt, func(token string) string {
		if normalized := nodeSlots[token[len("@[node:"):len(token)-1]]; normalized != "" {
			return normalized
		}
		return token
	})
	selected := []string{}
	explicit := false
	for _, match := range generationDependencyMention.FindAllStringSubmatchIndex(prompt, -1) {
		if match[2] >= 0 {
			explicit = true
			if prompt[match[2]:match[3]] == "node" {
				selected = append(selected, prompt[match[4]:match[5]])
			}
		} else if dependencyMentionBoundary(prompt[match[1]:]) {
			if id := slots[prompt[match[0]:match[1]]]; id != "" {
				selected = append(selected, id)
				explicit = true
			}
		}
	}
	workflow := dependencyString(meta, "workflowProvider") == "runninghub" || (dependencyString(meta, "workflowProvider") == "" && dependencyString(meta, "runningHubWorkflowId") != "")
	// Ordinary video and workflow inputs include all connected media. Image
	// prompts with explicit references select only those references.
	composerOnly := dependencyString(g.nodes[target], "type") == "config" && strings.TrimSpace(dependencyString(meta, "composerContent")) != ""
	if (!explicit && !composerOnly) || kind == "video" || workflow {
		selected = append(selected, inputs...)
	}
	if kind == "video" && !workflow {
		for _, field := range []string{"videoStartFrameNodeId", "videoEndFrameNodeId", "videoMiddleFrameNodeId"} {
			if id := dependencyString(meta, field); id != "" {
				selected = append(selected, id)
			}
		}
	}
	media := []string{}
	for _, id := range selected {
		if label := g.label(id); label != "文本" && (label != "" || g.nodes[id] == nil) {
			media = append(media, id)
		}
	}
	return media
}

func dependencyMentionBoundary(suffix string) bool {
	if suffix == "" {
		return true
	}
	// ECMAScript \s (including FEFF, excluding NEL/0085), followed by the
	// punctuation accepted by hasMentionBoundary in canvas-node-generation.ts.
	return strings.ContainsRune(" \t\r\n\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff,.!?;:，。！？；：、)]}】）", []rune(suffix)[0])
}

func (g generationDependencyGraph) inputs(target, exclude string) []string {
	ids := []string{}
	for _, id := range g.incoming[target] {
		if id != exclude && g.label(id) != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

func (g generationDependencyGraph) label(id string) string {
	node := g.nodes[id]
	meta := dependencyMetadata(node)
	if dependencyString(meta, "workflowKind") == "character" && dependencyString(meta, "characterAssetId") != "" {
		return "角色"
	}
	switch dependencyString(node, "type") {
	case "image", "colorgrade":
		return "图片"
	case "video":
		return "视频"
	case "audio":
		return "音频"
	case "drawing":
		return "绘图"
	case "media-conversion":
		state, _ := meta["mediaConversion"].(map[string]any)
		if dependencyString(state, "outputKind") == "video" {
			return "视频"
		}
		return "图片"
	case "text":
		if dependencyString(meta, "content") != "" || dependencyString(meta, "prompt") != "" {
			return "文本"
		}
	case "skill":
		if dependencyString(meta, "content") != "" || meta["skillSnapshot"] != nil {
			return "文本"
		}
	case "markdown", "html", "svg":
		if dependencyString(meta, "content") != "" {
			return "文本"
		}
	}
	return ""
}

func (g generationDependencyGraph) materialized(id string) bool {
	meta := dependencyMetadata(g.nodes[id])
	if g.label(id) == "角色" {
		return true
	} // Character asset versions are hydrated by the existing asset boundary.
	switch dependencyString(g.nodes[id], "type") {
	case "drawing":
		return dependencyString(meta, "drawingId") != ""
	case "media-conversion":
		state, _ := meta["mediaConversion"].(map[string]any)
		return dependencyString(state, "status") == "completed" && dependencyString(state, "resultStorageKey") != ""
	case "colorgrade":
		return g.colorGradeSource(id) != ""
	case "audio":
		return dependencyString(meta, "content") != ""
	default:
		return dependencyString(meta, "content") != "" || dependencyString(meta, "storageKey") != "" || g.label(id) == "文本"
	}
}

func (g generationDependencyGraph) ready(id string, visited map[string]bool) bool {
	if visited[id] || !g.materialized(id) {
		return false
	}
	visited[id] = true
	meta := dependencyMetadata(g.nodes[id])
	status, submission := dependencyString(meta, "taskStatus"), dependencyString(meta, "generationSubmissionState")
	if dependencyString(meta, "status") == "loading" || status == "queued" || status == "running" || submission == "submitting" || submission == "unknown" {
		return false
	}
	if submission == "accepted" && status != "succeeded" && status != "failed" && status != "cancelled" {
		return false
	}
	if meta["resourceReloadAvailable"] == true || dependencyString(meta, "taskStage") == "submission_unknown" {
		return false
	}
	switch dependencyString(meta, "generationErrorCode") {
	case "submission_uncertain", "results_missing", "canvas_conflict", "download_failed", "result_apply_failed":
		return false // A retained old result is not the new task's delivered output.
	}
	if dependencyString(g.nodes[id], "type") == "colorgrade" {
		return g.ready(g.colorGradeSource(id), visited)
	}
	return true
}

func (g generationDependencyGraph) colorGradeSource(id string) string {
	for _, source := range g.incoming[id] {
		if g.label(source) == "图片" && dependencyString(dependencyMetadata(g.nodes[source]), "content") != "" {
			return source
		}
	}
	return ""
}

func dependencyMetadata(node map[string]any) map[string]any {
	meta, _ := node["metadata"].(map[string]any)
	return meta
}
func dependencyString(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}
