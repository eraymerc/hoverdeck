//go:build windows

package main

import (
	"os/exec"
	"strconv"
	"syscall"
)

// setProcessGroup gives the compiler its own process group so that killing it
// can take its children (Zig, then the simulation binary) with it.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
}

// killProcessTree ends the process and everything it spawned.
//
// Windows has no process-group signal equivalent to kill(-pgid), so this
// delegates to taskkill, which understands the parent/child tree.
func killProcessTree(cmd *exec.Cmd) error {
	pid := strconv.Itoa(cmd.Process.Pid)
	kill := exec.Command("taskkill", "/T", "/F", "/PID", pid)
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := kill.Run(); err != nil {
		return cmd.Process.Kill()
	}
	return nil
}
