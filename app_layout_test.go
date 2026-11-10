package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"hoverdeck/internal/hvr"
)

// The frontend fires layout saves without waiting for one another — a block
// drop saves its position and every wire it stretched at once — and Wails
// runs each call on its own goroutine. They must not race on the layout's
// maps, and none may be lost. Run with -race to see the first half.
func TestConcurrentLayoutSavesAreSerialised(t *testing.T) {
	dir := t.TempDir()
	entry := filepath.Join(dir, "main.hvr")
	if err := os.WriteFile(entry, []byte("module main<>()[] {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &App{entry: entry, layout: hvr.LoadLayout(entry)}

	const n = 40
	var wg sync.WaitGroup
	errs := make(chan error, 3*n)
	for i := 0; i < n; i++ {
		wg.Add(3)
		go func(i int) {
			defer wg.Done()
			errs <- a.SetNetWires("main", fmt.Sprintf("n%d", i), []hvr.WireSeg{{0, 0, float64(8 * (i + 1)), 0}})
		}(i)
		go func(i int) {
			defer wg.Done()
			errs <- a.SetBlockPosition("main", fmt.Sprintf("b%d", i), float64(i), 0)
		}(i)
		go func(i int) {
			defer wg.Done()
			errs <- a.SetSignalWires("main", fmt.Sprintf("s%d", i), []hvr.WireSeg{{0, 0, 0, float64(8 * (i + 1))}})
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}

	// Everything reached the file.
	saved := hvr.LoadLayout(entry).Sheet("main")
	if len(saved.Nets) != n || len(saved.Blocks) != n || len(saved.Links) != n {
		t.Errorf("saved %d nets, %d blocks, %d links; want %d of each", len(saved.Nets), len(saved.Blocks), len(saved.Links), n)
	}
}
