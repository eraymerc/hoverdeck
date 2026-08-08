package main

import (
	"fmt"
	"os"

	"hoverdeck/internal/hvr"
)

func main() {
	entry := os.Args[1]
	mod := "main"
	if len(os.Args) > 2 {
		mod = os.Args[2]
	}
	// Same import table the app builds: the lockfiles that apply to this file,
	// plus the stdlib bundled beside the compiler if $HOVER_BIN names one.
	pkgs := hvr.ResolvePackages(entry, os.Getenv("HOVER_BIN"))
	fmt.Println("packages:", pkgs.Names())
	if pkgs.Note != "" {
		fmt.Println("note:", pkgs.Note)
	}

	p, err := hvr.LoadProject(entry, pkgs)
	if err != nil {
		fmt.Println("load error:", err)
		os.Exit(1)
	}
	fmt.Println("files:", len(p.Files), "errors:", p.AllErrors())

	fmt.Println("\n-- visible modules --")
	for _, d := range p.Modules() {
		fmt.Printf("  %-22s %-11s lines %d-%d  ports=%v\n", d.QualifiedAs, d.Domain, d.Span.StartLine, d.Span.EndLine, d.PhysPorts)
	}

	sh, err := p.BuildSheet(mod)
	if err != nil {
		fmt.Println("sheet error:", err)
		os.Exit(1)
	}
	fmt.Printf("\n-- sheet %s (%s) lines %d-%d --\n", sh.Qualified, sh.Domain, sh.Span.StartLine, sh.Span.EndLine)
	for _, b := range sh.Blocks {
		params := []string{}
		for _, a := range b.Params {
			params = append(params, a.Text)
		}
		fmt.Printf("  [%-6s] %-10s %-16s icon=%-10s nav=%-5v params=%v\n", b.Kind, b.ID, b.TypeName, b.Icon, b.Navigable, params)
		for _, pin := range b.Pins {
			fmt.Printf("        pin %-6s -> %-12s span=%d..%d %q\n", pin.Name, pin.Net, pin.Span.Start, pin.Span.End, sliceOf(p, sh.File, pin.Span))
		}
	}
	fmt.Println("\n-- nets --")
	for _, n := range sh.Nets {
		fmt.Printf("  %-12s gnd=%-5v decl=%-5v boundary=%-5v pins=%d\n", n.Name, n.IsGround, n.Declared, n.IsBoundary, len(n.Pins))
	}
	fmt.Println("\n-- signals --")
	for _, s := range sh.Signals {
		fmt.Printf("  %-16s %-8s state=%-5v init=%q line=%d\n", s.Name, s.Type, s.IsState, s.Init, s.Line)
	}
	if len(sh.Errors) > 0 {
		fmt.Println("\n-- sheet errors --")
		for _, e := range sh.Errors {
			fmt.Println("  ", e)
		}
	}
}

func sliceOf(p *hvr.Project, file string, sp hvr.Span) string {
	f := p.Files[file]
	if f == nil {
		return ""
	}
	return f.Src.TextOf(sp)
}
