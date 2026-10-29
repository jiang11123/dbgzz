package environment

import (
	_ "embed"
	"encoding/json"
)

//go:embed cases.json
var catalogJSON []byte

// This reviewed snapshot carries references only. A case cannot enable a probe
// or a repair; those are fixed Go implementations shipped with the application.
type CaseCatalog struct {
	Repository string          `json:"repository"`
	Revision   string          `json:"revision"`
	Cases      []CaseReference `json:"cases"`
}

type CaseReference struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

func catalog() CaseCatalog {
	var c CaseCatalog
	if err := json.Unmarshal(catalogJSON, &c); err != nil {
		panic("invalid embedded environment case snapshot")
	}
	return c
}
