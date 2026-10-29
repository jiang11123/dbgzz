package beefapi

import "infinite-canvas/backend/internal/localcrypto"

const encryptedSecretPrefix = localcrypto.Prefix

func encryptSecret(dataDir, value string) (string, error) {
	return localcrypto.Encrypt(dataDir, value)
}

func decryptSecret(dataDir, value string) (string, error) {
	return localcrypto.Decrypt(dataDir, value)
}
