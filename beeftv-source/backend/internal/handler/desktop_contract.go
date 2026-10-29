package handler

const DesktopContractVersion = 1

type DesktopCapabilities struct {
	LocalAssets   bool `json:"localAssets"`
	ProviderCalls bool `json:"providerCalls"`
}

type DesktopContract struct {
	Version      int                 `json:"contractVersion"`
	Profile      string              `json:"profile"`
	Capabilities DesktopCapabilities `json:"capabilities"`
}

func LocalDesktopContract() DesktopContract {
	return DesktopContract{
		Version: DesktopContractVersion,
		Profile: "local",
		Capabilities: DesktopCapabilities{
			LocalAssets:   true,
			ProviderCalls: true,
		},
	}
}
