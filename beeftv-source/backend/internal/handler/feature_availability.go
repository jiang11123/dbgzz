package handler

import (
	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

func RegisterDesktopFeatureAvailabilityRoutes(r *gin.RouterGroup, svc *app.Service) {
	r.GET("/features", func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		setting, err := svc.FeatureAvailability()
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"features": setting})
	})

}

// 功能守卫先解析本地工作区身份，再判断功能开放状态。
func RequireFeature(svc *app.Service, feature string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			c.Abort()
			return
		}
		if err := svc.RequireFeature(feature); err != nil {
			failService(c, err)
			c.Abort()
			return
		}
		c.Next()
	}
}
