package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/skillhub"
	"infinite-canvas/backend/internal/skills"
)

func marketReply(c *gin.Context, value any, err error) {
	if err != nil {
		var remote *skillhub.Error
		if errors.As(err, &remote) {
			status := remote.Status
			if status < 400 || status > 599 {
				status = 502
			}
			if remote.RetryAfter != "" {
				c.Header("Retry-After", remote.RetryAfter)
			}
			c.JSON(status, gin.H{"code": status, "msg": remote.Error(), "reason": remote.Reason})
			return
		}
		failService(c, err)
		return
	}
	ok(c, value)
}
func registerSkillMarketRoutes(r *gin.RouterGroup, svc *app.Service) {
	m := r.Group("/skills/market")
	m.Use(func(c *gin.Context) {
		user, e := currentUser(c, svc)
		if e != nil {
			failService(c, e)
			c.Abort()
			return
		}
		c.Set("skill-market-owner", user.ID)
	})
	owner := func(c *gin.Context) string { return c.GetString("skill-market-owner") }
	m.GET("/search", func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		size, _ := strconv.Atoi(c.DefaultQuery("pageSize", "20"))
		value, err := svc.SkillsDomain().MarketSearch(c.Request.Context(), c.Query("q"), page, size)
		marketReply(c, value, err)
	})
	m.GET("/catalog", func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		size, _ := strconv.Atoi(c.DefaultQuery("pageSize", "20"))
		if page < 1 {
			page = 1
		}
		if size < 1 || size > 100 {
			size = 20
		}
		v, e := svc.SkillsDomain().MarketCatalog(c.Request.Context(), c.Query("q"), page, size)
		marketReply(c, v, e)
	})
	m.GET("/releases/:skillId/:releaseId", func(c *gin.Context) {
		v, e := svc.SkillsDomain().MarketRelease(c.Request.Context(), c.Param("skillId"), c.Param("releaseId"))
		marketReply(c, v, e)
	})
	m.GET("/releases/:skillId/:releaseId/file", func(c *gin.Context) {
		offset, err := strconv.Atoi(c.DefaultQuery("offset", "0"))
		if err != nil {
			marketReply(c, nil, app.BadAuthRequest("文件读取范围无效"))
			return
		}
		value, err := svc.SkillsDomain().MarketFile(c.Request.Context(), c.Param("skillId"), c.Param("releaseId"), c.Query("path"), offset, 32<<10)
		marketReply(c, value, err)
	})
	m.POST("/install", func(c *gin.Context) {
		var a struct {
			SkillID   string `json:"skillId"`
			ReleaseID string `json:"releaseId"`
		}
		if e := c.ShouldBindJSON(&a); e != nil {
			marketReply(c, nil, app.BadAuthRequest("请选择技能版本"))
			return
		}
		v, e := svc.SkillsDomain().InstallMarket(c.Request.Context(), owner(c), a.SkillID, a.ReleaseID)
		marketReply(c, gin.H{"skill": v}, e)
	})
	m.GET("/versions/:skillId", func(c *gin.Context) {
		v, e := svc.SkillsDomain().MarketVersions(owner(c), c.Param("skillId"))
		marketReply(c, gin.H{"versions": v}, e)
	})
	m.POST("/fork", func(c *gin.Context) {
		var a struct {
			SkillID string `json:"skillId"`
		}
		if e := c.ShouldBindJSON(&a); e != nil {
			marketReply(c, nil, app.BadAuthRequest("请选择技能"))
			return
		}
		v, e := svc.SkillsDomain().ForkMarket(owner(c), a.SkillID)
		marketReply(c, gin.H{"skill": v}, e)
	})
	m.POST("/rollback", func(c *gin.Context) {
		var a struct {
			SkillID   string `json:"skillId"`
			VersionID string `json:"versionId"`
		}
		if e := c.ShouldBindJSON(&a); e != nil {
			marketReply(c, nil, app.BadAuthRequest("请选择要恢复的版本"))
			return
		}
		v, e := svc.SkillsDomain().RollbackMarket(owner(c), a.SkillID, a.VersionID)
		marketReply(c, gin.H{"skill": v}, e)
	})
	m.POST("/authorization/start", func(c *gin.Context) {
		v, e := svc.SkillsDomain().MarketAuthorization(c.Request.Context(), owner(c), true)
		marketReply(c, v, e)
	})
	m.GET("/authorization", func(c *gin.Context) {
		v, e := svc.SkillsDomain().MarketAuthorization(c.Request.Context(), owner(c), false)
		marketReply(c, v, e)
	})
	m.DELETE("/authorization", func(c *gin.Context) {
		e := svc.SkillsDomain().MarketDisconnect(c.Request.Context(), owner(c))
		marketReply(c, gin.H{"connected": false}, e)
	})
	m.GET("/submissions", func(c *gin.Context) {
		v, e := svc.SkillsDomain().MarketSubmissions(c.Request.Context(), owner(c))
		marketReply(c, v, e)
	})
	m.GET("/publish-plans", func(c *gin.Context) {
		v, e := svc.SkillsDomain().PublishPlans(owner(c))
		marketReply(c, gin.H{"items": v}, e)
	})
	m.POST("/publish-plans", func(c *gin.Context) {
		var a struct {
			skills.PublicationTarget
			SkillID      string            `json:"skillId"`
			SourcePlanID string            `json:"sourcePlanId"`
			Metadata     skillhub.Metadata `json:"metadata"`
		}
		if e := c.ShouldBindJSON(&a); e != nil {
			marketReply(c, nil, app.BadAuthRequest("请填写投稿信息"))
			return
		}
		var v *skills.PublishPlan
		var e error
		if a.SourcePlanID != "" {
			v, e = svc.SkillsDomain().PublishReprepare(owner(c), a.SourcePlanID, a.Metadata, a.PublicationTarget)
		} else {
			v, e = svc.SkillsDomain().PublishPrepare(owner(c), a.SkillID, a.Metadata, a.PublicationTarget)
		}
		marketReply(c, v, e)
	})
	m.GET("/publish-plans/:id", func(c *gin.Context) {
		v, e := svc.SkillsDomain().PublishPlan(owner(c), c.Param("id"))
		marketReply(c, v, e)
	})
	m.POST("/publish-plans/:id/refresh", func(c *gin.Context) {
		v, e := svc.SkillsDomain().RefreshPublication(c.Request.Context(), owner(c), c.Param("id"))
		marketReply(c, v, e)
	})
	m.POST("/publish-plans/:id/upload", func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
		var a struct {
			Confirmed     bool   `json:"confirmed"`
			ArchiveSHA256 string `json:"archiveSha256"`
		}
		if e := c.ShouldBindJSON(&a); e != nil || !a.Confirmed {
			marketReply(c, nil, app.BadAuthRequest("请先确认本次上传的文件"))
			return
		}
		v, e := svc.SkillsDomain().PublishUpload(c.Request.Context(), owner(c), c.Param("id"), a.ArchiveSHA256)
		marketReply(c, v, e)
	})
	m.POST("/publish-plans/:id/submit", func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
		var a struct {
			Confirmed     bool   `json:"confirmed"`
			Revision      int64  `json:"revision"`
			PreviewDigest string `json:"previewDigest"`
		}
		if e := c.ShouldBindJSON(&a); e != nil || !a.Confirmed {
			marketReply(c, nil, app.BadAuthRequest("请先确认本次公开的内容"))
			return
		}
		v, e := svc.SkillsDomain().PublishSubmit(c.Request.Context(), owner(c), c.Param("id"), a.Revision, a.PreviewDigest)
		marketReply(c, v, e)
	})
}
