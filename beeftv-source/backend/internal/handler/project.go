package handler

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

func RegisterProjectRoutes(r *gin.RouterGroup, svc *app.Service) {
	RegisterStyleProfileRoutes(r, svc)
	registerCanvasProductionRoutes(r, svc)
	r.GET("/project-folders", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		folders, err := svc.ListProjectFolders(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"folders": folders})
	})
	r.POST("/project-folders", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req app.CreateProjectFolderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		folder, err := svc.CreateProjectFolder(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"folder": folder})
	})
	r.GET("/voice-profiles", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		profiles, err := svc.ListVoiceProfiles(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"profiles": profiles})
	})
	r.GET("/projects", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		pageParam, hasPage := c.GetQuery("page")
		pageSizeParam, hasPageSize := c.GetQuery("pageSize")
		if !hasPage && !hasPageSize {
			projects, err := requestProjectPort(c, svc).ListProjects(user.ID)
			if err != nil {
				failService(c, err)
				return
			}
			ok(c, gin.H{"projects": projects})
			return
		}
		page, err := parsePositiveQueryInt(pageParam, 1)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		pageSize, err := parsePositiveQueryInt(pageSizeParam, 50)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		projects, err := svc.ListProjectsPage(user.ID, page, pageSize)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, projects)
	})
	r.POST("/projects", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req app.CreateProjectRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		project, err := svc.CreateProject(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"project": project})
	})
	r.POST("/projects/:id/duplicate", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		project, err := svc.DuplicateProject(user.ID, c.Param("id"))
		if err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"project": project})
	})
	r.PATCH("/projects/:id/folder", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req struct {
			FolderID string `json:"folderId"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if err := svc.MoveProjectToFolder(user.ID, c.Param("id"), req.FolderID); err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("id"), "folderId": req.FolderID})
	})
	r.GET("/projects/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		detail, err := svc.ProjectDetail(user.ID, c.Param("id"))
		if err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, detail)
	})
	r.GET("/projects/:id/core", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		core, err := svc.ProjectCore(user.ID, c.Param("id"))
		if err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, core)
	})
	r.GET("/projects/:id/overview", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		overview, err := svc.ProjectOverview(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, overview)
	})
	r.PATCH("/projects/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req app.UpdateProjectRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		project, err := svc.UpdateProject(user.ID, c.Param("id"), req)
		if err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"project": project})
	})
	r.DELETE("/projects/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.DeleteProject(user.ID, c.Param("id")); err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("id")})
	})
	r.POST("/projects/:id/units", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		var req app.CreateProjectUnitRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		unit, err := svc.CreateProjectUnit(user.ID, c.Param("id"), req)
		if err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"unit": unit})
	})
	r.GET("/projects/:id/units", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		units, err := svc.ProjectUnitSummaries(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, units)
	})
	r.GET("/projects/:id/units/:unitId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		unit, err := svc.GetProjectUnit(user.ID, c.Param("id"), c.Param("unitId"))
		if err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"unit": unit})
	})
	r.GET("/projects/:id/units/:unitId/workspace", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		workspace, err := svc.ProjectUnitWorkspace(user.ID, c.Param("id"), c.Param("unitId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, workspace)
	})
	r.POST("/projects/:id/units/import", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		// 长篇小说可能包含两千章以上，限制请求体防止滥用的同时为整本原子导入留足空间。
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<20)
		var req app.ImportProjectUnitsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		units, err := svc.ImportProjectUnits(user.ID, c.Param("id"), req)
		if err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		// 导入响应只需返回新章节标识与摘要，正文不再原样回传一次。
		for index := range units {
			units[index].SourceText = ""
		}
		ok(c, gin.H{"units": units})
	})
	r.PATCH("/projects/:id/units/reorder", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req app.ReorderProjectUnitsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if err := svc.ReorderProjectUnits(user.ID, c.Param("id"), req); err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"unitIds": req.UnitIDs})
	})
	r.PATCH("/projects/:id/units/:unitId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		var req app.UpdateProjectUnitRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		unit, err := svc.UpdateProjectUnit(user.ID, c.Param("id"), c.Param("unitId"), req)
		if err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"unit": unit})
	})
	r.DELETE("/projects/:id/units/:unitId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.DeleteProjectUnit(user.ID, c.Param("id"), c.Param("unitId")); err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("unitId")})
	})
	r.POST("/projects/:id/canvas-links", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req app.LinkCanvasUnitRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		link, err := svc.LinkCanvasUnit(user.ID, c.Param("id"), req)
		if err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"link": link})
	})
	r.DELETE("/projects/:id/canvas-links/:canvasId/units/:unitId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.UnlinkCanvasUnit(user.ID, c.Param("id"), c.Param("canvasId"), c.Param("unitId")); err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"canvasId": c.Param("canvasId"), "unitId": c.Param("unitId")})
	})
	r.DELETE("/projects/:id/canvases/:canvasId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.UnlinkCanvasProject(user.ID, c.Param("id"), c.Param("canvasId")); err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"canvasId": c.Param("canvasId")})
	})
	r.GET("/projects/:id/canvases", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		page, err := parsePositiveQueryInt(c.Query("page"), 1)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		pageSize, err := parsePositiveQueryInt(c.Query("pageSize"), 40)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		result, err := svc.ProjectCanvasesPage(user.ID, c.Param("id"), page, pageSize)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.GET("/projects/:id/assets", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		pageParam, hasPage := c.GetQuery("page")
		pageSizeParam, hasPageSize := c.GetQuery("pageSize")
		if hasPage || hasPageSize {
			page, pageErr := parsePositiveQueryInt(pageParam, 1)
			if pageErr != nil {
				fail(c, http.StatusBadRequest, pageErr)
				return
			}
			pageSize, pageSizeErr := parsePositiveQueryInt(pageSizeParam, 40)
			if pageSizeErr != nil {
				fail(c, http.StatusBadRequest, pageSizeErr)
				return
			}
			var folderID *string
			if value, present := c.GetQuery("folderId"); present {
				folderID = &value
			}
			assets, pageErr := svc.ProjectAssetsPage(user.ID, c.Param("id"), page, pageSize, c.Query("category"), c.Query("mediaType"), c.Query("status"), folderID, c.Query("q"))
			if pageErr != nil {
				failService(c, pageErr)
				return
			}
			ok(c, assets)
			return
		}
		assets, err := svc.FilterProjectAssets(user.ID, c.Param("id"), app.ProjectAssetFilter{Category: c.Query("category"), MediaType: c.Query("mediaType"), Status: c.Query("status"), Usage: c.Query("usage")})
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"assets": assets})
	})
	r.GET("/projects/:id/asset-folders", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		folders, err := svc.ProjectAssetFolders(user.ID, c.Param("id"))
		if err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"folders": folders})
	})
	r.POST("/projects/:id/asset-folders", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<10)
		var req app.CreateProjectAssetFolderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		folder, err := svc.CreateProjectAssetFolder(user.ID, c.Param("id"), req)
		if err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"folder": folder})
	})
	r.PATCH("/projects/:id/asset-folders/:folderId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<10)
		var req app.UpdateProjectAssetFolderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		folder, err := svc.UpdateProjectAssetFolder(user.ID, c.Param("id"), c.Param("folderId"), req)
		if err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"folder": folder})
	})
	r.DELETE("/projects/:id/asset-folders/:folderId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.DeleteProjectAssetFolder(user.ID, c.Param("id"), c.Param("folderId")); err != nil {
			if app.IsProjectNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("folderId")})
	})
	r.POST("/projects/:id/characters", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req app.CreateProjectCharacterRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		character, err := svc.CreateProjectCharacter(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, character)
	})
	r.GET("/projects/:id/characters/:assetId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		character, err := svc.ProjectCharacter(user.ID, c.Param("id"), c.Param("assetId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, character)
	})
	r.PATCH("/projects/:id/characters/:assetId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req app.UpdateProjectCharacterRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		character, err := svc.UpdateProjectCharacter(user.ID, c.Param("id"), c.Param("assetId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, character)
	})
	r.PUT("/projects/:id/characters/:assetId/representations", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 128<<10)
		var req app.ReplaceCharacterRepresentationsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		character, err := svc.ReplaceProjectCharacterRepresentations(user.ID, c.Param("id"), c.Param("assetId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, character)
	})
	r.PUT("/projects/:id/characters/:assetId/voice", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req app.BindCharacterVoiceRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		character, err := svc.BindProjectCharacterVoice(user.ID, c.Param("id"), c.Param("assetId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, character)
	})
	r.DELETE("/projects/:id/characters/:assetId/voice", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		character, err := svc.UnbindProjectCharacterVoice(user.ID, c.Param("id"), c.Param("assetId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, character)
	})
	r.POST("/projects/:id/assets", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req app.LinkProjectAssetRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		asset, err := svc.LinkProjectAsset(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"asset": asset})
	})
	r.DELETE("/projects/:id/assets/:assetId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.UnlinkProjectAsset(user.ID, c.Param("id"), c.Param("assetId")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("assetId")})
	})
	r.PATCH("/projects/:id/assets/:assetId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req app.UpdateProjectAssetRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		asset, err := svc.UpdateProjectAsset(user.ID, c.Param("id"), c.Param("assetId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"asset": asset})
	})
	r.POST("/projects/:id/assets/:assetId/versions", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req app.CreateAssetVersionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		version, err := svc.CreateProjectAssetVersion(user.ID, c.Param("id"), c.Param("assetId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"version": version})
	})
	r.POST("/projects/:id/workflows", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req struct {
			UnitID string `json:"unitId"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		workflow, err := svc.CreateUnitWorkflow(user.ID, c.Param("id"), req.UnitID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"workflow": workflow})
	})
	r.PATCH("/projects/:id/workflow-steps/:stepId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req app.UpdateWorkflowStepRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		step, err := svc.UpdateWorkflowStep(user.ID, c.Param("id"), c.Param("stepId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"step": step})
	})
	r.POST("/projects/:id/workflow-steps/:stepId/task-output", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req app.RegisterTaskOutputRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		step, err := svc.RegisterTaskOutput(user.ID, c.Param("id"), c.Param("stepId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"step": step})
	})
	r.POST("/projects/:id/shots", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req app.CreateProjectShotRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		shot, err := svc.CreateProjectShot(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"shot": shot})
	})
	r.PUT("/projects/:id/units/:unitId/shots", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		var req app.ReplaceProjectUnitShotsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		shots, err := svc.ReplaceProjectUnitShots(user.ID, c.Param("id"), c.Param("unitId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"shots": shots})
	})
	r.POST("/projects/:id/shots/:shotId/revisions", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req app.ShotRevisionInput
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		shot, revision, err := svc.CreateShotRevision(user.ID, c.Param("id"), c.Param("shotId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"shot": shot, "revision": revision})
	})
	r.DELETE("/projects/:id/shots/:shotId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.DeleteProjectShot(user.ID, c.Param("id"), c.Param("shotId")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"deleted": true})
	})
	r.POST("/projects/:id/shots/:shotId/assets", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req app.LinkShotAssetRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		reference, err := svc.LinkShotAsset(user.ID, c.Param("id"), c.Param("shotId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"reference": reference})
	})
	r.DELETE("/projects/:id/shots/:shotId/assets/:referenceId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.UnlinkShotAsset(user.ID, c.Param("id"), c.Param("shotId"), c.Param("referenceId")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"unlinked": true})
	})
	r.POST("/projects/:id/asset-candidates", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 512<<10)
		var req app.CreateAssetCandidatesRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		candidates, err := svc.CreateProjectAssetCandidates(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"candidates": candidates})
	})
	r.GET("/projects/:id/asset-candidates", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		page, err := parsePositiveQueryInt(c.Query("page"), 1)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		pageSize, err := parsePositiveQueryInt(c.Query("pageSize"), 100)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		result, err := svc.ProjectAssetCandidatesPage(user.ID, c.Param("id"), page, pageSize, c.Query("unitId"), c.Query("status"), c.Query("category"), c.Query("q"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.POST("/projects/:id/asset-candidates/:candidateId/confirm", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req app.ConfirmProjectAssetCandidateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		asset, err := svc.ConfirmProjectAssetCandidate(user.ID, c.Param("id"), c.Param("candidateId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"asset": asset})
	})
	r.GET("/projects/:id/chapter-apply-receipts", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		taskIDs := strings.Split(c.Query("taskIds"), ",")
		receipts, err := svc.ChapterApplyReceipts(user.ID, c.Param("id"), taskIDs)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"receipts": receipts})
	})
}

// parsePositiveQueryInt 解析列表查询里的正整数。分页和筛选查询名统一用 camelCase：page、pageSize、projectId、folderId、mediaType、unitId。
func parsePositiveQueryInt(value string, fallback int) (int, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return 0, fmt.Errorf("query parameter must be a positive integer")
	}
	return parsed, nil
}

// parsePaginationQuery 统一解析列表分页参数。
// 缺省值由具体接口声明；显式传入非正整数属于请求错误，不能悄悄变成服务层默认值，
// 否则客户端的协议问题会被掩盖，分页行为也会随服务层实现变化。
func parsePaginationQuery(c *gin.Context, fallbackPageSize int) (int, int, error) {
	page, err := parsePositiveQueryInt(c.Query("page"), 1)
	if err != nil {
		return 0, 0, fmt.Errorf("page: %w", err)
	}
	pageSize, err := parsePositiveQueryInt(c.Query("pageSize"), fallbackPageSize)
	if err != nil {
		return 0, 0, fmt.Errorf("pageSize: %w", err)
	}
	return page, pageSize, nil
}
