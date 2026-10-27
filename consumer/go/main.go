// Consumer harness for the Go reader: runs the shared samples of conformance/ against the module that go
// resolved, through its public API only. run.sh writes the go.mod that names the module (a registry version, or
// a local copy through replace) and this program prints which one was linked in. FACT_KIT_CONFORMANCE names the
// conformance/ directory.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"slices"
	"unicode/utf16"

	factkit "github.com/carlos-space/fact-kit-go"
)

const modulePath = "github.com/carlos-space/fact-kit-go"

func readJSON(path string) any {
	data, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		panic(fmt.Sprintf("%s: %v", path, err))
	}
	return v
}

func subdirs(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		panic(err)
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	slices.Sort(names)
	return names
}

// equal compares two decoded JSON values as JS does: numbers by value, a boolean never equal to a number,
// objects without regard to the order of keys.
func equal(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	case []any:
		y, ok := b.([]any)
		return ok && slices.EqualFunc(x, y, equal)
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			w, found := y[k]
			if !found || !equal(v, w) {
				return false
			}
		}
		return true
	}
	return false
}

func less16(a, b string) bool {
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b))) < 0
}

// outcome is what a reader returned, in the shape of expected.json, or the code of the error.
func outcome(facts []factkit.SelectedFact, err error) any {
	if err != nil {
		var e *factkit.FactReadError
		if !errors.As(err, &e) {
			panic(fmt.Sprintf("not a *FactReadError: %v", err))
		}
		return map[string]any{"error": string(e.Code)}
	}
	sorted := slices.Clone(facts)
	slices.SortFunc(sorted, func(a, b factkit.SelectedFact) int {
		switch {
		case less16(a.ID, b.ID):
			return -1
		case less16(b.ID, a.ID):
			return 1
		}
		return 0
	})
	list := []any{}
	for _, f := range sorted {
		item := map[string]any{"id": f.ID, "content": f.Content, "since": f.Since}
		if f.Stability != "" {
			item["stability"] = f.Stability
		}
		list = append(list, item)
	}
	return map[string]any{"facts": list}
}

type query struct {
	Spec     string   `json:"spec"`
	Version  *string  `json:"version"`
	Include  []string `json:"include"`
	Platform string   `json:"platform"`
	OS       string   `json:"os"`
}

func readQuery(path string) query {
	data, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	var q query
	if err := json.Unmarshal(data, &q); err != nil {
		panic(fmt.Sprintf("%s: %v", path, err))
	}
	return q
}

func main() {
	root := os.Getenv("FACT_KIT_CONFORMANCE")
	if root == "" {
		fmt.Fprintln(os.Stderr, "FACT_KIT_CONFORMANCE is not set")
		os.Exit(1)
	}
	var failures []string
	check := func(name string, got, want any) {
		if !equal(got, want) {
			g, _ := json.Marshal(got)
			w, _ := json.Marshal(want)
			failures = append(failures, fmt.Sprintf("%s\n  got      %s\n  expected %s", name, g, w))
		}
	}

	cases := subdirs(filepath.Join(root, "cases"))
	for _, name := range cases {
		dir := filepath.Join(root, "cases", name)
		q := readQuery(filepath.Join(dir, "query.json"))
		index, err := os.ReadFile(filepath.Join(dir, "index.json"))
		if err != nil {
			panic(err)
		}
		facts, err := factkit.SelectFacts(index, factkit.SelectOptions{
			Version: q.Version, Include: q.Include, Platform: q.Platform, OS: q.OS,
		})
		check("cases/"+name, outcome(facts, err), readJSON(filepath.Join(dir, "expected.json")))
	}

	resolves := subdirs(filepath.Join(root, "resolve"))
	for _, name := range resolves {
		dir := filepath.Join(root, "resolve", name)
		q := readQuery(filepath.Join(dir, "query.json"))
		reader, err := factkit.ReadFacts(q.Spec, factkit.ReadFactsOptions{
			Root: filepath.Join(dir, "root"), Version: q.Version, Include: q.Include, Platform: q.Platform, OS: q.OS,
		})
		var facts []factkit.SelectedFact
		if err == nil {
			facts = reader.Facts
		}
		check("resolve/"+name, outcome(facts, err), readJSON(filepath.Join(dir, "expected.json")))
	}

	compares, lines := 0, 0
	entries, _ := readJSON(filepath.Join(root, "semver.json")).([]any)
	for _, raw := range entries {
		e := raw.(map[string]any)
		if a, isCompare := e["a"].(string); isCompare {
			b := e["b"].(string)
			compares++
			got, err := factkit.CompareVersions(a, b)
			if err != nil {
				got = 99
			}
			check(fmt.Sprintf("semver/%s vs %s", a, b), float64(got), e["expected"])
			continue
		}
		version, line := e["version"].(string), e["line"].(string)
		lines++
		got, err := factkit.ReleaseLine(version)
		if err != nil {
			got = "error: " + err.Error()
		}
		check("semver/line "+version, got, line)
	}

	// a harness that read nothing proves nothing
	if len(cases) < 80 || len(resolves) < 15 || compares <= 50 || lines <= 5 {
		failures = append(failures, fmt.Sprintf("too few samples in %s: %d cases, %d resolve, %d compares, %d lines",
			root, len(cases), len(resolves), compares, lines))
	}

	fmt.Printf("conformance: %s\n", root)
	fmt.Printf("samples: %d cases, %d resolve, %d version comparisons, %d release lines\n", len(cases), len(resolves), compares, lines)
	linked := false
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path != modulePath {
				continue
			}
			linked = true
			fmt.Printf("source: module %s %s (go.sum %s)\n", dep.Path, dep.Version, dep.Sum)
			if dep.Replace != nil {
				fmt.Printf("source: replaced by %s %s\n", dep.Replace.Path, dep.Replace.Version)
			}
		}
	}
	if !linked {
		failures = append(failures, modulePath+" is not among the modules linked into this program")
	}
	if len(failures) > 0 {
		fmt.Fprintf(os.Stderr, "FAILED: %d\n", len(failures))
		for _, f := range failures {
			fmt.Fprintln(os.Stderr, f)
		}
		os.Exit(1)
	}
	fmt.Println("ok: every sample matches expected.json")
}
