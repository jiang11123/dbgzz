package main

import (
	"context"
	"errors"
	"os"

	"infinite-canvas/backend/internal/skillhubcli"
)

func runSkills(args []string) error {
	err := skillhubcli.Run(context.Background(), args, os.Stdout)
	var failure *skillhubcli.Error
	if errors.As(err, &failure) {
		var details map[string]any
		if failure.RetryAfter != "" {
			details = map[string]any{"retryAfter": failure.RetryAfter}
		}
		return &cliError{code: failure.Code, reason: failure.Reason, msg: failure.Message, details: details}
	}
	return err
}
