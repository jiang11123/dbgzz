package handler

import (
	"fmt"
	"net/http"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/diagnostics"

	"github.com/gin-gonic/gin"
)

func RegisterDiagnosticsRoutes(r *gin.RouterGroup, svc *app.Service) {
	r.POST("/diagnostics/environment", func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024)
		var req struct {
			Repair bool `json:"repair"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		c.Header("Cache-Control", "private, no-store")
		ok(c, requestDiagnostics(c, svc).CheckEnvironment(c.Request.Context(), req.Repair))
	})
	r.POST("/diagnostics/preview", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4<<20)
		var req diagnostics.ExportRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		preview, err := requestDiagnostics(c, svc).Preview(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, preview)
	})

	r.POST("/diagnostics/export", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4<<20)
		var req diagnostics.ExportRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		bundle, err := requestDiagnostics(c, svc).Export(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		c.Header("Cache-Control", "private, no-store")
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", bundle.FileName))
		c.Header("X-Diagnostic-Bundle-ID", bundle.BundleID)
		c.Header("X-Diagnostic-Schema-Version", fmt.Sprint(diagnostics.SchemaVersion))
		c.Data(http.StatusOK, "application/zip", bundle.Data)
	})

}

func requestDiagnostics(c *gin.Context, svc *app.Service) *diagnostics.Service {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.Diagnostics != nil {
		return dependencies.Diagnostics
	}
	if svc == nil {
		return diagnostics.New(diagnostics.Dependencies{})
	}
	return svc.DiagnosticsDomain()
}
