package plugins

// AccessError is a caller-facing authorization failure. Host adapters map it
// onto the HTTP forbidden contract without the domain importing internal/app.
type AccessError struct {
	Message string
}

func (e *AccessError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func Forbidden(message string) error {
	return &AccessError{Message: message}
}
