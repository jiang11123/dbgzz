package handler

import (
	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/app"
	"net/http"
	"time"
)

func registerMediaUpscaleRoutes(r *gin.RouterGroup, svc *app.Service) {
	r.POST("/media-upscale/tasks/:id/recover", func(c *gin.Context) {
		if !requireTrustedDesktopWritePrincipal(c, "原任务恢复只能由当前桌面界面发起") {
			return
		}
		user, e := currentUser(c, svc)
		if e != nil {
			failService(c, e)
			return
		}
		task, e := svc.RecoverMediaUpscale(c.Request.Context(), user.ID, c.Param("id"))
		if e != nil {
			failService(c, e)
			return
		}
		ok(c, task)
	})
	r.GET("/media-upscale/capabilities", func(c *gin.Context) {
		if _, e := currentUser(c, svc); e != nil {
			failService(c, e)
			return
		}
		ok(c, svc.MediaUpscaleCapabilities())
	})
	for _, path := range []string{"estimate", "tasks"} {
		action := path
		r.POST("/media-upscale/"+action, func(c *gin.Context) {
			if !requireTrustedDesktopWritePrincipal(c, "超分只能由当前桌面界面发起") {
				return
			}
			user, e := currentUser(c, svc)
			if e != nil {
				failService(c, e)
				return
			}
			policy, available := loadRuntimePolicy(c, svc)
			if !available || !enforceRateLimit(c, "media-upscale:"+user.ID, policy.Request.TaskCreatePerMinute, time.Minute) {
				return
			}
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
			var req app.MediaUpscaleRequest
			if e = c.ShouldBindJSON(&req); e != nil {
				fail(c, 400, e)
				return
			}
			if action == "estimate" {
				value, e := svc.EstimateMediaUpscale(c.Request.Context(), user.ID, req)
				if e != nil {
					failService(c, e)
					return
				}
				ok(c, value)
				return
			}
			task, e := svc.CreateMediaUpscale(c.Request.Context(), user.ID, req)
			if e != nil {
				failService(c, e)
				return
			}
			ok(c, task)
		})
	}
}
