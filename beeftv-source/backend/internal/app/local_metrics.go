package app

// recordActivity is retained as a no-op domain hook because canvas and task
// code report meaningful actions through the same interface. Local BeefTV does
// not persist SaaS engagement analytics.
func (s *Service) recordActivity(string, string, int) {}
