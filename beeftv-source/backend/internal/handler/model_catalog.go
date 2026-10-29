package handler

import (
	"errors"
	"net/http"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

// RegisterModelCatalogRoutes 注册统一模型目录路由
func RegisterModelCatalogRoutes(r *gin.RouterGroup, svc *app.Service) {
	r.GET("/model-catalog", func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		catalog, err := svc.ModelCatalog(nil)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, catalog)
	})

	r.POST("/model-catalog/available", func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		var intent app.ModelRequestIntent
		if err := c.ShouldBindJSON(&intent); err != nil {
			fail(c, http.StatusBadRequest, errors.New("模型能力请求格式错误"))
			return
		}
		catalog, err := svc.ModelCatalog(&intent)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, catalog)
	})

}
