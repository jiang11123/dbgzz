// Package asset owns durable local resource storage: upload identity, staged
// file publication, SQLite metadata, range reads, and deletion with live
// reference guards. FileStore is the only filesystem owner. This package must
// not import internal/app.
//
// Store, RetryOwned, and RecoverOwned are the canonical write seams. They
// serialize every Service that shares a FileStore root on user-scoped
// upload/resource keys, load persisted owner rows before mutation, and never
// trust a caller-supplied Resource. Generation adapters should call
// RecoverOwned so READY+bytes can replay, PENDING/FAILED+bytes can finalize
// without a download, and missing bytes restore only from the original
// provider result. A second handle cannot reclaim an in-flight PENDING write.
package asset
