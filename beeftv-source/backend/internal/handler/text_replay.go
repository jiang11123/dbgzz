package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/textreplay"

	"github.com/gin-gonic/gin"
)

// textReplayAPI is the handler-facing slice of textreplay.API. SSE only
// converts the domain projection into event-stream frames.
type textReplayAPI interface {
	Append(userID, taskID, content string) (*model.TaskTextDelta, error)
	Read(userID, taskID string, after int64) (*textreplay.Result, error)
	CachedRead(ctx context.Context, userID, taskID string, after int64) (*textreplay.Result, error)
	Complete(userID, taskID, text string) (*model.Task, error)
}

type appTextReplayAPI struct{ svc *app.Service }

func (a appTextReplayAPI) Append(userID, taskID, content string) (*model.TaskTextDelta, error) {
	return a.svc.AppendTaskTextDelta(userID, taskID, content)
}

func (a appTextReplayAPI) Read(userID, taskID string, after int64) (*textreplay.Result, error) {
	return a.svc.TaskTextReplay(userID, taskID, after)
}

func (a appTextReplayAPI) CachedRead(ctx context.Context, userID, taskID string, after int64) (*textreplay.Result, error) {
	return a.svc.CachedTaskTextReplay(ctx, userID, taskID, after)
}

func (a appTextReplayAPI) Complete(userID, taskID, text string) (*model.Task, error) {
	return a.svc.CompleteTextReplayTask(userID, taskID, text)
}

func registerTaskTextReplayRoutes(r *gin.RouterGroup, svc *app.Service) {
	r.POST("/tasks/:id/text-deltas", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req struct {
			Content string `json:"content"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		item, err := requestTextReplay(c, svc).Append(user.ID, c.Param("id"), req.Content)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, item)
	})
	r.GET("/tasks/:id/text-deltas", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		after, err := taskTextEventCursor(c)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		result, err := requestTextReplay(c, svc).Read(user.ID, c.Param("id"), after)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.GET("/tasks/:id/text-events", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		after, err := taskTextEventCursor(c)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		replayAPI := requestTextReplay(c, svc)
		initial, err := replayAPI.CachedRead(c.Request.Context(), user.ID, c.Param("id"), after)
		if err != nil {
			failService(c, err)
			return
		}
		streamTaskTextEvents(c, replayAPI, user.ID, c.Param("id"), after, initial)
	})
	r.POST("/tasks/:id/text-replay-complete", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req struct {
			Text string `json:"text"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		task, err := requestTextReplay(c, svc).Complete(user.ID, c.Param("id"), req.Text)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		ok(c, task)
	})
}

func taskTextEventCursor(c *gin.Context) (int64, error) {
	queryRaw, headerRaw := c.Query("after"), c.GetHeader("Last-Event-ID")
	var cursor int64
	for _, item := range []struct {
		name string
		raw  string
	}{
		{name: "after", raw: queryRaw},
		{name: "Last-Event-ID", raw: headerRaw},
	} {
		if item.raw == "" {
			continue
		}
		value, err := strconv.ParseInt(item.raw, 10, 64)
		if err != nil || value < 0 {
			return 0, errors.New("after 或 Last-Event-ID 必须是非负整数")
		}
		if value > cursor {
			cursor = value
		}
	}
	return cursor, nil
}

func streamTaskTextEvents(c *gin.Context, replayAPI textReplayAPI, userID string, taskID string, after int64, replay *textreplay.Result) {
	c.Header("Content-Type", "text/event-stream; charset=utf-8")
	c.Header("Cache-Control", "no-cache, no-transform")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	if _, err := fmt.Fprint(c.Writer, ": connected\n\n"); err != nil {
		return
	}
	c.Writer.Flush()
	lastStatus := replay.Status
	lastStage := replay.Stage
	lastProgress := replay.Progress
	writeTaskTextSSE(c, "progress", 0, map[string]any{"status": replay.Status, "stage": replay.Stage, "progress": replay.Progress})

	pollTicker := time.NewTicker(750 * time.Millisecond)
	heartbeatTicker := time.NewTicker(15 * time.Second)
	defer pollTicker.Stop()
	defer heartbeatTicker.Stop()
	for {
		for _, delta := range replay.Deltas {
			writeTaskTextSSE(c, "delta", delta.Sequence, map[string]any{"sequence": delta.Sequence, "content": delta.Content})
			after = delta.Sequence
		}
		if replay.Complete {
			writeTaskTextSSE(c, "terminal", 0, replay)
			return
		}
		select {
		case <-c.Request.Context().Done():
			return
		case <-heartbeatTicker.C:
			if _, err := fmt.Fprint(c.Writer, ": heartbeat\n\n"); err != nil {
				return
			}
			c.Writer.Flush()
		case <-pollTicker.C:
		}
		if replayAPI == nil {
			writeTaskTextSSE(c, "error", 0, map[string]string{"message": "任务文本流不可用"})
			return
		}
		next, err := replayAPI.CachedRead(c.Request.Context(), userID, taskID, after)
		if err != nil {
			writeTaskTextSSE(c, "error", 0, map[string]string{"message": "任务文本流不可用"})
			return
		}
		if next.Status != lastStatus || next.Stage != lastStage || next.Progress != lastProgress {
			writeTaskTextSSE(c, "progress", 0, map[string]any{"status": next.Status, "stage": next.Stage, "progress": next.Progress})
			lastStatus, lastStage, lastProgress = next.Status, next.Stage, next.Progress
		}
		replay = next
	}
}

func writeTaskTextSSE(c *gin.Context, event string, id int64, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	if id > 0 {
		_, _ = fmt.Fprintf(c.Writer, "id: %d\n", id)
	}
	_, _ = fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", event, data)
	c.Writer.Flush()
}
