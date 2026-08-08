package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"hoverdeck/internal/hvr"
)

// makeInstall creates a directory that looks like a hover installation.
func makeInstall(t *testing.T, dir string, withRuntime bool) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if withRuntime {
		if err := os.MkdirAll(filepath.Join(dir, "runtime"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	bin := filepath.Join(dir, "hover")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

func TestDetectFindsSiblingInstall(t *testing.T) {
	root := t.TempDir()
	want := makeInstall(t, filepath.Join(root, "hover-lang"), true)
	// The "project" the user is working in, a sibling of the install.
	proj := filepath.Join(root, "hoverdeck", "build", "bin")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}

	got := detectFrom([]string{proj})
	if got != want {
		t.Errorf("detection from a hint: got %q, want %q", got, want)
	}
}

func TestDetectIgnoresBinaryWithoutRuntime(t *testing.T) {
	root := t.TempDir()
	// A hover binary with no runtime/ beside it cannot link, so it must not
	// be offered as a usable installation.
	makeInstall(t, filepath.Join(root, "stale-copy"), false)

	if got := detectFrom([]string{root}); got != "" {
		t.Errorf("expected no detection for an install without runtime/, got %q", got)
	}
}

func TestDetectPrefersNothingWhenAbsent(t *testing.T) {
	if got := detectFrom([]string{t.TempDir()}); got != "" {
		t.Errorf("expected empty result in an empty tree, got %q", got)
	}
}

func TestSettingsViewFallsBackToDetected(t *testing.T) {
	root := t.TempDir()
	bin := makeInstall(t, filepath.Join(root, "hover-lang"), true)

	pkgs := &hvr.Packages{Roots: map[string]string{"math": root}, StdlibInstalled: true}
	s := &Settings{}
	v := s.view(bin, filepath.Dir(bin), pkgs)
	if !v.BinOK {
		t.Error("auto-detected binary should count as usable")
	}
	if !v.RuntimeOK {
		t.Error("runtime/ beside the detected binary should be found")
	}
	if v.EffectiveBin != bin {
		t.Errorf("effective binary: got %q, want %q", v.EffectiveBin, bin)
	}
	if v.EffectiveWork != filepath.Dir(bin) {
		t.Errorf("working dir should default to the binary's directory, got %q", v.EffectiveWork)
	}

	// An explicit setting must win over detection.
	other := makeInstall(t, filepath.Join(root, "other"), true)
	s.HoverBin = other
	v2 := s.view(bin, filepath.Dir(other), pkgs)
	if v2.EffectiveBin != other {
		t.Errorf("explicit setting should win: got %q, want %q", v2.EffectiveBin, other)
	}
}

func TestSettingsViewReportsMissingRuntime(t *testing.T) {
	root := t.TempDir()
	bin := makeInstall(t, filepath.Join(root, "loose"), false)

	v := (&Settings{HoverBin: bin}).view("", filepath.Dir(bin),
		&hvr.Packages{Roots: map[string]string{"math": root}, StdlibInstalled: true})
	if !v.BinOK {
		t.Error("the binary itself exists, so BinOK should hold")
	}
	if v.RuntimeOK {
		t.Error("there is no runtime/ directory, so RuntimeOK must be false")
	}
	if v.Note == "" || v.Note == "Ready." {
		t.Errorf("the note should explain the missing runtime, got %q", v.Note)
	}
}

// Releases ship no standard library, so a complete install that has never run
// `hover --setup` is the state a first-time user is actually in. The settings
// view has to name the one command that fixes it.
func TestSettingsViewReportsMissingStdlib(t *testing.T) {
	root := t.TempDir()
	bin := makeInstall(t, filepath.Join(root, "fresh"), true)

	v := (&Settings{HoverBin: bin}).view("", filepath.Dir(bin),
		&hvr.Packages{Roots: map[string]string{}})
	if !v.RuntimeOK {
		t.Error("runtime/ is present beside the binary")
	}
	if v.StdlibOK {
		t.Error("no package roots, so the standard library cannot be installed")
	}
	if !v.NeedsSetup {
		t.Error("a missing standard library is exactly what --setup fixes")
	}
	if !strings.Contains(v.Note, "--setup") {
		t.Errorf("the note should name `hover --setup`, got %q", v.Note)
	}
}

func TestSettingsRoundTrip(t *testing.T) {
	// Redirect the config to a temp dir so the developer's real settings are
	// never touched by the test suite.
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	s := &Settings{HoverBin: "/opt/hover/hover", WorkDir: "/opt/hover"}
	if err := s.Save(); err != nil {
		t.Fatal(err)
	}
	got := LoadSettings()
	if got.HoverBin != s.HoverBin || got.WorkDir != s.WorkDir {
		t.Errorf("round trip mismatch: %+v vs %+v", got, s)
	}
}

func TestLoadSettingsSurvivesCorruptFile(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	p := settingsPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("not json at all"), 0o644); err != nil {
		t.Fatal(err)
	}
	if s := LoadSettings(); s == nil {
		t.Fatal("a corrupt config must degrade to defaults, not nil")
	}
}

func TestEffectiveWorkDirDefaultsToBinaryDir(t *testing.T) {
	s := &Settings{HoverBin: "/opt/hover/hover"}
	if got := s.EffectiveWorkDir(); got != "/opt/hover" {
		t.Errorf("got %q, want /opt/hover", got)
	}
	s.WorkDir = "/elsewhere"
	if got := s.EffectiveWorkDir(); got != "/elsewhere" {
		t.Errorf("explicit work dir should win, got %q", got)
	}
}
