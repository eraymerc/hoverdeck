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
//
// The same machinery runs `hover --setup` and `hover hpm ...`, which are the
// other two things 0.8 asks a user to do from a terminal: they stream progress
// the same way and only one of the three may be in flight at a time, since
// they all write to the same install.
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

// Start compiles and simulates entryFile, streaming the compiler's output.
//
// Events emitted:
//
//	run:line   one line of combined stdout/stderr
//	run:done   a RunStatus
func (r *Runner) Start(a *App, entryFile string) error {
	// The entry file is passed absolute so the run is independent of where it
	// happens to be launched from.
	abs, err := filepath.Abs(entryFile)
	if err != nil {
		return err
	}
	return r.start(a, []string{abs}, a.runDir(), true)
}

// Setup runs `hover --setup`: find a Zig toolchain, build the C++ runtime, and
// download the standard library into ~/.hover. Releases ship no standard
// library, so this is the step that makes `import <math>` resolve at all — and
// the one thing hoverdeck cannot do for the user itself, since it needs
// network access and writes to the install.
func (r *Runner) Setup(a *App) error {
	bin := a.effectiveBin()
	if bin == "" {
		return fmt.Errorf("no hover compiler configured — set its location in Settings")
	}
	return r.start(a, []string{"--setup"}, filepath.Dir(bin), false)
}

// HPM runs `hover hpm <args...>` in the project directory, which is where the
// hover.toml and hover.lock it reads and writes live.
func (r *Runner) HPM(a *App, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("hpm needs a command (install, update, remove, list, verify, index, clean)")
	}
	return r.start(a, append([]string{"hpm"}, args...), a.runDir(), false)
}

// start launches the compiler with args and streams its output. wantCSV marks
// the invocations that produce simulation results, so a package command does
// not report a stale CSV as its own output.
func (r *Runner) start(a *App, args []string, workDir string, wantCSV bool) error {
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

	if workDir == "" {
		workDir = filepath.Dir(bin)
	}

	cmd := exec.Command(bin, args...)
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
	emit(fmt.Sprintf("$ %s %s", bin, strings.Join(args, " ")))
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
		if wantCSV {
			csv := filepath.Join(workDir, "simulation_output.csv")
			if st, err := os.Stat(csv); err == nil && !st.IsDir() {
				status.CSVPath = csv
			}
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
