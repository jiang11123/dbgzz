package model

import "time"

type User struct {
	ID          string     `json:"id" gorm:"primaryKey;size:36"`
	Username    string     `json:"username" gorm:"size:80"`
	DisplayName string     `json:"displayName" gorm:"size:80"`
	Role        UserRole   `json:"role" gorm:"size:24"`
	Status      UserStatus `json:"status" gorm:"size:24"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}
