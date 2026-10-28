package sample

import (
	"errors"
	"testing"

	factkit "github.com/carlos-space/fact-kit-go"
)

// The package is UNLICENSED and this repository is public, so the test checks ids and the count only and
// never prints a title or content. It needs `pnpm install` with a NODE_AUTH_TOKEN that has read:packages.
func TestPrivateFactsURLSchemeHasTheCommandFacts(t *testing.T) {
	reader, err := factkit.ReadFacts("@carlos-space/notchhub-facts/url-scheme", factkit.ReadFactsOptions{Root: "."})
	if err != nil {
		var e *factkit.FactReadError
		code := "unknown"
		if errors.As(err, &e) {
			code = string(e.Code)
		}
		t.Fatalf("cannot read @carlos-space/notchhub-facts/url-scheme (%s). Is the package installed? Run pnpm install with NODE_AUTH_TOKEN set.", code)
	}
	if len(reader.Facts) == 0 {
		t.Fatal("the url-scheme entry has no facts")
	}
	for _, id := range []string{"notchhub.command-open", "notchhub.command-clear"} {
		if !reader.Has(id) {
			t.Errorf("fact id %s is missing", id)
		}
	}
}
