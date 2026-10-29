package bootstrap

import (
	"time"

	"github.com/gin-gonic/gin"
)

type Profile string

const (
	ProfileServer  Profile = "server"
	ProfileDesktop Profile = "desktop"
)

// DefaultServerListenAddr 是服务端 profile 未设置监听地址时的回环地址。
// 该 profile 没有桌面启动令牌；要让局域网或 Compose 网络访问，必须显式设置 CANVAS_BACKEND_ADDR。
const DefaultServerListenAddr = "127.0.0.1:8080"

type Config struct {
	Profile          Profile
	DataDir          string
	DatabaseDriver   string
	DatabaseURL      string
	ListenAddr       string
	LaunchToken      string
	AutoMigrate      bool
	ShutdownTimeout  time.Duration
	RouterMiddleware []gin.HandlerFunc
}

func (c Config) withDefaults() Config {
	if c.Profile == "" {
		c.Profile = ProfileServer
	}
	if c.DatabaseDriver == "" {
		c.DatabaseDriver = "sqlite"
	}
	if c.ListenAddr == "" {
		if c.Profile == ProfileDesktop {
			c.ListenAddr = "127.0.0.1:0"
		} else {
			c.ListenAddr = DefaultServerListenAddr
		}
	}
	if c.ShutdownTimeout <= 0 {
		c.ShutdownTimeout = 10 * time.Minute
	}
	return c
}
