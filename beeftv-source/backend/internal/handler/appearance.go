package handler

import (
	"io"
	"net/http"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/appearance"

	"github.com/gin-gonic/gin"
)

func RegisterDesktopAppearanceRoutes(r *gin.RouterGroup, svc *app.Service) {
	r.GET("/public/appearance", func(c *gin.Context) {
		setting, err := requestAppearance(c, svc).Public()
		if err != nil {
			failService(c, err)
			return
		}
		c.Header("Cache-Control", "no-store")
		ok(c, gin.H{"appearance": setting})
	})

	r.GET("/public/appearance/assets/:slot", func(c *gin.Context) {
		stream, err := svc.OpenAppearanceAsset(c.Param("slot"), c.GetHeader("Range"))
		if err != nil {
			failService(c, err)
			return
		}
		defer stream.Body.Close()
		resource := stream.Resource
		mimeType := resource.MimeType
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		if c.Query("v") != "" {
			c.Header("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			c.Header("Cache-Control", "public, no-cache")
		}
		c.Header("Accept-Ranges", "bytes")
		c.Header("Referrer-Policy", "no-referrer")
		c.Header("X-Content-Type-Options", "nosniff")
		if stream.ContentRange != "" {
			c.Header("Content-Range", stream.ContentRange)
		}
		if seeker, available := stream.Body.(io.ReadSeeker); available {
			c.Header("Content-Type", mimeType)
			http.ServeContent(c.Writer, c.Request, resource.ID, resource.UpdatedAt, seeker)
			return
		}
		c.DataFromReader(stream.StatusCode, stream.ContentLength, mimeType, stream.Body, nil)
	})

}

func requestAppearance(c *gin.Context, svc *app.Service) *appearance.Service {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.Appearance != nil {
		return dependencies.Appearance
	}
	if svc == nil {
		return appearance.New(appearance.Dependencies{})
	}
	return svc.AppearanceDomain()
}
