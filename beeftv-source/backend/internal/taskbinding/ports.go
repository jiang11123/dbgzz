package taskbinding

import (
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// Ports is the TX-bound workspace the bind algorithm may read and patch.
// Implementations live in the compose root; this package does not import app.
type OutputReads interface {
	Task(userID, taskID string) (*model.Task, error)
	GenerationOutputs(taskID string) ([]localtask.CanonicalOutput, error)
	OwnedReadyResource(userID, resourceID string) (*model.Resource, error)
	OwnedAsset(userID, assetID string) (*model.Asset, error)
}

type Ports interface {
	OutputReads
	BindExistingNode(userID string, patch NodePatch) (NodeBindResult, error)
}

// MessagePorts is the TX-bound workspace for conversation result attach.
type MessagePorts interface {
	OutputReads
	Conversation(userID, conversationID string) (ConversationView, error)
	AttachMessageResult(userID string, input MessageAttachInput) (ConversationView, error)
}

// Request is the authenticated bind identity. Client result URLs/payloads are
// not accepted; the durable task Result row is the generated product.
type Request struct {
	CanvasID    string
	TaskID      string
	NodeID      string
	OutputIndex int
	EffectKey   string
}

// NodePatch is the generation-field overlay canvas applies onto an existing
// node. Title, position and unrelated metadata stay on the node.
type NodePatch struct {
	CanvasID     string
	NodeID       string
	TaskID       string
	OutputIndex  int
	EffectKey    string
	MediaType    string
	AssetID      string
	ResourceID   string
	StorageKey   string
	Content      string
	MimeType     string
	Bytes        int64
	Width        int
	Height       int
	DurationMs   int64
	Storyboard   map[string]any
	AlreadyBound bool
}

// NodeBindResult is the canvas write outcome used to build the op receipt.
type NodeBindResult struct {
	Revision int64
	Node     map[string]any
}

// Receipt is stored on AgentOpRecord in the same TX as the canvas patch.
type Receipt struct {
	Applied      bool           `json:"applied"`
	CanvasID     string         `json:"canvasId"`
	NodeID       string         `json:"nodeId"`
	TaskID       string         `json:"taskId"`
	OutputIndex  int            `json:"outputIndex"`
	EffectKey    string         `json:"effectKey"`
	MediaType    string         `json:"mediaType,omitempty"`
	AssetID      string         `json:"assetId,omitempty"`
	ResourceID   string         `json:"resourceId,omitempty"`
	StorageKey   string         `json:"storageKey,omitempty"`
	Content      string         `json:"content,omitempty"`
	Revision     int64          `json:"revision"`
	AlreadyBound bool           `json:"alreadyBound,omitempty"`
	Node         map[string]any `json:"node,omitempty"`
}

// MessageRequest is the authenticated message attach identity. Client result
// URLs are not accepted; the durable task output is the generated product.
type MessageRequest struct {
	ConversationID string
	MessageID      string
	TaskID         string
	OutputIndex    int
	EffectKey      string
}

type MessageAttachInput struct {
	ConversationID string
	MessageID      string
	TaskID         string
	EffectKey      string
	ResultURLs     []string
	Status         string
	Content        string
}

type ConversationView struct {
	ID       string
	Revision int64
	Deleted  bool
	Document []byte
}

type MessageReceipt struct {
	Applied        bool     `json:"applied"`
	ConversationID string   `json:"conversationId"`
	MessageID      string   `json:"messageId"`
	TaskID         string   `json:"taskId"`
	OutputIndex    int      `json:"outputIndex"`
	EffectKey      string   `json:"effectKey"`
	MediaType      string   `json:"mediaType,omitempty"`
	AssetID        string   `json:"assetId,omitempty"`
	ResourceID     string   `json:"resourceId,omitempty"`
	StorageKey     string   `json:"storageKey,omitempty"`
	Content        string   `json:"content,omitempty"`
	ResultURLs     []string `json:"resultUrls,omitempty"`
	Revision       int64    `json:"revision"`
	AlreadyBound   bool     `json:"alreadyBound,omitempty"`
}
