package referencestorage

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"infinite-canvas/backend/internal/outbound"
)

// Check uploads a unique tiny PNG, verifies anonymous reads, and removes it.
// It never invokes a generation provider or uploads a user's reference media.
func Check(ctx context.Context, config Config, tempDir string) error {
	if !config.Enabled {
		return errors.New("请先启用参考素材对象存储")
	}
	if err := config.Validate(); err != nil {
		return err
	}
	client := outbound.OutboundHTTPClient(time.Minute)
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	return check(ctx, config, tempDir, client)
}

func check(ctx context.Context, config Config, tempDir string, client *http.Client) (result error) {
	picture := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	if _, err := rand.Read(picture.Pix); err != nil {
		return errors.New("无法准备存储测试文件")
	}
	var content bytes.Buffer
	if err := png.Encode(&content, picture); err != nil {
		return err
	}
	file, err := os.CreateTemp(tempDir, "reference-storage-check-*.png")
	if err != nil {
		return errors.New("无法创建存储测试文件，请检查本地磁盘")
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(content.Bytes())
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		return errors.New("无法写入存储测试文件，请检查本地磁盘")
	}
	digest := sha256.Sum256(content.Bytes())
	key := fmt.Sprintf("beeftv/references/%x", digest)
	// PUT can succeed even when the read check or its response fails.
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		if err := deleteCheckObject(cleanupCtx, config, key, client); err != nil {
			if result == nil {
				result = err
			} else {
				result = fmt.Errorf("%w；%s", result, err)
			}
		}
	}()
	_, result = upload(ctx, config, file.Name(), client)
	return result
}

func deleteCheckObject(ctx context.Context, config Config, key string, client *http.Client) error {
	endpoint, err := url.JoinPath(config.Endpoint, config.Bucket, key)
	if err != nil {
		return errors.New("无法清理存储测试文件")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return errors.New("无法清理存储测试文件")
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(nil))
	request.Header.Set("X-Amz-Content-Sha256", digest)
	request.URL.Opaque = "//" + request.URL.Host + request.URL.EscapedPath()
	if err = v4.NewSigner().SignHTTP(ctx, aws.Credentials{AccessKeyID: config.AccessKeyID, SecretAccessKey: config.SecretAccessKey}, request, digest, "s3", config.Region, time.Now(), func(options *v4.SignerOptions) { options.DisableURIPathEscaping = true }); err != nil {
		return errors.New("存储测试文件清理签名失败")
	}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("存储测试文件未能清理，请检查网络和删除权限")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound && (response.StatusCode < 200 || response.StatusCode >= 300) {
		return fmt.Errorf("存储测试文件未能清理（HTTP %d），请检查删除权限", response.StatusCode)
	}
	return nil
}
