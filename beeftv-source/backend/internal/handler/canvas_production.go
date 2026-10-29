package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/app"
)

func registerCanvasProductionRoutes(r *gin.RouterGroup, svc *app.Service) {
	path := "/projects/:id/canvases/:canvasId/production-context"
	r.GET(path, func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		result, err := svc.CanvasProductionContext(user.ID, c.Param("id"), c.Param("canvasId"), c.Query("unitId"), c.Query("shotId"), c.Query("stepKey"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"context": result})
	})
	r.POST(path, func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16384)
		var req app.CanvasProductionTaskRequest
		decoder := json.NewDecoder(c.Request.Body)
		decoder.DisallowUnknownFields()
		if decoder.Decode(&req) != nil || !errors.Is(decoder.Decode(new(any)), io.EOF) {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("制作记录参数无效"))
			return
		}
		result, err := svc.RegisterCanvasProductionTask(user.ID, c.Param("id"), c.Param("canvasId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
}
