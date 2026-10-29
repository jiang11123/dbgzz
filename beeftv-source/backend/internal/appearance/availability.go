package appearance

import (
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) resolveAvailable(value Setting) Setting {
	for _, slot := range []string{AssetLogo, AssetDarkLogo, AssetVideo, AssetPoster} {
		id := resourceID(value, slot)
		if id == "" || s.assetAvailable(slot, id) {
			continue
		}
		switch slot {
		case AssetLogo:
			value.LogoResourceID = ""
		case AssetDarkLogo:
			value.DarkLogoResourceID = ""
		case AssetVideo:
			value.AuthVideoResourceID = ""
		case AssetPoster:
			value.AuthVideoPosterResourceID = ""
		}
	}
	return value
}

func (s *Service) assetAvailable(slot string, resourceID string) bool {
	if s == nil || s.resources == nil {
		return false
	}
	resource, err := s.resources.Resource(resourceID)
	if err != nil || validateResourceType(slot, resource) != nil {
		return false
	}
	if resource.Provider != "local" {
		return true
	}
	if s.files == nil {
		return false
	}
	return s.files.Exists(resource.ObjectKey)
}

func (s *Service) validateResource(actor *model.User, slot string, resourceID string, currentID string) error {
	if resourceID == "" {
		return nil
	}
	if s == nil || s.resources == nil {
		return kernel.BadAuthRequest("选择的外观资源不存在")
	}
	resource, err := s.resources.Resource(resourceID)
	if err != nil {
		return kernel.BadAuthRequest("选择的外观资源不存在")
	}
	if resourceID != currentID && (actor == nil || resource.UserID != actor.ID) {
		return kernel.Forbidden("只能使用当前管理员上传的外观资源")
	}
	return validateResourceType(slot, resource)
}

func validateResourceType(slot string, resource *model.Resource) error {
	if resource == nil || resource.Status != model.ResourceStatusReady {
		return kernel.BadAuthRequest("外观资源尚未上传完成")
	}
	mimeType := strings.ToLower(strings.TrimSpace(strings.Split(resource.MimeType, ";")[0]))
	allowed := allowedMIMETypes(slot)
	if _, exists := allowed[mimeType]; !exists {
		return kernel.BadAuthRequest("外观资源文件类型不受支持")
	}
	if slot == AssetVideo && resource.Kind != "video" {
		return kernel.BadAuthRequest("登录页品牌视频必须是视频资源")
	}
	if slot != AssetVideo && resource.Kind != "image" {
		return kernel.BadAuthRequest("Logo 和视频封面必须是图片资源")
	}
	return nil
}
