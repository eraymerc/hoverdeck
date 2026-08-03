//go:build darwin

package main

// hoverdeck targets Linux and Windows only.
//
// This mirrors the hover-lang project policy of not supporting macOS, so the
// build fails here with an explanation rather than producing a binary from an
// untested configuration. The undefined identifier below is deliberate: it
// makes the compiler print the reason as part of the error.
var _ = hoverdeck_does_not_support_macOS_build_on_linux_or_windows
