package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"hoverdeck/internal/hvr"
)

func newApp(t *testing.T) *App {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	return &App{settings: &Settings{}}
}

func TestCreateFileAddsHvrExtensionAndTemplate(t *testing.T) {
	a := newApp(t)
	dir := t.TempDir()

	// A bare name in a circuit workspace means a .hvr.
	p, err := a.CreateFile(dir, "filter")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(p) != "filter.hvr" {
		t.Errorf("expected .hvr to be appended, got %s", filepath.Base(p))
	}

	body, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	// A component file must NOT declare `main`, or it would collide with the
	// real entry module during elaboration.
	if strings.Contains(string(body), "module main") {
		t.Errorf("a non-main file must not declare module main:\n%s", body)
	}
	if !strings.Contains(string(body), "module filter") {
		t.Errorf("template should declare a module named after the file:\n%s", body)
	}
}

func TestCreatedFilesParse(t *testing.T) {
	a := newApp(t)
	dir := t.TempDir()

	for _, name := range []string{"main.hvr", "widget.hvr", "my-part.hvr"} {
		p, err := a.CreateFile(dir, name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		// The skeleton must be valid Hover, checked with the real front end
		// rather than by eye — an unparseable template would greet the user
		// with errors on a file they just created.
		raw, _ := os.ReadFile(p)
		if errs := hvr.ParseSource(p, string(raw)).Errors; len(errs) != 0 {
			t.Errorf("generated %s does not parse: %v", name, errs)
		}
	}
}

func TestCreateFileRejectsBadNames(t *testing.T) {
	a := newApp(t)
	dir := t.TempDir()

	for _, bad := range []string{"", "  ", "..", "a/b.hvr", `a\b.hvr`, "x?.hvr"} {
		if _, err := a.CreateFile(dir, bad); err == nil {
			t.Errorf("expected %q to be rejected", bad)
		}
	}
	// Nothing should have been written.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("rejected names still created files: %v", entries)
	}
}

func TestCreateFileRefusesToOverwrite(t *testing.T) {
	a := newApp(t)
	dir := t.TempDir()

	if _, err := a.CreateFile(dir, "thing.hvr"); err != nil {
		t.Fatal(err)
	}
	original, _ := os.ReadFile(filepath.Join(dir, "thing.hvr"))

	if _, err := a.CreateFile(dir, "thing.hvr"); err == nil {
		t.Fatal("expected a refusal to overwrite an existing file")
	}
	after, _ := os.ReadFile(filepath.Join(dir, "thing.hvr"))
	if string(original) != string(after) {
		t.Error("a refused create must leave the existing file untouched")
	}
}

func TestCreateFolder(t *testing.T) {
	a := newApp(t)
	dir := t.TempDir()

	p, err := a.CreateFolder(dir, "components")
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(p)
	if err != nil || !st.IsDir() {
		t.Fatalf("folder not created: %v", err)
	}
	if _, err := a.CreateFolder(dir, "components"); err == nil {
		t.Error("expected a refusal for a duplicate folder")
	}
}

func TestOpenFolderBuildsTreeAndSkipsNoise(t *testing.T) {
	a := newApp(t)
	root := t.TempDir()

	mustWrite(t, filepath.Join(root, "main.hvr"), "module main<>() [] {\n    wire a;\n}\n")
	mustWrite(t, filepath.Join(root, "parts", "widget.hvr"), "analog module W<>() [wire p] {\n    R<1k>()[p, gnd];\n}\n")
	mustWrite(t, filepath.Join(root, "notes.txt"), "hello")
	mustWrite(t, filepath.Join(root, ".git", "config"), "x")
	mustWrite(t, filepath.Join(root, "node_modules", "junk.js"), "x")

	w, err := a.OpenFolder(root)
	if err != nil {
		t.Fatal(err)
	}
	if !w.Open || w.Root != root {
		t.Fatalf("workspace not opened: %+v", w)
	}

	// The tree is lazy: only the top level is listed up front.
	names := map[string]TreeNode{}
	for _, n := range w.Tree {
		names[n.Name] = n
	}

	for _, want := range []string{"main.hvr", "parts", "notes.txt"} {
		if _, ok := names[want]; !ok {
			t.Errorf("top level is missing %q", want)
		}
	}
	if _, ok := names["widget.hvr"]; ok {
		t.Error("nested files must not be listed until their folder is expanded")
	}
	if !names["parts"].HasChildren {
		t.Error("a non-empty folder should be marked as expandable")
	}
	for _, unwanted := range []string{".git", "node_modules", "config", "junk.js"} {
		if _, ok := names[unwanted]; ok {
			t.Errorf("tree should not include %q", unwanted)
		}
	}
	if !names["main.hvr"].IsHVR {
		t.Error("main.hvr should be flagged as a Hover source")
	}
	if names["notes.txt"].IsHVR {
		t.Error("notes.txt must not be flagged as a Hover source")
	}
	if !names["parts"].IsDir {
		t.Error("parts should be a directory")
	}

	// A folder containing main.hvr adopts it as the circuit, so the canvas
	// has something to draw straight away.
	if a.entry != filepath.Join(root, "main.hvr") {
		t.Errorf("expected main.hvr to be adopted as the entry, got %q", a.entry)
	}
	if !names["main.hvr"].IsEntry {
		t.Error("the adopted entry should be marked in the tree")
	}
}

