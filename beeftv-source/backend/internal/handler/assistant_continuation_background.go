package handler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantruntime"
	"infinite-canvas/backend/internal/assistantturns"
)

// AssistantContinuationSubmitter uses the same owned host admission and
// completion receipts as /assistant/chat, with no composer or browser state.
func AssistantContinuationSubmitter(svc *app.Service, host *assistantruntime.Host) func(context.Context, assistantturns.ContinuationView) error {
	client := assistantChatClient(assistantChatHeaderTimeout)
	return func(ctx context.Context, row assistantturns.ContinuationView) error {
		body, err := json.Marshal(map[string]any{
			"canvasId": row.CanvasID, "sessionId": row.SessionID,
			"continuationId": row.ID, "turnId": row.TurnID,
			"requestId": row.RequestID, "revisionBefore": row.RevisionBefore,
			"permissionMode": row.PermissionMode, "message": row.Message,
			"selectedNodeIds": row.SelectedNodeIDs,
		})
		if err != nil {
			return err
		}
		request, err := host.NewChildRequest(ctx, http.MethodPost, "/chat", bytes.NewReader(body))
		if err != nil {
			return err
		}
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode/100 != 2 {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 8<<10))
			return fmt.Errorf("assistant continuation admission HTTP %d", response.StatusCode)
		}
		reader := bufio.NewReaderSize(response.Body, 32<<10)
		for {
			line, readErr := reader.ReadBytes('\n')
			if assistantTerminalLine(line, row.TurnID) {
				return svc.FinalizeAssistantTurn(row.TurnID)
			}
			if readErr != nil {
				// EOF is an observer interruption. Only an actual terminal or
				// the existing host-only completion callback settles the turn.
				return readErr
			}
		}
	}
}
