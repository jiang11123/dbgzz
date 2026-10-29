package appearance

// ReferencedIDs reports which of the given resource IDs are currently bound to
// the appearance document. Invalid JSON fails closed: every candidate is treated
// as referenced so cleanup cannot delete brand assets whose document cannot be
// read.
func (s *Service) ReferencedIDs(resourceIDs []string) map[string]struct{} {
	result := make(map[string]struct{})
	_, value, err := s.read()
	if err != nil {
		for _, resourceID := range resourceIDs {
			result[resourceID] = struct{}{}
		}
		return result
	}
	wanted := make(map[string]struct{}, len(resourceIDs))
	for _, resourceID := range resourceIDs {
		wanted[resourceID] = struct{}{}
	}
	for _, candidate := range referencedIDs(value) {
		if candidate == "" {
			continue
		}
		if _, exists := wanted[candidate]; exists {
			result[candidate] = struct{}{}
		}
	}
	return result
}
