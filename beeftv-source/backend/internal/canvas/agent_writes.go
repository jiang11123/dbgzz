package canvas

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/canvas/capability"
	"infinite-canvas/backend/internal/kernel"
)

// 内置 Agent 与外部入口（CLI/MCP）的写入统一走这里：
// 规格来自真实 capability，revision 前置条件由仓储原子谓词裁决，调用方不自行拼文档形状。

// NodeDraft 是创建节点所需的最小输入；尺寸与 metadata 由 capability 描述符决定。
type NodeDraft struct {
	Title  string
	Type   string
	Prompt string
}

// CreatedNode 是创建成功后由领域返回的节点身份。
// 调用方必须用它继续工作（连线、后续修改、变更摘要）：标题是用户内容，不是身份，
// 用标题回找会在标题带空白/重名/被并发改写时丢结果。
type CreatedNode struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Type  string `json:"type"`
}

// normalizeNodeTitle 是节点标题唯一的规范化入口：校验、去重、重名判定都只看它。
// 文档里保存的仍是调用方给出的原标题（领域不改写用户内容）。
func normalizeNodeTitle(title string) string {
	return strings.TrimSpace(title)
}

var canvasCapabilityRegistry = capability.BuiltinRegistry()

// nodePlacementGap 是自动排布时相邻节点的水平间距。
const nodePlacementGap = 60.0

func canvasDocNodes(doc map[string]any) []any {
	if nodes, ok := doc["nodes"].([]any); ok {
		return nodes
	}
	return []any{}
}

func findCanvasNode(doc map[string]any, nodeID string) map[string]any {
	for _, rawNode := range canvasDocNodes(doc) {
		node, ok := rawNode.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := node["id"].(string); id == nodeID {
			return node
		}
	}
	return nil
}

func canvasNodeType(node map[string]any) string {
	if node == nil {
		return "text"
	}
	if kind, _ := node["type"].(string); strings.TrimSpace(kind) != "" {
		return kind
	}
	return "text"
}

