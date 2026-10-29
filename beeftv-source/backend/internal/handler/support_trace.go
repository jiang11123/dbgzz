package handler

import (
	"net/http"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/supporttrace"

	"github.com/gin-gonic/gin"
)

// SupportTracingMiddleware records business mutations, not successful polling.
// It reads neither request nor response bodies and does not alter auth/errors.
func SupportTracingMiddleware(svc *app.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		if svc == nil || c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead || c.Request.Method == http.MethodOptions || strings.Contains(c.FullPath(), "/diagnostics/") {
			c.Next()
			return
		}
		user, err := currentUser(c, svc)
		if err != nil || user == nil {
			c.Next()
			return
		}
		fields := supporttrace.Fields{UserID: user.ID, RequestID: RequestID(c)}
		name := "http.request"
		switch {
		case strings.HasPrefix(c.FullPath(), "/api/tasks"):
			fields.TaskID = c.Param("id")
			name = "generation.request"
		case strings.HasPrefix(c.FullPath(), "/api/canvas-projects"):
			fields.CanvasID = c.Param("id")
			name = "canvas.request"
		case strings.HasPrefix(c.FullPath(), "/api/assistant"):
			fields.TurnID = c.Param("turnId")
			name = "assistant.request"
		}
		ctx, finish := svc.SupportTrace().Start(c.Request.Context(), name, fields)
		c.Request = c.Request.WithContext(ctx)
		if traceID := supporttrace.TraceID(ctx); traceID != "" {
			c.Set(traceIDKey, traceID)
			c.Header(traceIDHeader, traceID)
		}
		defer func() {
			reason := ""
			if c.Writer.Status() >= 400 {
				reason = "http_" + strconv.Itoa(c.Writer.Status())
			}
			finish(reason)
		}()
		c.Next()
	}
}
