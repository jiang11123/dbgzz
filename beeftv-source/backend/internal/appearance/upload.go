package appearance

import (
	"encoding/binary"
	"fmt"
	"mime/multipart"
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/kernel"
)

func AssetMaxBytes(slot string) (int64, error) {
	switch strings.TrimSpace(slot) {
	case AssetLogo, AssetDarkLogo:
		return logoMaxBytes, nil
	case AssetPoster:
		return posterMaxBytes, nil
	case AssetVideo:
		return videoMaxBytes, nil
	default:
		return 0, kernel.BadAuthRequest("外观资源类型无效")
	}
}

func ValidateUpload(slot string, header *multipart.FileHeader) (string, error) {
	maxBytes, err := AssetMaxBytes(slot)
	if err != nil {
		return "", err
	}
	if header == nil || header.Size <= 0 || header.Size > maxBytes {
		return "", kernel.BadAuthRequest(fmt.Sprintf("%s大小必须在 %dMB 以内", assetLabel(slot), maxBytes>>20))
	}
	file, err := header.Open()
	if err != nil {
		return "", err
	}
	defer file.Close()
	buffer := make([]byte, 512)
	read, readErr := file.Read(buffer)
	if readErr != nil && read == 0 {
		return "", kernel.BadAuthRequest("外观资源内容无法读取")
	}
	mimeType := detectMIME(slot, buffer[:read], header.Size)
	if _, exists := allowedMIMETypes(slot)[mimeType]; !exists {
		return "", kernel.BadAuthRequest(assetLabel(slot) + "文件类型不受支持")
	}
	return mimeType, nil
}

func detectMIME(slot string, data []byte, fileSize int64) string {
	mimeType := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	if slot != AssetVideo || mimeType == "video/mp4" || len(data) < 12 {
		return mimeType
	}
	boxSize := int64(binary.BigEndian.Uint32(data[:4]))
	if string(data[4:8]) == "ftyp" && boxSize >= 12 && boxSize%4 == 0 && boxSize <= fileSize {
		return "video/mp4"
	}
	return mimeType
}

func allowedMIMETypes(slot string) map[string]struct{} {
	if slot == AssetVideo {
		return map[string]struct{}{"video/mp4": {}, "video/webm": {}}
	}
	return map[string]struct{}{"image/png": {}, "image/jpeg": {}, "image/webp": {}}
}

func assetLabel(slot string) string {
	switch slot {
	case AssetLogo:
		return "浅色模式品牌 Logo"
	case AssetDarkLogo:
		return "深色模式品牌 Logo"
	case AssetPoster:
		return "视频封面"
	case AssetVideo:
		return "品牌视频"
	default:
		return "外观资源"
	}
}
