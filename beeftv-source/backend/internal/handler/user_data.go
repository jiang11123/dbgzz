package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/model"

	"github.com/gin-gonic/gin"
)

func RegisterUserDataRoutes(r *gin.RouterGroup, svc *app.Service) {
	registerUserDataRoutes(r, svc)
}

// RegisterDesktopUserDataRoutes keeps hosted object-storage controls out of
// the native app while retaining local resource and workspace CRUD.
func RegisterDesktopUserDataRoutes(r *gin.RouterGroup, svc *app.Service) {
	registerUserDataRoutes(r, svc)
}

func registerUserDataRoutes(r *gin.RouterGroup, svc *app.Service) {
	registerCanvasLibraryRoutes(r, svc)
	registerCanvasWorkflowRoutes(r, svc)
	r.POST("/assets/batch", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
		var req struct {
			IDs []string `json:"ids"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		assets, err := svc.UserAssetsByIDs(user.ID, req.IDs)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"assets": assets})
	})
	r.GET("/settings/prompt-templates", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		preferences, err := svc.UserPromptPreferences(user)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"preferences": preferences})
	})
	r.PATCH("/settings/prompt-templates/:operation", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req app.UserPromptCustomizationRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		customization, err := svc.UpdateUserPromptCustomization(user, c.Param("operation"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"customization": customization})
	})
	r.DELETE("/settings/prompt-templates/:operation", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.ResetUserPromptCustomization(user, c.Param("operation")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"ok": true})
	})
	r.GET("/resources", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		pageSize, err := parsePositiveQueryInt(c.Query("pageSize"), 200)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		resources, err := requestAssetPort(c, svc).Resources(user.ID, pageSize)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"resources": resources})
	})
	r.GET("/resources/storage-usage", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		usage, err := svc.AccountFileStorageUsage(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"usage": usage})
	})
	r.DELETE("/resources/playback-cache", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		cleared, err := svc.ClearVideoPreviewCache(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"cleared": cleared})
	})
	r.POST("/resources", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "resources-upload:"+user.ID, policy.Request.ResourceUploadPerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, (policy.Resource.ResourceUploadMB<<20)+(1<<20))
		file, err := c.FormFile("file")
		if err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				// 超 MaxBytesReader 上限时 FormFile 返回英文 http 错误，转成与 service 配额校验一致的中文文案。
				fail(c, http.StatusBadRequest, fmt.Errorf("单个上传文件必须小于 %dMB", policy.Resource.ResourceUploadMB))
				return
			}
			fail(c, http.StatusBadRequest, err)
			return
		}
		width, _ := strconv.Atoi(c.PostForm("width"))
		height, _ := strconv.Atoi(c.PostForm("height"))
		durationMs, _ := strconv.ParseInt(c.PostForm("durationMs"), 10, 64)
		resource, err := requestAssetPort(c, svc).UploadLocalResource(user.ID, file, c.PostForm("kind"), width, height, durationMs, c.GetHeader("X-Idempotency-Key"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"resource": resource})
	})
	r.GET("/resources/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		resource, err := svc.Resource(user.ID, c.Param("id"))
		if err == nil && c.Query("metadata") == "ensure" {
			resource, err = svc.EnsureResourceMediaMetadata(c.Request.Context(), user.ID, c.Param("id"))
			if err != nil {
				if errors.Is(err, context.Canceled) {
					writeFailure(c, 499, 499, "request_cancelled", "检查素材已取消")
					return
				}
				if errors.Is(err, context.DeadlineExceeded) {
					writeFailure(c, http.StatusRequestTimeout, http.StatusRequestTimeout, app.ReasonTimeout, "检查素材超时，请重试")
					return
				}
				failService(c, err)
				return
			}
		}
		if err != nil {
			fail(c, http.StatusNotFound, err)
			return
		}
		ok(c, gin.H{"resource": resource})
	})
	r.POST("/resources/:id/playback", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		resource, err := svc.PrepareResourcePlayback(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"resource": resource})
	})
	r.GET("/resources/:id/file", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		delivery, err := svc.PrepareResourceDelivery(user.ID, c.Param("id"), app.ResourceDeliveryOptions{
			ForceDirect: c.Query("direct") == "1",
			ForceProxy:  c.Query("proxy") == "1",
		})
		if err != nil {
			failService(c, err)
			return
		}
		if delivery.RedirectURL != "" {
			// CDN 或对象存储直连地址允许安全短期缓存
			c.Header("Cache-Control", "private, max-age=86400, stale-while-revalidate=3600")
			c.Header("Referrer-Policy", "no-referrer")
			c.Header("X-Content-Type-Options", "nosniff")
			c.Redirect(http.StatusTemporaryRedirect, delivery.RedirectURL)
			return
		}
		resource := delivery.Resource
		etag := resourceResponseETag(resource)
		// variant=playback：serve 浏览器兼容播放副本（H.265→H.264 转码）。
		// 副本就绪时用独立 ETag 后缀，避免浏览器拿原件缓存命中 304 而继续黑屏。
		usePlayback := c.Query("variant") == "playback" && resource.Provider == "local" &&
			resource.PlaybackStatus == model.PlaybackStatusReady && resource.PlaybackObjectKey != ""
		var stream *app.ResourceStream
		if usePlayback {
			stream, err = svc.OpenResourcePlaybackRange(user.ID, resource.ID)
			if errors.Is(err, app.ErrPlaybackNotReady) {
				usePlayback = false
			} else if err != nil {
				failService(c, err)
				return
			} else {
				defer stream.Body.Close()
				resource = stream.Resource
			}
		}
		serveETag := etag
		if usePlayback {
			serveETag = playbackResponseETag(etag)
		}
		// 资源 ID 内容不可变（上传永远生成新 ID，不会原地覆盖）：图片可以放心交给浏览器
		// 磁盘强缓存 30 天，大画布二次打开零请求直读磁盘缓存。视频/音频涉及转码副本
		// 就绪与 Range 语义，保持逐次条件请求（304）。
		if strings.HasPrefix(resource.MimeType, "image/") {
			c.Header("Cache-Control", "private, max-age=2592000, stale-while-revalidate=86400")
		} else {
			c.Header("Cache-Control", "private, no-cache")
		}
		c.Header("ETag", serveETag)
		c.Header("Accept-Ranges", "bytes")
		c.Header("X-Content-Type-Options", "nosniff")
		if resource.Kind == "file" {
			c.Header("Content-Disposition", "attachment")
			c.Header("Content-Security-Policy", "sandbox")
		}
		if ifNoneMatch(c.GetHeader("If-None-Match"), serveETag) {
			c.Status(http.StatusNotModified)
			return
		}
		rangeHeader := c.GetHeader("Range")
		if ifRange := strings.TrimSpace(c.GetHeader("If-Range")); ifRange != "" && ifRange != serveETag {
			rangeHeader = ""
		}
		if stream == nil {
			stream, err = svc.OpenResourceRange(user.ID, resource.ID, rangeHeader)
			if err != nil {
				failService(c, err)
				return
			}
			defer stream.Body.Close()
		}
		if resource.MimeType == "" {
			resource.MimeType = "application/octet-stream"
		}
		if resource.Provider == "local" {
			if seeker, ok := stream.Body.(io.ReadSeeker); ok {
				c.Header("Content-Type", resource.MimeType)
				http.ServeContent(c.Writer, c.Request, resource.ID, resource.UpdatedAt, seeker)
				return
			}
		}
		if stream.ContentRange != "" {
			c.Header("Content-Range", stream.ContentRange)
		}
		if stream.AcceptRanges != "" {
			c.Header("Accept-Ranges", stream.AcceptRanges)
		}
		c.DataFromReader(stream.StatusCode, stream.ContentLength, resource.MimeType, stream.Body, nil)
	})
	r.GET("/assets", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if _, paged := c.GetQuery("page"); paged || hasUserAssetPageFilters(c) {
			page, pageSize, pageErr := parsePaginationQuery(c, 40)
			if pageErr != nil {
				fail(c, http.StatusBadRequest, pageErr)
				return
			}
			var folderID *string
			if value, present := c.GetQuery("folderId"); present {
				folderID = &value
			}
			assets, pageErr := svc.UserAssetsPage(user.ID, page, pageSize, app.UserAssetPageFilter{
				Kind: c.Query("kind"), Category: c.Query("category"), FolderID: folderID,
				Uncategorized: queryFlag(c, "uncategorized"), Status: c.Query("status"), Query: c.Query("q"),
				Favorite: queryFlag(c, "favorite"), Recent: queryFlag(c, "recent"), Project: c.Query("project"),
				Generated: queryFlag(c, "generated"),
			})
			if pageErr != nil {
				failService(c, pageErr)
				return
			}
			ok(c, assets)
			return
		}
		assets, err := svc.UserAssetSummaries(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"assets": assets})
	})
	r.GET("/asset-folders", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		folders, err := svc.AssetFolders(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"folders": folders})
	})
	r.POST("/asset-folders", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req app.CreateAssetFolderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		folder, err := svc.CreateAssetFolder(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"folder": folder})
	})
	r.PATCH("/asset-folders/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req app.UpdateAssetFolderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		folder, err := svc.UpdateAssetFolder(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"folder": folder})
	})
	r.DELETE("/asset-folders/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.DeleteAssetFolder(user.ID, c.Param("id")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("id")})
	})
	r.PATCH("/assets/folder", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req app.MoveUserAssetsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if err := svc.MoveUserAssetsToFolder(user.ID, req); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"assetIds": req.AssetIDs, "folderId": req.FolderID})
	})
	r.GET("/user-data/snapshot", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		snapshot, err := svc.UserDataSnapshot(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, snapshot)
	})
	r.GET("/assets/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		asset, err := svc.UserAsset(user.ID, c.Param("id"))
		if err != nil {
			fail(c, http.StatusNotFound, err)
			return
		}
		ok(c, gin.H{"asset": asset})
	})
	r.PUT("/assets/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "assets-write:"+user.ID, policy.Request.AssetWritePerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 5<<20)
		var req struct {
			Asset json.RawMessage `json:"asset"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		var identity struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(req.Asset, &identity) != nil || identity.ID != c.Param("id") {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("素材 ID 与请求路径不一致"))
			return
		}
		asset, err := svc.UpsertUserAsset(user.ID, req.Asset)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"asset": asset})
	})
	r.DELETE("/assets/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.DeleteUserAsset(user.ID, c.Param("id"), strings.TrimSpace(c.Query("expectedStatus"))); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("id")})
	})
	r.GET("/canvas-projects", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if c.Query("page") != "" {
			page, pageSize, pageErr := parsePaginationQuery(c, 40)
			if pageErr != nil {
				fail(c, http.StatusBadRequest, pageErr)
				return
			}
			result, pageErr := svc.UserCanvasProjectsPage(user.ID, page, pageSize, c.Query("projectId"), c.Query("q"), c.Query("sort"))
			if pageErr != nil {
				failService(c, pageErr)
				return
			}
			ok(c, result)
			return
		}
		projects, err := svc.UserCanvasProjectSummaries(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"projects": projects})
	})
	r.GET("/canvas-projects/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		project, err := svc.UserCanvasProject(user.ID, c.Param("id"))
		if err != nil {
			fail(c, http.StatusNotFound, err)
			return
		}
		ok(c, gin.H{"project": project})
	})
	r.GET("/canvas-projects/:id/events", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		project, err := svc.UserCanvasProject(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		var initial struct {
			Revision int64 `json:"revision"`
		}
		_ = json.Unmarshal(project, &initial)
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")
		c.Header("X-Accel-Buffering", "no")
		flusher, ok := c.Writer.(http.Flusher)
		if !ok {
			return
		}
		_, _ = fmt.Fprintf(c.Writer, "event: ready\ndata: {\"revision\":%d}\n\n", initial.Revision)
		flusher.Flush()
		last := initial.Revision
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-c.Request.Context().Done():
				return
			case <-ticker.C:
				latest, readErr := svc.UserCanvasProject(user.ID, c.Param("id"))
				if readErr != nil {
					return
				}
				var state struct {
					Revision int64 `json:"revision"`
				}
				if json.Unmarshal(latest, &state) != nil || state.Revision <= last {
					continue
				}
				last = state.Revision
				_, _ = fmt.Fprintf(c.Writer, "event: canvas.updated\ndata: {\"revision\":%d}\n\n", last)
				flusher.Flush()
			}
		}
	})
	r.GET("/canvas-projects/:id/history", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		result, err := svc.CanvasHistory(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.GET("/canvas-projects/:id/history/:snapshotId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		snapshot, err := svc.CanvasHistorySnapshot(user.ID, c.Param("id"), c.Param("snapshotId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"snapshot": snapshot, "project": json.RawMessage(snapshot.PayloadJSON)})
	})
	r.POST("/canvas-projects/:id/history/:snapshotId/restore", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "canvas-write:"+user.ID, policy.Request.CanvasWritePerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024)
		var req struct {
			Revision *int64 `json:"revision"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("恢复请求格式错误"))
			return
		}
		project, err := svc.RestoreCanvasHistory(user.ID, c.Param("id"), c.Param("snapshotId"), req.Revision)
		if err != nil {
			failService(c, err)
			return
		}
		log.Printf("canvas_restore request_id=%q trace_id=%q actor=%q canvas=%q snapshot=%q base_revision=%d revision=%d", RequestID(c), TraceID(c), user.ID, c.Param("id"), c.Param("snapshotId"), *req.Revision, project.Revision)
		ok(c, gin.H{"project": project})
	})
	r.PUT("/canvas-projects/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "canvas-write:"+user.ID, policy.Request.CanvasWritePerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 5<<20)
		var req struct {
			Project json.RawMessage `json:"project"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		var identity struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(req.Project, &identity) != nil || identity.ID != c.Param("id") {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("画布 ID 与请求路径不一致"))
			return
		}
		var audit struct {
			Revision    *int64            `json:"revision"`
			Nodes       []json.RawMessage `json:"nodes"`
			Connections []json.RawMessage `json:"connections"`
		}
		_ = json.Unmarshal(req.Project, &audit)
		baseRevision := int64(-1)
		if audit.Revision != nil {
			baseRevision = *audit.Revision
		}
		project, err := svc.UpsertUserCanvasProject(user.ID, req.Project)
		defer func() {
			nodesBefore, nodesAfter := -1, len(audit.Nodes)
			if project.SaveAudit != nil {
				nodesBefore, nodesAfter = project.SaveAudit.NodesBefore, project.SaveAudit.NodesAfter
			}
			// Metadata only: never log prompts, media URLs, cookies, or the canvas payload.
			log.Printf("canvas_save request_id=%q trace_id=%q actor=%q canvas=%q base_revision=%d revision=%d nodes_before=%d nodes_after=%d connections=%d status=%d", RequestID(c), TraceID(c), user.ID, identity.ID, baseRevision, project.Revision, nodesBefore, nodesAfter, len(audit.Connections), c.Writer.Status())
		}()
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"project": project})
	})
	r.DELETE("/canvas-projects/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.DeleteUserCanvasProject(user.ID, c.Param("id")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("id")})
	})
}

func hasUserAssetPageFilters(c *gin.Context) bool {
	for _, key := range []string{"pageSize", "kind", "category", "folderId", "uncategorized", "status", "q", "favorite", "recent", "project", "generated"} {
		if _, present := c.GetQuery(key); present {
			return true
		}
	}
	return false
}

func queryFlag(c *gin.Context, key string) bool {
	value := strings.TrimSpace(c.Query(key))
	return value == "1" || strings.EqualFold(value, "true")
}

func resourceResponseETag(resource *model.Resource) string {
	value := strings.Trim(strings.TrimSpace(resource.ETag), `"`)
	if value == "" {
		value = fmt.Sprintf("%s-%d-%d", resource.ID, resource.Size, resource.UpdatedAt.UnixNano())
	}
	return strconv.Quote(value)
}

func ifNoneMatch(header string, etag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(candidate), "W/"))
		if candidate == "*" || candidate == etag {
			return true
		}
	}
	return false
}

func playbackResponseETag(original string) string {
	return strings.TrimSuffix(original, `"`) + `:pb"`
}
