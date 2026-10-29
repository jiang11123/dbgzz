package asset

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

type rangedBody struct {
	io.Reader
	closer io.Closer
}

func (b rangedBody) Close() error {
	if b.closer == nil {
		return nil
	}
	return b.closer.Close()
}

func (s *Service) Open(userID string, id string) (*model.Resource, io.ReadCloser, error) {
	stream, err := s.OpenRange(userID, id, "")
	if err != nil {
		return nil, nil, err
	}
	return stream.Resource, stream.Body, nil
}

func (s *Service) OpenRange(userID string, id string, rangeHeader string) (*ResourceStream, error) {
	if s == nil || s.repo == nil {
		return nil, ResourceMissing()
	}
	resource, err := s.repo.ResourceForUser(userID, id)
	if err != nil {
		return nil, err
	}
	return s.OpenOwnedRange(userID, resource, rangeHeader)
}

func (s *Service) OpenPublicRange(id string, rangeHeader string) (*ResourceStream, error) {
	if s == nil || s.repo == nil {
		return nil, kernel.Forbidden("匿名下载链接无效")
	}
	resource, err := s.repo.Resource(id)
	if err != nil {
		return nil, kernel.Forbidden("匿名下载链接无效")
	}
	if resource.Provider != "local" {
		return nil, kernel.Forbidden("匿名下载链接无效")
	}
	return s.OpenOwnedRange(resource.UserID, resource, rangeHeader)
}

func (s *Service) OpenOwnedRange(userID string, resource *model.Resource, rangeHeader string) (*ResourceStream, error) {
	if resource == nil {
		return nil, ResourceMissing()
	}
	if resource.Status != model.ResourceStatusReady {
		return nil, ResourceNotReady()
	}
	if resource.Provider != "local" {
		return nil, ResourceNotLocal()
	}
	if s == nil || s.blobs == nil {
		return nil, errors.New("local resource store is not initialized")
	}
	body, err := s.blobs.Open(resource.ObjectKey)
	if err != nil {
		return nil, err
	}
	info, err := body.Stat()
	if err != nil {
		_ = body.Close()
		return nil, err
	}
	size := info.Size()
	_ = userID
	normalized := NormalizeSingleByteRange(rangeHeader)
	if normalized == "" {
		return &ResourceStream{
			Resource: resource, Body: body, StatusCode: http.StatusOK,
			ContentLength: size, AcceptRanges: "bytes",
		}, nil
	}
	start, end, ok := parseNormalizedByteRange(normalized, size)
	if !ok {
		_ = body.Close()
		return &ResourceStream{
			Resource: resource, Body: io.NopCloser(bytes.NewReader(nil)),
			StatusCode: http.StatusRequestedRangeNotSatisfiable, ContentLength: 0,
			ContentRange: fmt.Sprintf("bytes */%d", size), AcceptRanges: "bytes",
		}, nil
	}
	if _, err := body.Seek(start, io.SeekStart); err != nil {
		_ = body.Close()
		return nil, err
	}
	length := end - start + 1
	return &ResourceStream{
		Resource:      resource,
		Body:          rangedBody{Reader: io.LimitReader(body, length), closer: body},
		StatusCode:    http.StatusPartialContent,
		ContentLength: length,
		ContentRange:  fmt.Sprintf("bytes %d-%d/%d", start, end, size),
		AcceptRanges:  "bytes",
	}, nil
}

func (s *Service) PrepareDelivery(userID string, id string, options ResourceDeliveryOptions) (*ResourceDelivery, error) {
	if s == nil || s.repo == nil {
		return nil, ResourceMissing()
	}
	resource, err := s.repo.ResourceForUser(userID, id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, kernel.NotFound("资源不存在")
		}
		return nil, err
	}
	return s.PrepareOwnedDelivery(userID, resource, options)
}

func (s *Service) PrepareOwnedDelivery(userID string, resource *model.Resource, options ResourceDeliveryOptions) (*ResourceDelivery, error) {
	if resource == nil {
		return nil, errors.New("资源不存在")
	}
	if resource.Status != model.ResourceStatusReady {
		return nil, ResourceNotReady()
	}
	if resource.Provider != "local" {
		return nil, ResourceNotLocal()
	}
	_ = userID
	_ = options
	return &ResourceDelivery{Resource: resource}, nil
}