func newCanvasNodeID() string {
	buf := make([]byte, 5)
	if _, err := rand.Read(buf); err != nil {
		return "node-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return "node-" + strconv.FormatInt(time.Now().UnixNano(), 36) + "-" + hex.EncodeToString(buf)
}

// loadCanvasDoc 读取画布文档（走本服务绑定的事务/连接）。
func (s *Service) loadCanvasDoc(userID, canvasID string) (map[string]any, error) {
	raw, err := s.UserCanvasProject(userID, canvasID)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	return doc, nil
}

// saveCanvasDocWithRevision 用调用方观察到的 revision 保存：唯一裁决者是仓储原子谓词。
func (s *Service) saveCanvasDocWithRevision(userID, canvasID string, doc map[string]any, expectedRevision int64) (UserDataSummary, error) {
	doc["id"] = canvasID
	doc["revision"] = expectedRevision
	encoded, err := json.Marshal(doc)
	if err != nil {
		return UserDataSummary{}, err
	}
	return s.UpsertUserCanvasProject(userID, encoded)
}

func requireExpectedRevision(expectedRevision int64) error {
	if expectedRevision <= 0 {
		return kernel.NewAppError(http.StatusBadRequest, "写操作必须带上读取时的 expectedRevision")
	}
	return nil
}

// CreateUserCanvasNodes 整批校验后一次写入；节点规格来自 capability 描述符。
// 返回值带上每个新节点的 id/标题/类型，调用方不需要（也不允许）用标题回找。
func (s *Service) CreateUserCanvasNodes(userID, canvasID string, drafts []NodeDraft, expectedRevision int64) (UserDataSummary, []CreatedNode, error) {
	if err := requireExpectedRevision(expectedRevision); err != nil {
		return UserDataSummary{}, nil, err
	}
	if len(drafts) == 0 {
		return UserDataSummary{}, nil, kernel.NewAppError(http.StatusBadRequest, "至少需要一个节点")
	}
	doc, err := s.loadCanvasDoc(userID, canvasID)
	if err != nil {
		return UserDataSummary{}, nil, err
	}
	created, err := createCanvasNodes(doc, drafts)
	if err != nil {
		return UserDataSummary{}, nil, err
	}
	summary, err := s.saveCanvasDocWithRevision(userID, canvasID, doc, expectedRevision)
	if err != nil {
		return UserDataSummary{}, nil, err
	}
	return summary, created, nil
}

func createCanvasNodes(doc map[string]any, drafts []NodeDraft) ([]CreatedNode, error) {
	nodes := canvasDocNodes(doc)
	existingTitles := map[string]bool{}
	cursorX := 120.0
	for _, rawNode := range nodes {
		if node, ok := rawNode.(map[string]any); ok {
			if title, _ := node["title"].(string); title != "" {
				existingTitles[normalizeNodeTitle(title)] = true
			}
			position, _ := node["position"].(map[string]any)
			x, _ := position["x"].(float64)
			width, _ := node["width"].(float64)
			if width <= 0 {
				width = 320
				if descriptor, ok := canvasCapabilityRegistry.Resolve(canvasNodeType(node)); ok && descriptor.DefaultWidth > 0 {
					width = descriptor.DefaultWidth
				}
			}
			if right := x + width + nodePlacementGap; right > cursorX {
				cursorX = right
			}
		}
	}
	seen := map[string]bool{}
	for _, draft := range drafts {
		title := normalizeNodeTitle(draft.Title)
		if title == "" {
			return nil, kernel.NewAppError(http.StatusBadRequest, "每个节点都需要标题")
		}
		if seen[title] {
			return nil, kernel.NewAppError(http.StatusBadRequest, "同一批次内标题重复: "+title)
		}
		seen[title] = true
		if existingTitles[title] {
			return nil, kernel.NewAppError(http.StatusConflict, "标题已存在: "+title)
		}
		if _, ok := canvasCapabilityRegistry.Resolve(draft.Type); !ok {
			return nil, kernel.NewAppError(http.StatusBadRequest,
				"不支持的节点类型: "+draft.Type+"（可用: "+strings.Join(canvasCapabilityRegistry.Types(), "|")+"）")
		}
	}
	// 从既有节点最右边缘开始，再按本批节点的累计宽度推进。
	created := make([]CreatedNode, 0, len(drafts))
	for _, draft := range drafts {
		descriptor, _ := canvasCapabilityRegistry.Resolve(draft.Type)
		width, height := descriptor.DefaultWidth, descriptor.DefaultHeight
		if width <= 0 {
			width = 320
		}
		if height <= 0 {
			height = 220
		}
		metadata := descriptor.Metadata(draft.Prompt)
		// 自带 prompt 落点的节点（豆包账号）已在 CreateMetadata 里放好，不再多写一份 metadata.prompt。
		if _, ownsPrompt := descriptor.PatchFields["prompt"]; !ownsPrompt && strings.TrimSpace(draft.Prompt) != "" {
			metadata["prompt"] = draft.Prompt
		}
		nodeID := newCanvasNodeID()
		nodes = append(nodes, map[string]any{
			"id": nodeID, "type": draft.Type, "title": draft.Title,
			"position": map[string]any{"x": cursorX, "y": 160},
			"width":    width, "height": height, "metadata": metadata,
		})
		created = append(created, CreatedNode{ID: nodeID, Title: draft.Title, Type: draft.Type})
		cursorX += width + nodePlacementGap
	}
	doc["nodes"] = nodes
	return created, nil
}

// UpdateUserCanvasNodeFields 局部更新：只覆盖 patch 给出的字段，其余数据逐字保留。
//
// 字段落点由能力描述符决定，操作层不再自造映射：生成类节点声明 content ->
// metadata.composerContent（画布编辑器读的正是这个字段），文本类节点声明
// content -> metadata.content。曾经直接写 metadata.content 会把生成节点的
// 媒体结果槽位当成提示词覆盖掉，而写出的值编辑器又看不到。
//
// 两条硬约束：
//  1. title 是所有节点类型通用的「名称」字段，不依赖描述符是否声明 PatchFields，
//     否则 script/frame 这类没有字段表的结构节点会出现「改名成功但没改」。
//  2. 描述符没有声明的字段必须明确拒绝并整批不写：静默忽略却推进 revision、
//     历史和幂等记录，会让调用方以为写入生效。
func (s *Service) UpdateUserCanvasNodeFields(userID, canvasID, nodeID string, patch map[string]any, expectedRevision int64) (UserDataSummary, error) {
	if err := requireExpectedRevision(expectedRevision); err != nil {
		return UserDataSummary{}, err
	}
	if len(patch) == 0 {
		return UserDataSummary{}, kernel.NewAppError(http.StatusBadRequest, "patch 至少要有一个字段")
	}
	doc, err := s.loadCanvasDoc(userID, canvasID)
	if err != nil {
		return UserDataSummary{}, err
	}
	node := findCanvasNode(doc, nodeID)
	if node == nil {
		return UserDataSummary{}, kernel.NewAppError(http.StatusNotFound, "目标节点不存在: "+nodeID)
	}
	nodeType := canvasNodeType(node)
	descriptor, hasDescriptor := canvasCapabilityRegistry.Resolve(nodeType)
	label := canvasCapabilityRegistry.LabelFor(nodeType)
	// metadata 必须先绑定到节点上：ApplyPatch 写的是 node["metadata"]，
	// 若之后再拿一个新建的空 map 覆盖，没有 metadata 的历史节点会丢掉这次修改。
	metadata, _ := node["metadata"].(map[string]any)
	if metadata == nil {
		metadata = map[string]any{}
	}
	node["metadata"] = metadata

	if title, present := patch["title"]; present {
		text, isString := title.(string)
		if !isString {
			return UserDataSummary{}, kernel.NewAppError(http.StatusBadRequest, "title 必须是字符串")
		}
		node["title"] = text
	}

	declared := map[string]any{}
	for key, value := range patch {
		switch key {
		case "title":
			continue // 已按通用字段处理
		case "prompt":
			// 描述符显式声明了 prompt 落点的节点（如豆包账号节点，提示词在自己的状态里）按声明写入。
			if _, owned := descriptor.PatchFields["prompt"]; hasDescriptor && owned {
				declared[key] = value
				continue
			}
			// 其余节点：prompt 是生成结果字段（已提交提示词），不在可编辑字段表里，
			// 保留直接写入语义，避免既有 CLI/MCP 入口失效。
			text, isString := value.(string)
			if !isString {
				return UserDataSummary{}, kernel.NewAppError(http.StatusBadRequest, "prompt 必须是字符串")
			}
			metadata["prompt"] = text
		case "content":
			if hasDescriptor {
				if _, ok := descriptor.PatchFields[key]; ok {
					declared[key] = value
					continue
				}
				return UserDataSummary{}, unsupportedNodeField(label, nodeType, key)
			}
			// 未知类型没有描述符可用：沿用最小直写行为。
			text, isString := value.(string)
			if !isString {
				return UserDataSummary{}, kernel.NewAppError(http.StatusBadRequest, "content 必须是字符串")
			}
			metadata["content"] = text
		default:
			if !hasDescriptor {
				return UserDataSummary{}, unsupportedNodeField(label, nodeType, key)
			}
			if _, ok := descriptor.PatchFields[key]; ok {
				declared[key] = value
				continue
			}
			return UserDataSummary{}, unsupportedNodeField(label, nodeType, key)
		}
	}
	if len(declared) > 0 {
		if err := descriptor.ApplyPatch(node, declared); err != nil {
			return UserDataSummary{}, kernel.NewAppError(http.StatusBadRequest, err.Error())
		}
		// ApplyPatch 只写声明过的路径（形如 metadata.xxx），不会替换整个 metadata 对象；
		// 这里把同一个 map 回写一次，保证节点上挂的就是刚改过的那个。
		node["metadata"] = metadata
	}
	return s.saveCanvasDocWithRevision(userID, canvasID, doc, expectedRevision)
}

// unsupportedNodeField 是「该节点类型没有这个可编辑字段」的结构化错误：
// 机器可读 reason 为 unsupported_field，调用方据此换字段或换节点。
func unsupportedNodeField(label, nodeType, field string) error {
	return &kernel.AppError{
		Status:  http.StatusBadRequest,
		Code:    http.StatusBadRequest,
		Reason:  kernel.ReasonUnsupportedField,
		Message: fmt.Sprintf("%s 节点不支持更新字段 %s", label, field),
	}
}

// ConnectUserCanvasNodesAtRevision 连线：按来源描述符的连接策略校验；重复连线幂等返回既有摘要。
func (s *Service) ConnectUserCanvasNodesAtRevision(userID, canvasID, fromNodeID, toNodeID string, expectedRevision int64) (UserDataSummary, error) {
	if err := requireExpectedRevision(expectedRevision); err != nil {
		return UserDataSummary{}, err
	}
	doc, err := s.loadCanvasDoc(userID, canvasID)
	if err != nil {
		return UserDataSummary{}, err
	}
	fromNode := findCanvasNode(doc, fromNodeID)
	if fromNode == nil {
		return UserDataSummary{}, kernel.NewAppError(http.StatusNotFound, "起点节点不存在: "+fromNodeID)
	}
	toNode := findCanvasNode(doc, toNodeID)
	if toNode == nil {
		return UserDataSummary{}, kernel.NewAppError(http.StatusNotFound, "终点节点不存在: "+toNodeID)
	}
	// 方向判定交给共享能力校验：来源可作输入、目标可接收、类型被目标放行。
	if err := canvasCapabilityRegistry.ValidateReferenceConnection(canvasNodeType(fromNode), canvasNodeType(toNode)); err != nil {
		return UserDataSummary{}, kernel.NewAppError(http.StatusBadRequest, err.Error())
	}
	connections, _ := doc["connections"].([]any)
	for _, rawEdge := range connections {
		edge, ok := rawEdge.(map[string]any)
		if !ok {
			continue
		}
		from, _ := edge["fromNodeId"].(string)
		to, _ := edge["toNodeId"].(string)
		if from == fromNodeID && to == toNodeID {
			summary, err := s.canvasSummary(userID, canvasID)
			if err != nil {
				return UserDataSummary{}, err
			}
			// 无写入的返回路径也必须满足观察前提，不能将外部推进的版本记成本次新建。
			if summary.Revision != expectedRevision {
				return UserDataSummary{}, kernel.NewAppError(http.StatusConflict, "画布已更新，请重新读取后再连接")
			}
			return summary, nil
		}
	}
	if maxInputs := canvasCapabilityRegistry.MaxReferenceInputCount(canvasNodeType(toNode)); maxInputs > 0 {
		inputs := map[string]bool{}
		for _, rawEdge := range connections {
			edge, ok := rawEdge.(map[string]any)
			if !ok {
				continue
			}
			if target, _ := edge["toNodeId"].(string); target == toNodeID {
				source, _ := edge["fromNodeId"].(string)
				inputs[source] = true
			}
		}
		inputs[fromNodeID] = true
		if len(inputs) > maxInputs {
			label := canvasCapabilityRegistry.LabelFor(canvasNodeType(toNode))
			return UserDataSummary{}, kernel.NewAppError(http.StatusBadRequest,
				label+"最多连接 "+strconv.Itoa(maxInputs)+" 个输入")
		}
	}
	doc["connections"] = append(connections, map[string]any{
		"id": "edge-" + strconv.FormatInt(time.Now().UnixNano(), 36), "fromNodeId": fromNodeID, "toNodeId": toNodeID,
	})
	return s.saveCanvasDocWithRevision(userID, canvasID, doc, expectedRevision)
}

// canvasSummary 取回指定画布摘要（幂等情形返回既有状态）。
func (s *Service) canvasSummary(userID, canvasID string) (UserDataSummary, error) {
	summaries, err := s.UserCanvasProjectSummaries(userID)
	if err != nil {
		return UserDataSummary{}, err
	}
	for _, summary := range summaries {
		if summary.ID == canvasID {
			return summary, nil
		}
	}
	return UserDataSummary{}, kernel.NewAppError(http.StatusNotFound, "画布不存在: "+canvasID)
}
