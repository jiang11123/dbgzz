package modelcatalog

import (
	"errors"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestPrepareLogicalModelBundleRejectsBadCode(t *testing.T) {
	_, _, _, _, err := PrepareLogicalModelBundle("", LogicalModelRequest{Code: "Bad Code", Name: "Name", Capability: "text"}, LogicalBundleDeps{Now: time.Now()})
	if err == nil {
		t.Fatal("invalid code accepted")
	}
}

func TestArchiveLogicalModelGuard(t *testing.T) {
	if err := ArchiveLogicalModelGuard(nil); err == nil {
		t.Fatal("nil model accepted")
	}
	if err := ArchiveLogicalModelGuard(&model.LogicalModel{ID: "lm", SourceChannelModelID: "cm"}); err == nil {
		t.Fatal("synced model archive accepted")
	}
	if err := ArchiveLogicalModelGuard(&model.LogicalModel{ID: "lm"}); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareLogicalModelBundleRequiresEnabledRoute(t *testing.T) {
	deps := LogicalBundleDeps{
		Now:     time.Now(),
		ActorID: "admin",
		NextID:  testIDGen,
		ChannelModel: func(id string) (*model.ChannelModel, error) {
			return &model.ChannelModel{ID: id, ChannelID: "ch", Capability: "text", Enabled: true}, nil
		},
		SystemChannel: func(id string) (*model.ModelChannel, error) {
			if id == "ch" {
				return &model.ModelChannel{ID: id, Enabled: true}, nil
			}
			return nil, errors.New("missing")
		},
		LogicalModel: func(string) (*model.LogicalModel, error) { return nil, errors.New("unused") },
	}
	spec, err := NormalizeCapabilitySpec(CapabilitySpec{Version: 1, Capability: "text"})
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, _, err = PrepareLogicalModelBundle("", LogicalModelRequest{
		Code: "demo-model", Name: "Demo", Capability: "text", Enabled: true, CapabilitySpec: spec,
	}, deps)
	if err == nil {
		t.Fatal("enabled model without routes accepted")
	}
}
