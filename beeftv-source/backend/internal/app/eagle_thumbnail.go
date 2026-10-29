package app

func (s *Service) OpenEagleItemThumbnail(rawBaseURL string, itemID string) (*EagleFile, error) {
	return s.eagleClient().OpenThumbnail(rawBaseURL, itemID)
}
