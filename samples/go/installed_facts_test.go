package sample

import (
	"errors"
	"testing"

	factkit "github.com/carlos-space/fact-kit-go"
)

// Reads the fact-kit-go entry of fact-kit-facts, installed from npm with pnpm. It needs `pnpm install` first.
func TestInstalledFactsHaveTheFactKitGoFacts(t *testing.T) {
	reader, err := factkit.ReadFacts("fact-kit-facts/fact-kit-go", factkit.ReadFactsOptions{Root: "."})
	if err != nil {
		var e *factkit.FactReadError
		code := "unknown"
		if errors.As(err, &e) {
			code = string(e.Code)
		}
		t.Fatalf("cannot read fact-kit-facts/fact-kit-go (%s). Is the package installed? Run pnpm install.", code)
	}
	if len(reader.Facts) == 0 {
		t.Fatal("the fact-kit-go entry has no facts")
	}
	for _, id := range []string{"fact-kit-go.read-facts", "fact-kit-go.read-errors"} {
		if !reader.Has(id) {
			t.Errorf("fact id %s is missing", id)
		}
	}
}
