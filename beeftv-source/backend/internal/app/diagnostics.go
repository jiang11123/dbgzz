package app

import (
	"infinite-canvas/backend/internal/assistantdiagnostics"
	"infinite-canvas/backend/internal/diagnostics"
)

type DiagnosticClientEvent = diagnostics.ClientEvent
type DiagnosticRuntime = diagnostics.Runtime
type DiagnosticExportRequest = diagnostics.ExportRequest
type DiagnosticPreview = diagnostics.Preview
type DiagnosticBundle = diagnostics.Bundle

type diagnosticBrand struct {
	svc *Service
}

func (b diagnosticBrand) NameAndSlug() (string, string) {
	if b.svc == nil {
		return "", ""
	}
	return b.svc.appearanceIdentity()
}

func (s *Service) DiagnosticsDomain() *diagnostics.Service {
	if s == nil {
		return diagnostics.New(diagnostics.Dependencies{})
	}
	s.diagnosticsOnce.Do(func() {
		deps := diagnostics.Dependencies{Store: s.repo, Brand: diagnosticBrand{svc: s}, Config: s}
		if s.mode == serviceModeLocal {
			deps.DataDir = s.dataDir
			deps.UpdateLogDir = s.dataDir
			deps.TraceSource = runtimeTraceSource{service: s}
			deps.AssistantEvidence = assistantdiagnostics.New(s.dataDir)
		}
		s.diagnostics = diagnostics.New(deps)
	})
	return s.diagnostics
}

func (s *Service) PreviewDiagnosticBundle(userID string, req DiagnosticExportRequest) (*DiagnosticPreview, error) {
	return s.DiagnosticsDomain().Preview(userID, req)
}

func (s *Service) ExportDiagnosticBundle(userID string, req DiagnosticExportRequest) (*DiagnosticBundle, error) {
	return s.DiagnosticsDomain().Export(userID, req)
}
