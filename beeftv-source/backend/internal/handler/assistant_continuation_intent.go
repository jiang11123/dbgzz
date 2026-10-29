package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantruntime"
)

// An unattached browser sends /chat rather than /steer. New messages and
// session changes must stop a background continuation before taking its slot.
func stopAssistantContinuationsForIntent(c *gin.Context, svc *app.Service, host *assistantruntime.Host, canvasID, sessionID string) bool {
	userID := c.GetString("agentUserId")
	rows, err := svc.StopAssistantContinuationsForIntent(userID, canvasID, sessionID)
	if err != nil {
		failService(c, err)
		return false
	}
	for _, row := range rows {
		body, _ := json.Marshal(map[string]string{"canvasId": row.CanvasID, "sessionId": row.SessionID, "requestId": row.RequestID})
		request, requestErr := host.NewChildRequest(c.Request.Context(), http.MethodPost, "/cancel", bytes.NewReader(body))
		if requestErr == nil {
			request.Header.Set("Content-Type", "application/json")
			var response *http.Response
			response, requestErr = agentHostClient(30 * time.Second).Do(request)
			if requestErr == nil {
				var result struct {
					Accepted bool   `json:"accepted"`
					State    string `json:"state"`
				}
				decodeErr := json.NewDecoder(io.LimitReader(response.Body, 16<<10)).Decode(&result)
				_ = response.Body.Close()
				if response.StatusCode/100 == 2 && decodeErr == nil && result.Accepted && (result.State == "stopped" || result.State == "finished" || result.State == "pending") {
					if err := svc.AcknowledgeAssistantContinuationStop(userID, row.ID); err != nil {
						failService(c, err)
						return false
					}
					continue
				}
			}
		}
		// Keep the stopping receipt even if host /complete has already settled
		// the Go turn. Retrying names this request, never a newer user input.
		c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "continuation_stop_unconfirmed", "msg": "未能确认已停止自动继续，请重试。"})
		return false
	}
	return true
}
