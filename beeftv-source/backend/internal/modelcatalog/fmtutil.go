package modelcatalog

import (
	"encoding/json"
	"fmt"
)

type jsonNumber = json.Number

func fmtSprint(value any) string {
	return fmt.Sprint(value)
}
