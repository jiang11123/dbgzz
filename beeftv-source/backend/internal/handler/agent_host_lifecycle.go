package handler

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantruntime"
	httptransport "infinite-canvas/backend/internal/transport/http"
)

func missingAssistantHost(c *gin.Context, host *assistantruntime.Host) bool {
	if host != nil {
		return false
	}
	c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable",
		"msg": "内置创作助手宿主未运行"})
	return true
}

// RegisterAgentHostLifecycleRoutes 暴露宿主配置与启停：全部需要 owner 凭据 + 本机同源。
// host 必须是本次路由注册持有的实例；缺失时明确失败，绝不在请求里 new 一个随后被丢掉的监督器。
func RegisterAgentHostLifecycleRoutes(r gin.IRouter, svc *app.Service, host *assistantruntime.Host) {
	ownerGuard := func(c *gin.Context) bool { return requireOwner(c, svc) }

	r.GET("/assistant/host/config", func(c *gin.Context) {
		if !ownerGuard(c) {
			return
		}
		if missingAssistantHost(c, host) {
			return
		}
		config, configured := host.EffectiveConfig()
		provider, reason := host.ResolveProvider()
		// 只回可公开的模型信息，绝不回密钥。
		ok(c, gin.H{"config": config, "configured": configured, "supervisorRunning": host.Running(),
			"provider": gin.H{"model": provider.Model, "channelId": provider.ChannelID, "protocol": provider.Protocol,
				"baseUrl": provider.BaseURL, "hasKey": provider.APIKey != "", "reason": reason}})
	})

	r.PUT("/assistant/host/config", func(c *gin.Context) {
		if !ownerGuard(c) {
			return
		}
		if missingAssistantHost(c, host) {
			return
		}
		var request assistantruntime.HostConfig
		if err := c.ShouldBindJSON(&request); err != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体无效"))
			return
		}
		if err := host.WriteConfig(request); err != nil {
			fail(c, http.StatusInternalServerError, app.BadAuthRequest("配置写入失败"))
			return
		}
		ok(c, gin.H{"config": request})
	})

	r.POST("/assistant/host/start", func(c *gin.Context) {
		if !ownerGuard(c) {
			return
		}
		if missingAssistantHost(c, host) {
			return
		}
		config, configured := host.EffectiveConfig()
		if !configured || strings.TrimSpace(config.HostCommand) == "" {
			// 命令只来自本机配置，绝不接受请求体传入的可执行命令。
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_command_missing",
				"msg": "未配置 agent-host 启动命令：请先在设置的创作助手中配置（发行形态下由产品启动链提供）"})
			return
		}
		// 请求本来就落在后端自己身上：用请求的 Host 推导操作层基址，避免猜端口；
		// 桌面形态下把请求自带的启动令牌转交给宿主。
		provider, reason := host.ResolveProvider()
		if reason != "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": reason,
				"msg": "助手模型或凭据还没准备好"})
			return
		}
		if err := host.Launch(provider, "http://"+c.Request.Host+"/api", strings.TrimSpace(c.GetHeader(httptransport.LaunchTokenHeader))); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_start_failed", "msg": err.Error()})
			return
		}
		ok(c, gin.H{"started": true, "pid": strconv.Itoa(host.PID())})
	})

	r.POST("/assistant/host/stop", func(c *gin.Context) {
		if !ownerGuard(c) {
			return
		}
		if missingAssistantHost(c, host) {
			return
		}
		if err := host.Stop(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "reason": "host_stop_failed", "msg": err.Error()})
			return
		}
		ok(c, gin.H{"stopped": true})
	})
}
