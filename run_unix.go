//go:build linux

package main

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts the compiler in its own process group.
//
// The hover CLI spawns Zig and then the simulation binary as children. Killing
// only the parent would leave a long-running simulation orphaned, so the whole
// group is signalled instead.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessTree signals the entire process group.
func killProcessTree(cmd *exec.Cmd) error {
	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil {
		// Fall back to the single process if the group is already gone.
		return cmd.Process.Kill()
	}
	// SIGTERM first so the child can flush its output; SIGKILL is the
	// backstop if it ignores that.
	if err := syscall.Kill(-pgid, syscall.SIGTERM); err != nil {
		return syscall.Kill(-pgid, syscall.SIGKILL)
	}
	return nil
}
