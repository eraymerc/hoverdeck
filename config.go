package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Settings is the small amount of machine-local state hoverdeck remembers
// between sessions. It lives in the user config dir rather than next to a
// circuit, because it describes this machine's Hover installation, not the
// project.
type Settings struct {
	// HoverBin is the path to the `hover` compiler executable.
	HoverBin string `json:"hoverBin"`

	// WorkDir is the directory the compiler runs in. It matters: the hover
	// CLI resolves `./runtime`, `./toolchain/zig` and its output files
	// relative to the working directory, so this normally has to be the
	// directory containing the hover binary. Empty means "use the binary's
	// own directory", which is right for a standard checkout.
	WorkDir string `json:"workDir"`

	// StdlibRoot resolves `import <...>`. Empty means auto-detect.
	StdlibRoot string `json:"stdlibRoot"`

	// LastFile is reopened on the next launch.
	LastFile string `json:"lastFile"`

	// LastFolder is the workspace folder reopened on the next launch.
	LastFolder string `json:"lastFolder"`
}

func settingsPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "hoverdeck-config.json"
	}
	return filepath.Join(dir, "hoverdeck", "config.json")
}

// LoadSettings reads the config file, returning defaults when it is missing
// or unreadable. A broken config must never stop the app from starting.
func LoadSettings() *Settings {
	s := &Settings{}
	raw, err := os.ReadFile(settingsPath())
	if err != nil {
		return s
	}
	_ = json.Unmarshal(raw, s)
	return s
}

// Save writes the config file, creating its directory if needed.
func (s *Settings) Save() error {
	p := settingsPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, append(raw, '\n'), 0o644)
}

// EffectiveWorkDir is the directory the compiler should run in.
func (s *Settings) EffectiveWorkDir() string {
	if s.WorkDir != "" {
		return s.WorkDir
	}
	if s.HoverBin != "" {
		return filepath.Dir(s.HoverBin)
	}
	return ""
}

// SettingsView is what the UI reads and writes, plus derived diagnostics so
// the settings dialog can tell the user whether the paths actually work.
type SettingsView struct {
	HoverBin      string `json:"hoverBin"`
	WorkDir       string `json:"workDir"`
	StdlibRoot    string `json:"stdlibRoot"`
	ConfigPath    string `json:"configPath"`
	BinOK         bool   `json:"binOK"`
	RuntimeOK     bool   `json:"runtimeOK"`
	EffectiveBin  string `json:"effectiveBin"`
	EffectiveWork string `json:"effectiveWork"`
	Detected      string `json:"detected"`
	Note          string `json:"note"`
}

// view builds the UI's picture of the settings. `detected` is an auto-found
// installation used when the user has not chosen one explicitly.
func (s *Settings) view(detected string) *SettingsView {
	bin := s.HoverBin
	if bin == "" {
		bin = detected
	}
	work := s.WorkDir
	if work == "" && bin != "" {
		work = filepath.Dir(bin)
	}

	v := &SettingsView{
		HoverBin:      s.HoverBin,
		WorkDir:       s.WorkDir,
		StdlibRoot:    s.StdlibRoot,
		ConfigPath:    settingsPath(),
		EffectiveBin:  bin,
		EffectiveWork: work,
		Detected:      detected,
	}
	if bin != "" {
		if st, err := os.Stat(bin); err == nil && !st.IsDir() {
			v.BinOK = true
		}
	}
	if work != "" {
		// The CLI links against ./runtime/... from its working directory.
		if st, err := os.Stat(filepath.Join(work, "runtime")); err == nil && st.IsDir() {
			v.RuntimeOK = true
		}
	}
	switch {
	case !v.BinOK:
		v.Note = "Select the hover compiler executable to enable Run."
	case !v.RuntimeOK:
		v.Note = "No runtime/ directory in the working directory — the compiler links " +
			"against ./runtime, so it usually has to run from the hover checkout root."
	case s.HoverBin == "":
		v.Note = "Ready — using auto-detected " + bin
	default:
		v.Note = "Ready."
	}
	return v
}

// DetectHoverInstall looks for a usable hover installation so Run works
// without the user having to configure anything first.
//
// A directory qualifies only if it holds both an executable named `hover` and
// a `runtime` directory, since the compiler links against ./runtime from its
// working directory — a bare binary on its own would fail at the link step.
func DetectHoverInstall(hints ...string) string {
	starts := append([]string(nil), hints...)
	if exe, err := os.Executable(); err == nil {
		if real, e := filepath.EvalSymlinks(exe); e == nil {
			exe = real
		}
		starts = append(starts, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	return detectFrom(starts)
}

// detectFrom is the testable core of DetectHoverInstall: it searches only the
// directories it is given, with no ambient lookup of the executable or working
// directory.
//
// From each starting point it climbs several levels, checking each ancestor
// and its immediate children. A hover checkout is usually a *sibling* of the
// hoverdeck checkout, and the running binary sits a couple of levels down in
// build/bin, so the search has to go up before it can come back down.
func detectFrom(starts []string) string {
	const levels = 5

	var roots []string
	for _, s := range starts {
		if s == "" {
			continue
		}
		d := filepath.Clean(s)
		for i := 0; i < levels; i++ {
			roots = append(roots, d)
			parent := filepath.Dir(d)
			if parent == d {
				break
			}
			d = parent
		}
	}

	seen := map[string]bool{}
	for _, root := range roots {
		if seen[root] {
			continue
		}
		seen[root] = true

		if bin, ok := hoverInstallAt(root); ok {
			return bin
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			if bin, ok := hoverInstallAt(filepath.Join(root, e.Name())); ok {
				return bin
			}
		}
	}
	return ""
}

// hoverInstallAt reports whether dir looks like a complete hover install.
func hoverInstallAt(dir string) (string, bool) {
	if st, err := os.Stat(filepath.Join(dir, "runtime")); err != nil || !st.IsDir() {
		return "", false
	}
	for _, name := range []string{"hover", "hover.exe"} {
		p := filepath.Join(dir, name)
		st, err := os.Stat(p)
		if err != nil || st.IsDir() {
			continue
		}
		if st.Mode()&0o111 == 0 && name == "hover" {
			continue // not executable
		}
		return p, true
	}
	return "", false
}
