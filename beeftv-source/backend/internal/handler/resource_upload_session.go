package handler

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/app"
	localasset "infinite-canvas/backend/internal/asset"
)

const chunkUploadBodyCapJSON = 16 << 10

// RegisterChunkedUploadRoutes 注册本地媒体分片上传三条接口（POST 开始 / PUT 上传片 / POST 合并）。
func RegisterChunkedUploadRoutes(r *gin.RouterGroup, svc *app.Service, hostedProfile ...bool) {
	_ = hostedProfile
	r.POST("/resources/uploads", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "resources-upload:"+user.ID, policy.Request.ResourceUploadPerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, chunkUploadBodyCapJSON)
		var req struct {
			FileName       string `json:"fileName"`
			Kind           string `json:"kind"`
			Size           int64  `json:"size"`
			Width          int    `json:"width"`
			Height         int    `json:"height"`
			DurationMs     int64  `json:"durationMs"`
			IdempotencyKey string `json:"idempotencyKey"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if strings.TrimSpace(req.IdempotencyKey) == "" {
			req.IdempotencyKey = c.GetHeader("X-Idempotency-Key")
		}
		session, err := svc.StartChunkedResourceUpload(user.ID, localasset.ChunkedUploadStart{
			FileName: req.FileName, Kind: req.Kind, Size: req.Size,
			Width: req.Width, Height: req.Height, DurationMs: req.DurationMs,
			IdempotencyKey: req.IdempotencyKey,
		})
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"uploadId": session.UploadID, "chunkSize": session.ChunkSize, "chunkCount": session.ChunkCount, "received": session.Received})
	})

	r.PUT("/resources/uploads/:id/chunks/:index", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		index, err := strconv.Atoi(c.Param("index"))
		if err != nil {
			failService(c, localasset.UploadChunkIndexInvalid())
			return
		}
		if err := svc.PutChunkedResourceUpload(user.ID, c.Param("id"), index, c.Request.Body); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"index": index})
	})

	r.POST("/resources/uploads/:id/complete", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		resource, err := svc.CompleteChunkedResourceUpload(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"resource": resource})
	})
}
