// Package localcrypto owns the desktop workspace encryption format shared by
// provider settings, managed credentials and persisted generation tasks.
package localcrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const Prefix = "enc:v1:"

var keyMu sync.Mutex

func Encrypt(dataDir, value string) (string, error) {
	if value == "" {
		return "", nil
	}
	key, err := Key(dataDir)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	return Prefix + base64.RawStdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(value), nil)), nil
}

func Decrypt(dataDir, value string) (string, error) {
	if value == "" {
		return "", nil
	}
	if !strings.HasPrefix(value, Prefix) {
		return "", errors.New("本地密钥密文格式无效")
	}
	payload, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(value, Prefix))
	if err != nil {
		return "", errors.New("本地密钥密文格式无效")
	}
	// Decryption must never create a replacement key for existing ciphertext.
	key, err := readKey(filepath.Join(dataDir, ".settings-key"))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(payload) < gcm.NonceSize() {
		return "", errors.New("本地密钥密文长度无效")
	}
	plain, err := gcm.Open(nil, payload[:gcm.NonceSize()], payload[gcm.NonceSize():], nil)
	if err != nil {
		return "", errors.New("本地密钥解密失败，请检查工作区密钥")
	}
	return string(plain), nil
}

func readKey(path string) ([]byte, error) {
	key, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, errors.New("工作区密钥长度无效")
	}
	return key, nil
}

func Key(dataDir string) ([]byte, error) {
	keyMu.Lock()
	defer keyMu.Unlock()
	path := filepath.Join(dataDir, ".settings-key")
	if key, err := readKey(path); !errors.Is(err, os.ErrNotExist) {
		return key, err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return readKey(path)
	}
	if err != nil {
		return nil, err
	}
	if _, err = file.Write(key); err != nil {
		_ = file.Close()
		return nil, err
	}
	if err = file.Sync(); err != nil {
		_ = file.Close()
		return nil, err
	}
	if err = file.Close(); err != nil {
		return nil, err
	}
	return key, nil
}
