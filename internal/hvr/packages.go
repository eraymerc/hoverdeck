package hvr

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"hover/compiler/loader"
	"hover/hpm"
)

// Package resolution, hover 0.8.
//
// An import names a DIRECTORY, and the first segment of an angle import is a
// package name — `import <math>` and `import <hvr-rc>` go through one table.
// That table is built from lockfiles: the project's hover.lock when the entry
// file sits inside a project, otherwise everything installed machine-wide in
// ~/.hover. The standard library is an ordinary package in it, installed by
// `hover --setup`.
//
// hoverdeck cannot simply let the compiler's loader work this out for itself.
// loader falls back to a `stdlib` directory next to THE RUNNING EXECUTABLE,
// and the running executable here is hoverdeck, not hover — so the fallback
// would look in the wrong place, or silently find nothing. The table is
// therefore built explicitly, with the bundled copy anchored to the compiler
// the user actually configured.

// Packages is the import table one project resolves against: package name to
// the directory holding its sources.
type Packages struct {
	// Roots is what `import <name/...>` resolves through.
	Roots map[string]string `json:"roots"`

	// Bundled is the `stdlib` directory beside the configured hover binary,
	// used for a source checkout that has never run `hover --setup`. Empty
	// when there is none.
	Bundled string `json:"bundled"`

	// StdlibInstalled reports whether a standard library was found at all.
	// When it is false every `import <math>` in the workspace will fail, and
	// the answer is `hover --setup` rather than anything hoverdeck can fix.
	StdlibInstalled bool `json:"stdlibInstalled"`

	// Note explains an empty or partial table in the UI's own words.
	Note string `json:"note"`
}

// ResolvePackages builds the import table for entryFile.
//
// hoverBin locates the bundled standard library of a source checkout; it may
// be empty, in which case only installed packages are visible. entryFile may
// also be empty, before anything is open — the machine-wide table is then
// used, which is what a loose file would see anyway.
func ResolvePackages(entryFile, hoverBin string) *Packages {
	p := &Packages{Roots: map[string]string{}}

	var (
		roots map[string]string
		err   error
	)
	if entryFile != "" {
		roots, err = hpm.PackageRootsForFile(entryFile)
	} else {
		roots, err = hpm.MachineRoots()
	}
	if err != nil {
		p.Note = fmt.Sprintf("could not read the installed packages: %v", err)
	}
	for name, dir := range roots {
		p.Roots[name] = dir
	}

	// The bundled copy is a FALLBACK, exactly as it is in the compiler: an
	// installed package of the same name wins, because that is how a project
	// pins a standard library version.
	if hoverBin != "" {
		bundled := filepath.Join(filepath.Dir(hoverBin), "stdlib")
		if st, statErr := os.Stat(bundled); statErr == nil && st.IsDir() {
			p.Bundled = bundled
			for name, dir := range bundledRoots(bundled) {
				if _, taken := p.Roots[name]; !taken {
					p.Roots[name] = dir
				}
			}
		}
	}

	for _, name := range hpm.StdlibImportNames() {
		if _, ok := p.Roots[name]; ok {
			p.StdlibInstalled = true
			break
		}
	}
	if !p.StdlibInstalled && p.Note == "" {
		p.Note = "the standard library is not installed — run `hover --setup` " +
			"(it downloads the standard library; this needs network access)"
	}
	return p
}

// bundledRoots expands a stdlib tree the way hpm does for an installed one:
// the tree itself binds `stdlib`, and each top-level directory inside it
// binds its own name, so `import <math>` and `import <stdlib/math>` are two
// spellings of the same directory.
func bundledRoots(dir string) map[string]string {
	out := map[string]string{hpm.StdlibPackageName: dir}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		out[e.Name()] = filepath.Join(dir, e.Name())
	}
	return out
}

// install publishes this table to the compiler's resolver, which reads it
// through package-level state. Called before every load, since the table
// depends on which file is open.
func (p *Packages) install() {
	loader.SetPackageRoots(p.Roots)
	loader.SetStdlibPackageNames(hpm.StdlibImportNames())
}

// Names returns the package names in the table, sorted.
func (p *Packages) Names() []string {
	out := make([]string, 0, len(p.Roots))
	for name := range p.Roots {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// Owns reports whether path lies inside one of the package roots — i.e. it is
// library source rather than the user's own. Those files open read-only:
// installed packages live in a content-addressed cache and editing one would
// change every project on the machine that resolved to the same hash.
func (p *Packages) Owns(path string) bool {
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	for _, root := range p.Roots {
		if within(abs, root) {
			return true
		}
	}
	return false
}

// PackageOf returns the package name a path belongs to, or "" when it is not
// library source. The longest matching root wins, so a file inside the `math`
// root is reported as `math` rather than as the `stdlib` tree containing it.
func (p *Packages) PackageOf(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return ""
	}
	best, bestLen := "", -1
	for name, root := range p.Roots {
		if within(abs, root) && len(root) > bestLen {
			best, bestLen = name, len(root)
		}
	}
	return best
}

func within(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
