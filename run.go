package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Runner drives the external `hover` compiler.
//
// The hover CLI does a lot in one invocation — parse, elaborate, generate
// sim.cpp, build it with Zig, then run the simulation — so output is streamed
// to the UI line by line as it arrives rather than collected and dumped at the
// end. A long transient would otherwise look like a hang.
type Runner struct {
	mu      sync.Mutex
	cmd     *exec.Cmd
	running bool
}

// RunStatus is emitted when a run finishes.
type RunStatus struct {
	ExitCode int    `json:"exitCode"`
	Failed   bool   `json:"failed"`
	Message  string `json:"message"`
	CSVPath  string `json:"csvPath"`
	Seconds  float64 `json:"seconds"`
}

// Running reports whether a run is currently in flight.
func (r *Runner) Running() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.running
}

// Start launches the compiler on entryFile and streams its output.
//
// Events emitted:
//
//	run:line   one line of combined stdout/stderr
//	run:done   a RunStatus
func (r *Runner) Start(a *App, entryFile string) error {
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return fmt.Errorf("a run is already in progress")
	}
	r.mu.Unlock()

	bin := a.effectiveBin()
	if bin == "" {
		return fmt.Errorf("no hover compiler configured — set its location in Settings")
	}
	if st, err := os.Stat(bin); err != nil || st.IsDir() {
		return fmt.Errorf("hover compiler not found at %s", bin)
	}

	// The working directory decides where ./runtime and ./toolchain/zig
	// resolve, so it defaults to the compiler's own directory rather than the
	// project's — running from the project would fail at the link step.
	workDir := a.settings.WorkDir
	if workDir == "" {
		workDir = filepath.Dir(bin)
	}

	// The entry file is passed absolute, because the working directory is the
	// compiler's install root rather than the project directory.
	abs, err := filepath.Abs(entryFile)
	if err != nil {
		return err
	}

	cmd := exec.Command(bin, abs)
	cmd.Dir = workDir
	setProcessGroup(cmd) // so Stop can take the whole tree down

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout.(io.Writer) // interleave in the order they happen
	pipe := stdout

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not start %s: %w", filepath.Base(bin), err)
	}

	r.mu.Lock()
	r.cmd = cmd
	r.running = true
	r.mu.Unlock()

	started := time.Now()
	emit := func(line string) { wruntime.EventsEmit(a.ctx, "run:line", line) }
	emit(fmt.Sprintf("$ %s %s", bin, abs))
	emit(fmt.Sprintf("  (working directory: %s)", workDir))

	go func() {
		sc := bufio.NewScanner(pipe)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			emit(sc.Text())
		}

		waitErr := cmd.Wait()

		r.mu.Lock()
		r.running = false
		r.cmd = nil
		r.mu.Unlock()

		status := RunStatus{Seconds: time.Since(started).Seconds()}
		if waitErr != nil {
			status.Failed = true
			if ee, ok := waitErr.(*exec.ExitError); ok {
				status.ExitCode = ee.ExitCode()
				status.Message = fmt.Sprintf("exited with code %d", ee.ExitCode())
			} else {
				status.Message = waitErr.Error()
			}
		} else {
			status.Message = "completed"
		}

		// The runtime writes results next to wherever the simulation ran.
		csv := filepath.Join(workDir, "simulation_output.csv")
		if st, err := os.Stat(csv); err == nil && !st.IsDir() {
			status.CSVPath = csv
		}
		wruntime.EventsEmit(a.ctx, "run:done", status)
	}()

	return nil
}

// Stop terminates a running compile/simulation, including its children.
func (r *Runner) Stop() error {
	r.mu.Lock()
	cmd := r.cmd
	running := r.running
	r.mu.Unlock()

	if !running || cmd == nil || cmd.Process == nil {
		return fmt.Errorf("nothing is running")
	}
	return killProcessTree(cmd)
}

// looksLikeHoverBinary is a light sanity check for the file picker, so an
// obviously wrong selection is caught before the first run.
func looksLikeHoverBinary(path string) bool {
	base := strings.ToLower(filepath.Base(path))
	return strings.Contains(base, "hover")
}