func TestListDirLoadsOneLevelOnDemand(t *testing.T) {
	a := newApp(t)
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "parts", "widget.hvr"), "")
	mustWrite(t, filepath.Join(root, "parts", "deep", "inner.hvr"), "")
	mustWrite(t, filepath.Join(root, "parts", "results.csv"), "Time,v\n0,1\n")

	if _, err := a.OpenFolder(root); err != nil {
		t.Fatal(err)
	}

	kids, err := a.ListDir(filepath.Join(root, "parts"))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]TreeNode{}
	for _, n := range kids {
		got[n.Name] = n
	}
	if len(kids) != 3 {
		t.Errorf("want 3 entries in parts/, got %d (%v)", len(kids), kids)
	}
	// Directories sort before files.
	if !kids[0].IsDir {
		t.Errorf("directories should sort first, got %q", kids[0].Name)
	}
	if !got["widget.hvr"].IsHVR {
		t.Error("widget.hvr should be flagged as Hover source")
	}
	if !got["results.csv"].IsCSV {
		t.Error("results.csv should be flagged as a CSV")
	}
	// Grandchildren still are not listed.
	if got["deep"].Children != nil {
		t.Error("ListDir must not recurse")
	}
	if !got["deep"].HasChildren {
		t.Error("deep/ holds a file, so it should be marked expandable")
	}
}

func TestListDirRejectsFiles(t *testing.T) {
	a := newApp(t)
	f := filepath.Join(t.TempDir(), "x.txt")
	mustWrite(t, f, "hi")
	if _, err := a.ListDir(f); err == nil {
		t.Error("expected listing a file to fail")
	}
	if _, err := a.ListDir(""); err == nil {
		t.Error("expected an empty path to fail")
	}
}

func TestDirHasEntriesIgnoresHiddenOnly(t *testing.T) {
	root := t.TempDir()
	hiddenOnly := filepath.Join(root, "hidden")
	mustWrite(t, filepath.Join(hiddenOnly, ".git", "x"), "")
	if dirHasEntries(hiddenOnly) {
		t.Error("a folder holding only skipped entries should not look expandable")
	}
	real := filepath.Join(root, "real")
	mustWrite(t, filepath.Join(real, "a.hvr"), "")
	if !dirHasEntries(real) {
		t.Error("a folder with a visible file should look expandable")
	}
}

func TestFindEntryCandidate(t *testing.T) {
	// Top-level main.hvr wins.
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "main.hvr"), "")
	mustWrite(t, filepath.Join(root, "other.hvr"), "")
	if got := findEntryCandidate(root); got != filepath.Join(root, "main.hvr") {
		t.Errorf("got %q, want top-level main.hvr", got)
	}

	// A lone .hvr anywhere is unambiguous.
	root2 := t.TempDir()
	only := filepath.Join(root2, "deep", "only.hvr")
	mustWrite(t, only, "")
	if got := findEntryCandidate(root2); got != only {
		t.Errorf("got %q, want the single .hvr %q", got, only)
	}

	// Several .hvr files and no main: too ambiguous to guess.
	root3 := t.TempDir()
	mustWrite(t, filepath.Join(root3, "a.hvr"), "")
	mustWrite(t, filepath.Join(root3, "b.hvr"), "")
	if got := findEntryCandidate(root3); got != "" {
		t.Errorf("expected no guess for an ambiguous folder, got %q", got)
	}
}

func TestOpenFolderRejectsNonDirectory(t *testing.T) {
	a := newApp(t)
	f := filepath.Join(t.TempDir(), "x.hvr")
	mustWrite(t, f, "")
	if _, err := a.OpenFolder(f); err == nil {
		t.Error("expected opening a file as a folder to fail")
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
