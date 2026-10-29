package referencestorage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"infinite-canvas/backend/internal/outbound"
)

func Upload(ctx context.Context, config Config, path string, observers ...func(int64, int64, string)) (string, error) {
	if !config.Enabled {
		return "", errors.New("尚未启用参考素材对象存储")
	}
	if err := config.Validate(); err != nil {
		return "", err
	}
	client := outbound.OutboundHTTPClient(10 * time.Minute)
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	return upload(ctx, config, path, client, observers...)
}

func upload(ctx context.Context, config Config, path string, client *http.Client, observers ...func(int64, int64, string)) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return "", err
	}
	observe := func(loaded int64, phase string) {
		if len(observers) > 0 && observers[0] != nil {
			observers[0](loaded, stat.Size(), phase)
		}
	}
	observe(0, "preparing")
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return "", err
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	sample := make([]byte, 512)
	n, _ := file.Read(sample)
	contentType := http.DetectContentType(sample[:n])
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	key := "beeftv/references/" + digest
	endpoint, err := url.JoinPath(config.Endpoint, config.Bucket, key)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, &uploadReader{Reader: file, total: stat.Size(), observe: observe})
	if err != nil {
		return "", err
	}
	request.ContentLength = stat.Size()
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("X-Amz-Content-Sha256", digest)
	request.URL.Opaque = "//" + request.URL.Host + request.URL.EscapedPath()
	credentials := aws.Credentials{AccessKeyID: config.AccessKeyID, SecretAccessKey: config.SecretAccessKey}
	if err = v4.NewSigner().SignHTTP(ctx, credentials, request, digest, "s3", config.Region, time.Now(), func(options *v4.SignerOptions) { options.DisableURIPathEscaping = true }); err != nil {
		return "", errors.New("对象存储请求签名失败")
	}
	response, err := client.Do(request)
	if err != nil {
		return "", errors.New("对象存储上传失败，请检查端点和网络")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("对象存储拒绝上传（HTTP %d），请检查区域、密钥和存储桶权限", response.StatusCode)
	}
	observe(stat.Size(), "processing")
	publicURL, err := url.JoinPath(config.PublicBaseURL, key)
	if err != nil {
		return "", err
	}
	// A successful PUT does not prove the URL is readable without credentials.
	probe, err := http.NewRequestWithContext(ctx, http.MethodGet, publicURL, nil)
	if err != nil {
		return "", err
	}
	probe.Header.Set("Range", "bytes=0-511")
	check, err := client.Do(probe)
	if err != nil {
		return "", errors.New("素材已上传，但公网地址无法访问，请检查公开读取设置")
	}
	defer check.Body.Close()
	if check.StatusCode != http.StatusOK && check.StatusCode != http.StatusPartialContent {
		return "", fmt.Errorf("素材已上传，但公网地址不可读取（HTTP %d），请检查公开读取设置", check.StatusCode)
	}
	first := make([]byte, n)
	if n == 0 {
		return "", errors.New("参考素材文件为空")
	}
	if _, err := io.ReadFull(check.Body, first); err != nil || !bytes.Equal(first, sample[:n]) {
		return "", errors.New("公网地址未返回上传的素材，请检查地址与存储桶的对应关系")
	}
	return publicURL, nil
}

type uploadReader struct {
	io.Reader
	loaded, total int64
	last          time.Time
	observe       func(int64, string)
}

func (r *uploadReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.loaded += int64(n)
	if err != nil || r.loaded == r.total || time.Since(r.last) >= 300*time.Millisecond {
		r.last = time.Now()
		phase := "transferring"
		if r.loaded == r.total {
			phase = "processing"
		}
		r.observe(r.loaded, phase)
	}
	return n, err
}
