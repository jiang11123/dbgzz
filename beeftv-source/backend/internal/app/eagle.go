package app

import "infinite-canvas/backend/internal/eagle"

type EagleFolder = eagle.Folder
type EagleLibrary = eagle.Library
type EagleItem = eagle.Item
type EagleItemQuery = eagle.ItemQuery
type EagleAddItemRequest = eagle.AddItemRequest
type EagleCreatedItem = eagle.CreatedItem
type EagleFile = eagle.File

func (s *Service) eagleClient() *eagle.Client {
	return eagle.New()
}

func (s *Service) EagleLibrary(rawBaseURL string) (*EagleLibrary, error) {
	return s.eagleClient().Library(rawBaseURL)
}

func (s *Service) EagleItems(rawBaseURL string, query EagleItemQuery) ([]EagleItem, error) {
	return s.eagleClient().Items(rawBaseURL, query)
}

func (s *Service) OpenEagleItemFile(rawBaseURL string, itemID string) (*EagleFile, error) {
	return s.eagleClient().OpenFile(rawBaseURL, itemID)
}

func (s *Service) AddEagleItem(rawBaseURL string, request EagleAddItemRequest) (*EagleCreatedItem, error) {
	return s.eagleClient().AddItem(rawBaseURL, request)
}

func (s *Service) CreateEagleFolder(rawBaseURL string, name string, parentID string) error {
	return s.eagleClient().CreateFolder(rawBaseURL, name, parentID)
}
