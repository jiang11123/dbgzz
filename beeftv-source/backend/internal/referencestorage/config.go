package referencestorage

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"infinite-canvas/backend/internal/localcrypto"
	"infinite-canvas/backend/internal/outbound"
)

type Config struct {
	Enabled         bool   `json:"enabled"`
	Endpoint        string `json:"endpoint"`
	Bucket          string `json:"bucket"`
	Region          string `json:"region"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	PublicBaseURL   string `json:"publicBaseURL"`
}

type PublicConfig struct {
	Enabled       bool   `json:"enabled"`
	Endpoint      string `json:"endpoint"`
	Bucket        string `json:"bucket"`
	Region        string `json:"region"`
	AccessKeyID   string `json:"accessKeyId"`
	HasSecret     bool   `json:"hasSecret"`
	PublicBaseURL string `json:"publicBaseURL"`
}

func (c Config) Public() PublicConfig {
	return PublicConfig{c.Enabled, c.Endpoint, c.Bucket, c.Region, c.AccessKeyID, c.SecretAccessKey != "", c.PublicBaseURL}
}

func Load(dir string) (Config, error) {
	body, err := os.ReadFile(filepath.Join(dir, "reference-storage.json"))
	if errors.Is(err, os.ErrNotExist) {
		return Config{Region: "auto"}, nil
	}
	if err != nil {
		return Config{}, err
	}
	var envelope struct {
		EncryptedConfig string `json:"encryptedConfig"`
	}
	if err = json.Unmarshal(body, &envelope); err != nil || envelope.EncryptedConfig == "" {
		return Config{}, errors.New("对象存储配置损坏")
	}
	plain, err := localcrypto.Decrypt(dir, envelope.EncryptedConfig)
	if err != nil {
		return Config{}, errors.New("对象存储配置无法解密")
	}
	var config Config
	err = json.Unmarshal([]byte(plain), &config)
	return config, err
}

func Save(dir string, config Config) (PublicConfig, error) {
	previous, err := Load(dir)
	if err != nil {
		return PublicConfig{}, err
	}
	if config.SecretAccessKey == "" {
		if previous.AccessKeyID != config.AccessKeyID && previous.SecretAccessKey != "" {
			return PublicConfig{}, errors.New("更换 Access Key 后请填写对应 Secret Key")
		}
		config.SecretAccessKey = previous.SecretAccessKey
	}
	config.Endpoint = strings.TrimSpace(config.Endpoint)
	config.Bucket = strings.TrimSpace(config.Bucket)
	config.PublicBaseURL = strings.TrimRight(strings.TrimSpace(config.PublicBaseURL), "/")
	if config.Region == "" {
		config.Region = "auto"
	}
	if config.Enabled {
		if err := config.Validate(); err != nil {
			return PublicConfig{}, err
		}
	}
	plain, err := json.Marshal(config)
	if err != nil {
		return PublicConfig{}, err
	}
	encrypted, err := localcrypto.Encrypt(dir, string(plain))
	if err != nil {
		return PublicConfig{}, err
	}
	body, err := json.Marshal(map[string]string{"encryptedConfig": encrypted})
	if err != nil {
		return PublicConfig{}, err
	}
	file, err := os.CreateTemp(dir, ".reference-storage-*")
	if err != nil {
		return PublicConfig{}, err
	}
	path := file.Name()
	defer os.Remove(path)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(body)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return PublicConfig{}, err
	}
	if closeErr != nil {
		return PublicConfig{}, closeErr
	}
	if err = os.Rename(path, filepath.Join(dir, "reference-storage.json")); err != nil {
		return PublicConfig{}, err
	}
	return config.Public(), nil
}

var bucketName = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

func (c Config) Validate() error {
	if !bucketName.MatchString(c.Bucket) || c.AccessKeyID == "" || c.SecretAccessKey == "" || c.Region == "" {
		return errors.New("请填写存储桶、区域和完整访问密钥")
	}
	for _, address := range []string{c.Endpoint, c.PublicBaseURL} {
		parsed, err := outbound.ValidateOutboundURL(address)
		if err != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return errors.New("对象存储端点和公网地址须为可访问的地址，不含认证信息或查询参数")
		}
		if parsed.Scheme == "https" {
			continue
		}
		if parsed.Scheme == "http" && outbound.HostAllowsLocalHTTP(context.Background(), parsed.Hostname()) {
			continue
		}
		return errors.New("对象存储端点和公网地址须为 HTTPS；仅本机、局域网或 CGNAT 地址可使用 HTTP。云端模型无法拉取局域网链接")
	}
	return nil
}
