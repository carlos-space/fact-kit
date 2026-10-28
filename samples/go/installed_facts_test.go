package sample

import (
	"errors"
	"testing"

	factkit "github.com/carlos-space/fact-kit-go"
)

// Reads the private @carlos-space/fact-kit-sample-facts (samples/sample-facts), installed with pnpm from GitHub
// Packages. It needs `pnpm install` with NODE_AUTH_TOKEN set (see README.md).
func TestInstalledPrivateFactsAreRead(t *testing.T) {
	reader, err := factkit.ReadFacts("@carlos-space/fact-kit-sample-facts/sample", factkit.ReadFactsOptions{Root: "."})
	if err != nil {
		var e *factkit.FactReadError
		code := "unknown"
		if errors.As(err, &e) {
			code = string(e.Code)
		}
		t.Fatalf("cannot read @carlos-space/fact-kit-sample-facts/sample (%s). Is the package installed? Run pnpm install with NODE_AUTH_TOKEN set.", code)
	}
	if got, err := reader.Value("fact-kit-sample.greeting"); err != nil || got != "hello from a private facts package" {
		t.Errorf("fact-kit-sample.greeting = %v, %v", got, err)
	}
	if got, err := reader.Value("fact-kit-sample.max-retries"); err != nil || got != float64(3) {
		t.Errorf("fact-kit-sample.max-retries = %v, %v", got, err)
	}
}
