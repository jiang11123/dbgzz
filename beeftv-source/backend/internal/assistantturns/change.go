package assistantturns

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"sort"
	"strings"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func changeFromReceipts(record Record, receipts []model.AgentOpRecord) (*Change, error) {
	if len(record.CanvasSnapshots) > 0 {
		groups := map[string][]model.AgentOpRecord{}
		for _, receipt := range receipts {
			var p struct {
				CanvasID string `json:"canvasId"`
			}
			if json.Unmarshal([]byte(receipt.ResultJSON), &p) != nil {
				return nil, errCorruptStored()
			}
			if p.CanvasID == "" {
				continue
			}
			if _, ok := record.CanvasSnapshots[p.CanvasID]; !ok {
				return nil, errors.New("助手回执缺少目标画布快照")
			}
			groups[p.CanvasID] = append(groups[p.CanvasID], receipt)
		}
		ids := make([]string, 0, len(groups))
		for id := range groups {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		var combined *Change
		for _, id := range ids {
			snapshot := record.CanvasSnapshots[id]
			sub := record
			sub.CanvasSnapshots = nil
			sub.CanvasID = id
			sub.RevisionBefore = snapshot.RevisionBefore
			c, err := changeFromReceipts(sub, groups[id])
			if err != nil {
				return nil, err
			}
			if c == nil {
				continue
			}
			c.CanvasID = id
			if combined == nil {
				combined = &Change{RevisionBefore: record.RevisionBefore}
			}
			combined.CanvasChanges = append(combined.CanvasChanges, *c)
			if id == record.CanvasID {
				children := combined.CanvasChanges
				*combined = *c
				combined.CanvasChanges = children
			}
		}
		return combined, nil
	}
	if strings.TrimSpace(record.TurnID) == "" {
		return nil, errors.New("助手操作回执不可用，已保留撤销快照")
	}
	type step struct {
		revision int64
		opID     string
		op       string
		payload  map[string]any
	}
	steps := make([]step, 0, len(receipts))
	for _, receipt := range receipts {
		var payload map[string]any
		if json.Unmarshal([]byte(receipt.ResultJSON), &payload) != nil {
			return nil, errors.New("助手操作回执损坏，已保留撤销快照")
		}
		if got, _ := payload["canvasId"].(string); got != record.CanvasID {
			return nil, errors.New("助手操作回执的画布归属不一致，已保留撤销快照")
		}
		if receipt.Op == "canvas.edge.create" && payload["created"] != true {
			continue
		}
		revision, ok := jsonWholeNumber(payload["revision"])
		if !ok || revision <= record.RevisionBefore {
			continue
		}
		steps = append(steps, step{revision: revision, opID: receipt.OpID, op: receipt.Op, payload: payload})
	}
	if len(steps) == 0 {
		return nil, nil
	}
	sort.Slice(steps, func(i, j int) bool { return steps[i].revision < steps[j].revision })
	change := &Change{RevisionBefore: record.RevisionBefore}
	for _, item := range steps {
		if item.revision <= change.RevisionAfter {
			continue
		}
		change.RevisionAfter = item.revision
		change.OperationIDs = append(change.OperationIDs, item.opID)
		switch item.op {
		case "canvas.timeline.update":
			if item.payload["timelineUpdated"] == true {
				change.TimelineUpdated = true
			}
		case "canvas.nodes.create", "canvas.script.prepare":
			for _, raw := range docItems(item.payload["created"]) {
				if id, _ := raw["id"].(string); id != "" && !slices.Contains(change.CreatedNodeIDs, id) {
					change.CreatedNodeIDs = append(change.CreatedNodeIDs, id)
				}
			}
			if item.op == "canvas.script.prepare" {
				if id, _ := item.payload["nodeId"].(string); id != "" {
					change.UpdatedNodeIDs = uniqueSorted(append(change.UpdatedNodeIDs, id))
				}
				change.CreatedEdgeIDs = uniqueSorted(append(change.CreatedEdgeIDs, stringItems(item.payload["createdEdgeIds"])...))
			}
		case "canvas.document.commit":
			change.DocumentUpdated = true
		case "canvas.node.delete", "canvas.edge.delete":
			change.DeletedNodeIDs = uniqueSorted(append(change.DeletedNodeIDs, stringItems(item.payload["deletedNodeIds"])...))
			change.DeletedEdgeIDs = uniqueSorted(append(change.DeletedEdgeIDs, stringItems(item.payload["deletedEdgeIds"])...))
		case "canvas.node.update", "canvas.node.bind_asset", "canvas.node.configure", "canvas.node.move", "canvas.task.bind",
			"canvas.script.rows.append", "canvas.script.row.update", "canvas.script.row.remove":
			if item.op == "canvas.script.row.remove" || item.op == "canvas.script.row.update" {
				change.DeletedEdgeIDs = uniqueSorted(append(change.DeletedEdgeIDs, stringItems(item.payload["deletedEdgeIds"])...))
			}
			if item.op == "canvas.script.row.update" {
				for _, id := range stringItems(item.payload["createdEdgeIds"]) {
					if id != "" && !slices.Contains(change.CreatedEdgeIDs, id) {
						change.CreatedEdgeIDs = append(change.CreatedEdgeIDs, id)
					}
				}
			}
			if id, _ := item.payload["nodeId"].(string); id != "" && !slices.Contains(change.UpdatedNodeIDs, id) {
				change.UpdatedNodeIDs = append(change.UpdatedNodeIDs, id)
			}
		case "canvas.edge.create":
			if created, _ := item.payload["created"].(bool); created {
				if id, _ := item.payload["edgeId"].(string); id != "" && !slices.Contains(change.CreatedEdgeIDs, id) {
					change.CreatedEdgeIDs = append(change.CreatedEdgeIDs, id)
				}
			}
		}
	}
	if change.RevisionAfter <= change.RevisionBefore {
		return nil, nil
	}
	return change, nil
}

// MatchesChange checks that a single-write document diff agrees with the
// change summary. It cannot prove authorship of repeated writes on one node.
func MatchesChange(before, after map[string]any, change *Change) bool {
	if change == nil {
		return false
	}
	if change.DocumentUpdated {
		return change.DocumentHash != "" && documentHash(after) == change.DocumentHash
	}
	remaining := make(map[string]any, len(after))
	for key, value := range after {
		remaining[key] = value
	}
	if change.TimelineUpdated {
		if _, exists := after["timeline"]; !exists {
			return false
		}
		if value, exists := before["timeline"]; exists {
			remaining["timeline"] = value
		} else {
			delete(remaining, "timeline")
		}
	}
	for _, field := range []struct {
		name                      string
		created, updated, deleted []string
	}{
		{"nodes", change.CreatedNodeIDs, change.UpdatedNodeIDs, change.DeletedNodeIDs},
		{"connections", change.CreatedEdgeIDs, nil, change.DeletedEdgeIDs},
	} {
		oldItems, oldOK := before[field.name].([]any)
		newItems, newOK := after[field.name].([]any)
		if !oldOK || !newOK {
			return false
		}
		oldByID := make(map[string]any, len(oldItems))
		for _, item := range oldItems {
			obj, ok := item.(map[string]any)
			id, _ := obj["id"].(string)
			if !ok || id == "" || oldByID[id] != nil {
				return false
			}
			oldByID[id] = item
		}
		deleted := map[string]bool{}
		for _, id := range field.deleted {
			deleted[id] = true
		}
		kept := make([]any, 0, len(oldItems))
		for _, item := range oldItems {
			obj := item.(map[string]any)
			id, _ := obj["id"].(string)
			if !deleted[id] {
				kept = append(kept, item)
			}
		}
		oldItems = kept
		declared := make(map[string]bool)
		for _, id := range field.created {
			if deleted[id] {
				continue
			}
			if declared[id] || id == "" || oldByID[id] != nil {
				return false
			}
			declared[id] = true
		}
		for _, id := range field.updated {
			if deleted[id] {
				continue
			}
			if created, exists := declared[id]; exists && created {
				continue
			}
			if _, exists := declared[id]; exists || oldByID[id] == nil {
				return false
			}
			declared[id] = false
		}
		projected := make([]any, 0, len(newItems))
		seen := make(map[string]bool)
		for _, item := range newItems {
			obj, ok := item.(map[string]any)
			id, _ := obj["id"].(string)
			if !ok || id == "" || seen[id] {
				return false
			}
			seen[id] = true
			if deleted[id] {
				return false
			}
			if created, exists := declared[id]; exists {
				delete(declared, id)
				if created {
					continue
				}
				item = oldByID[id]
			}
			projected = append(projected, item)
		}
		if len(declared) != 0 || !reflect.DeepEqual(oldItems, projected) {
			return false
		}
		remaining[field.name] = before[field.name]
	}
	for _, key := range []string{"revision", "updatedAt", "remoteContentHash"} {
		if value, exists := before[key]; exists {
			remaining[key] = value
		} else {
			delete(remaining, key)
		}
	}
	return reflect.DeepEqual(before, remaining)
}

func stringItems(raw any) []string {
	var result []string
	for _, item := range anyItems(raw) {
		if id, ok := item.(string); ok {
			result = append(result, id)
		}
	}
	return result
}
func anyItems(raw any) []any {
	if value, ok := raw.([]any); ok {
		return value
	}
	return nil
}

func documentHash(doc map[string]any) string {
	raw, _ := json.Marshal(doc)
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}

// Whole-document commits declare their actual changed fields from the owned
// before/after documents. Receipt coverage remains mandatory for every revision.
func (s *Service) declareDocumentChanges(tx *gorm.DB, rec Record, change *Change) error {
	if change == nil {
		return nil
	}
	items := []*Change{change}
	if len(change.CanvasChanges) > 0 {
		items = nil
		for i := range change.CanvasChanges {
			items = append(items, &change.CanvasChanges[i])
		}
	}
	for _, c := range items {
		if !c.DocumentUpdated {
			continue
		}
		id := c.CanvasID
		if id == "" {
			id = rec.CanvasID
		}
		raw, err := s.canvas.BoundTo(tx).UserCanvasProject(rec.UserID, id)
		if err != nil {
			return err
		}
		var after, before map[string]any
		if json.Unmarshal(raw, &after) != nil {
			return errCorruptStored()
		}
		snap := rec.CanvasSnapshots[id]
		if len(snap.Document) == 0 {
			snap.Document = rec.Document
		}
		if json.Unmarshal(snap.Document, &before) != nil {
			return errCorruptStored()
		}
		c.DocumentHash = documentHash(after)
		keys := map[string]bool{}
		for k := range before {
			keys[k] = true
		}
		for k := range after {
			keys[k] = true
		}
		for k := range keys {
			if !reflect.DeepEqual(before[k], after[k]) && k != "revision" && k != "updatedAt" && k != "remoteContentHash" {
				c.UpdatedFields = append(c.UpdatedFields, k)
			}
		}
		sort.Strings(c.UpdatedFields)
		for _, pair := range []struct {
			field                     string
			created, updated, deleted *[]string
		}{{"nodes", &c.CreatedNodeIDs, &c.UpdatedNodeIDs, &c.DeletedNodeIDs}, {"connections", &c.CreatedEdgeIDs, nil, &c.DeletedEdgeIDs}} {
			old, next := map[string]any{}, map[string]any{}
			for _, v := range docItems(before[pair.field]) {
				id, _ := v["id"].(string)
				old[id] = v
			}
			for _, v := range docItems(after[pair.field]) {
				id, _ := v["id"].(string)
				next[id] = v
			}
			*pair.created = nil
			*pair.deleted = nil
			if pair.updated != nil {
				*pair.updated = nil
			}
			for id, v := range next {
				if old[id] == nil {
					*pair.created = append(*pair.created, id)
				} else if pair.updated != nil && !reflect.DeepEqual(old[id], v) {
					*pair.updated = append(*pair.updated, id)
				}
			}
			for id := range old {
				if next[id] == nil {
					*pair.deleted = append(*pair.deleted, id)
				}
			}
			sort.Strings(*pair.created)
			sort.Strings(*pair.deleted)
			if pair.updated != nil {
				sort.Strings(*pair.updated)
			}
		}
		if id == rec.CanvasID && c != change {
			children := change.CanvasChanges
			*change = *c
			change.CanvasChanges = children
		}
	}
	return nil
}

// OperationsCoverSpan requires the listed succeeded receipts to cover every
// revision in (before, after] on the same canvas. A missing revision means
// an unattributed write.
func OperationsCoverSpan(records []model.AgentOpRecord, canvasID string, ids []string, before, after int64) bool {
	if after <= before || len(ids) == 0 {
		return false
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if strings.TrimSpace(id) == "" || seen[id] {
			return false
		}
		seen[id] = true
	}
	if len(records) != len(ids) {
		return false
	}
	covered := make(map[int64]bool, len(records))
	for _, record := range records {
		if record.Status != "succeeded" {
			return false
		}
		var payload map[string]any
		if json.Unmarshal([]byte(record.ResultJSON), &payload) != nil {
			return false
		}
		gotCanvas, _ := payload["canvasId"].(string)
		revision, ok := jsonWholeNumber(payload["revision"])
		if gotCanvas != canvasID || !ok || revision <= before || revision > after || covered[revision] {
			return false
		}
		covered[revision] = true
	}
	for revision := before + 1; revision <= after; revision++ {
		if !covered[revision] {
			return false
		}
	}
	return true
}
