package supporttrace

import (
	"regexp"
	"strings"
)

var identifier = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$`)
var machineName = regexp.MustCompile(`^[a-z][a-z0-9_.]{0,95}$`)

func safeValue(value string, machine bool) string {
	valid := identifier.MatchString(value)
	if machine {
		valid = machineName.MatchString(value)
	}
	if !valid {
		return ""
	}
	lower := strings.ToLower(value)
	for _, marker := range []string{"password", "secret", "authorization", "bearer", "api_key", "access_token", "refresh_token"} {
		if strings.Contains(lower, marker) {
			return ""
		}
	}
	if strings.HasPrefix(lower, "sk-") || strings.HasPrefix(lower, "sk_") || strings.HasPrefix(value, "eyJ") {
		return ""
	}
	return value
}

func cleanFields(fields Fields) Fields {
	return Fields{
		UserID: safeValue(fields.UserID, false), RequestID: safeValue(fields.RequestID, false),
		TaskID: safeValue(fields.TaskID, false), CanvasID: safeValue(fields.CanvasID, false),
		NodeID: safeValue(fields.NodeID, false), SessionID: safeValue(fields.SessionID, false),
		TurnID: safeValue(fields.TurnID, false), OperationID: safeValue(fields.OperationID, false),
		Reason: safeValue(fields.Reason, true),
	}
}

func mergeFields(parent, fields Fields) Fields {
	dst := []*string{&parent.UserID, &parent.RequestID, &parent.TaskID, &parent.CanvasID, &parent.NodeID, &parent.SessionID, &parent.TurnID, &parent.OperationID, &parent.Reason}
	src := []string{fields.UserID, fields.RequestID, fields.TaskID, fields.CanvasID, fields.NodeID, fields.SessionID, fields.TurnID, fields.OperationID, fields.Reason}
	for i, value := range src {
		if value != "" {
			*dst[i] = value
		}
	}
	return parent
}
