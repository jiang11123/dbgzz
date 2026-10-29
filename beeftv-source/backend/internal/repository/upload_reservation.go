package repository

import (
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func resourceUploadIdentity(resource *model.Resource) string {
	if resource == nil {
		return ""
	}
	if resource.UploadKey != nil {
		if key := strings.TrimSpace(*resource.UploadKey); key != "" {
			return key
		}
	}
	return strings.TrimSpace(resource.ID)
}

func saveResourceSettlingReservation(tx *gorm.DB, resource *model.Resource) error {
	if resource == nil {
		return errors.New("resource is nil")
	}
	if err := tx.Save(resource).Error; err != nil {
		return err
	}
	identity := resourceUploadIdentity(resource)
	if identity == "" {
		return nil
	}
	held, err := lookupUploadReservationTx(tx, resource.UserID, identity)
	if err != nil {
		return err
	}
	if held != nil && held.Unattributed() {
		return nil
	}
	switch resource.Status {
	case model.ResourceStatusReady:
		return clearUploadReservationTx(tx, resource.UserID, identity)
	case model.ResourceStatusFailed:
		return releaseIdentifiedDailyUploadTx(tx, resource.UserID, "", identity, 0)
	default:
		return nil
	}
}

func settleDeletedResourceReservation(tx *gorm.DB, resource *model.Resource) error {
	identity := resourceUploadIdentity(resource)
	if identity == "" || resource == nil {
		return nil
	}
	held, err := lookupUploadReservationTx(tx, resource.UserID, identity)
	if err != nil {
		return err
	}
	if held != nil && held.Unattributed() {
		// User delete of the unfinished row is the explicit resolution: drop
		// the sentinel without refunding anonymous daily bytes.
		return clearUploadReservationTx(tx, resource.UserID, identity)
	}
	switch resource.Status {
	case model.ResourceStatusPending, model.ResourceStatusFailed:
		return releaseIdentifiedDailyUploadTx(tx, resource.UserID, "", identity, 0)
	default:
		// READY and any other consumed status drop the witness without refunding
		// daily bytes. A later orphan scan must not treat the deleted row as an
		// unused reservation.
		return clearUploadReservationTx(tx, resource.UserID, identity)
	}
}

func lookupUploadReservationTx(tx *gorm.DB, userID string, identity string) (*model.UserUploadReservation, error) {
	identity = strings.TrimSpace(identity)
	if strings.TrimSpace(userID) == "" || identity == "" {
		return nil, nil
	}
	var held model.UserUploadReservation
	err := tx.Where("user_id = ? AND identity = ?", userID, identity).First(&held).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &held, nil
}

func clearUploadReservationTx(tx *gorm.DB, userID string, identity string) error {
	identity = strings.TrimSpace(identity)
	if strings.TrimSpace(userID) == "" || identity == "" {
		return nil
	}
	return tx.Where("user_id = ? AND identity = ?", userID, identity).Delete(&model.UserUploadReservation{}).Error
}

func releaseIdentifiedDailyUploadTx(tx *gorm.DB, userID string, day string, identity string, size int64) error {
	identity = strings.TrimSpace(identity)
	if identity != "" {
		held, err := lookupUploadReservationTx(tx, userID, identity)
		if err != nil {
			return err
		}
		if held == nil {
			return nil
		}
		if held.Unattributed() {
			return nil
		}
		// Recovery may see both an orphan reservation and the session metadata.
		// The durable identity owns the amount and day; release it only once.
		day, size = held.Day, held.Size
	}
	if day == model.UploadReservationUnattributedDay {
		return nil
	}
	id := userID + ":" + day
	if err := tx.Model(&model.UserDailyUploadUsage{}).
		Where("id = ?", id).
		Updates(map[string]any{
			"bytes":      gorm.Expr("CASE WHEN bytes >= ? THEN bytes - ? ELSE 0 END", size, size),
			"updated_at": time.Now(),
		}).Error; err != nil {
		return err
	}
	if identity == "" {
		return nil
	}
	return tx.Where("user_id = ? AND identity = ?", userID, identity).Delete(&model.UserUploadReservation{}).Error
}

func settleDeletedResources(tx *gorm.DB, resources []model.Resource) error {
	for index := range resources {
		if err := settleDeletedResourceReservation(tx, &resources[index]); err != nil {
			return err
		}
	}
	return nil
}
