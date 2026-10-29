package beefapi

import (
	"encoding/json"
	"strings"
	"time"
)

const (
	StateDisconnected    = "disconnected"
	StateConnecting      = "connecting"
	StateConnectionError = "connection_error"
	StatePending         = "pending"
	StateConnected       = "connected"
	StateExpired         = "expired"
	StateCancelled       = "cancelled"
	StateRejected        = "rejected"
	StateStoreError      = "store_error"
	StateCatalogFailed   = "catalog_failed"
	StateRevoked         = "revoked"
	BalanceUnknown       = "unknown"
	BalanceZero          = "zero"
	BalanceAvailable     = "available"
	connectionSchema     = 1
	connectionStoreFile  = "beefapi-connection.json"
)

type Account struct {
	ID          wireID `json:"id"`
	Username    string `json:"username,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
	Email       string `json:"email,omitempty"`
}

type Summary struct {
	State           string   `json:"state"`
	UserCode        string   `json:"userCode,omitempty"`
	VerificationURI string   `json:"verificationUri,omitempty"`
	ExpiresAt       string   `json:"expiresAt,omitempty"`
	Account         *Account `json:"account,omitempty"`
	KeyName         string   `json:"keyName,omitempty"`
	TokenID         string   `json:"tokenId,omitempty"`
	Market          string   `json:"market,omitempty"`
	WalletURL       string   `json:"walletUrl,omitempty"`
	Balance         string   `json:"balance,omitempty"`
	CatalogFailed   bool     `json:"catalogFailed,omitempty"`
	ErrorReason     string   `json:"errorReason,omitempty"`
	ConnectedAt     string   `json:"connectedAt,omitempty"`
	CredentialRef   string   `json:"credentialRef,omitempty"`
	HasCredential   bool     `json:"hasCredential"`
}

type Credential struct {
	APIKey    string
	BaseURL   string
	AccountID string
	TokenID   string
	KeyName   string
}

type CatalogModel struct {
	ID                       string          `json:"id"`
	DisplayName              string          `json:"displayName,omitempty"`
	ModelType                string          `json:"modelType,omitempty"`
	SupportedEndpointTypes   []string        `json:"supportedEndpointTypes,omitempty"`
	VideoCapabilities        json.RawMessage `json:"videoCapabilities,omitempty"`
	VideoCapabilitiesVersion string          `json:"videoCapabilitiesVersion,omitempty"`
	VideoPricing             json.RawMessage `json:"videoPricing,omitempty"`
}

type persistedDevice struct {
	DeviceCode              string `json:"deviceCode"`
	UserCode                string `json:"userCode"`
	VerificationURI         string `json:"verificationUri"`
	VerificationURIComplete string `json:"verificationUriComplete"`
	IntervalSeconds         int    `json:"intervalSeconds"`
	ExpiresAt               string `json:"expiresAt"`
}

type persistedState struct {
	AuthorizationOrigin     string           `json:"authorizationOrigin,omitempty"`
	SchemaVersion           int              `json:"schemaVersion"`
	Status                  string           `json:"status"`
	Device                  *persistedDevice `json:"device,omitempty"`
	EncryptedAPIKey         string           `json:"encryptedApiKey,omitempty"`
	ProviderBaseURL         string           `json:"providerBaseUrl,omitempty"`
	Market                  string           `json:"market,omitempty"`
	Group                   string           `json:"group,omitempty"`
	Account                 *Account         `json:"account,omitempty"`
	KeyName                 string           `json:"keyName,omitempty"`
	TokenID                 string           `json:"tokenId,omitempty"`
	Acked                   bool             `json:"acked"`
	CatalogOK               bool             `json:"catalogOk"`
	AssistantDefaultPending bool             `json:"assistantDefaultPending,omitempty"`
	Balance                 string           `json:"balance,omitempty"`
	LastError               string           `json:"lastError,omitempty"`
	ConnectedAt             string           `json:"connectedAt,omitempty"`
	UpdatedAt               string           `json:"updatedAt,omitempty"`
}

func (s persistedState) hasCredential() bool {
	return strings.TrimSpace(s.EncryptedAPIKey) != ""
}

func parseTime(value string) time.Time {
	if value == "" {
		return time.Time{}
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed
	}
	parsed, _ := time.Parse(time.RFC3339, value)
	return parsed
}
