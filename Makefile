# ─────────────────────────────────────────────────────────────────────────────
# hoverdeck — Release Makefile (Linux and Windows)
#
# macOS is deliberately unsupported, matching the hover-lang project policy;
# platform_darwin.go fails the build with an explanation if you try.
#
# Unlike hover itself, hoverdeck is a Wails GUI app, so a platform costs more
# than a `go build`: Wails only supports linux/{amd64,arm64} and
# windows/{amd64,arm64,386} besides macOS, and every Linux build links
# webkit2gtk via CGO. The BSDs, riscv64 and linux/386 that hover ships have
# no Wails runtime at all, and linux/arm64 can't be cross-linked from an
# amd64 host without an aarch64 webkit2gtk sysroot, so the matrix below is
# what this machine can actually ship.
#
# Targets:
#   make <platform>    → Build one platform, e.g. `make windows-aarch64`
#   make all           → Build every platform into build/bin/
#   make icon          → Stamp $(VERSION) into the disc logo and rebuild
#                        build/appicon.png + build/windows/icon.ico
#   make build         → Build for the host (linux/amd64), as before
#   make dev           → Live-reloading development window
#   make check         → vet + test (what CI runs)
#   make clean         → Remove build artifacts
#
# make all VERSION=v0.8.0   (VERSION defaults to v0.0.0-dev if unset)
# ─────────────────────────────────────────────────────────────────────────────

BIN        := build/bin/hoverdeck
HOVER_LANG ?= ../hover-main

VERSION ?= v0.0.0-dev

# Arch and other current distros ship webkit2gtk-4.1; older ones have 4.0.
# Wails needs to be told which one to link against.
WEBKIT_TAG := $(shell pkg-config --exists webkit2gtk-4.1 && echo webkit2_41)
ifneq ($(WEBKIT_TAG),)
  TAGS := -tags $(WEBKIT_TAG)
endif

# ── PLATFORM MATRIX ───────────────────────────────────────────────────────────
# Everything Wails v2 can target except macOS and linux/arm64. linux/arm64 is
# excluded because it is a CROSS build from x86_64 needing an aarch64 toolchain
# plus an aarch64 webkit2gtk-4.1 sysroot visible to pkg-config — not practical
# on an amd64 host; build it on arm64 hardware or in a container if ever needed.

PLATFORMS := linux-x86_64 \
             windows-x86_64 windows-aarch64 windows-x86

linux-x86_64_WAILS     := linux/amd64
windows-x86_64_WAILS   := windows/amd64
windows-aarch64_WAILS  := windows/arm64
windows-x86_WAILS      := windows/386

# ── ICON (versioned disc logo) ────────────────────────────────────────────────
# The disc logo (assets/logo-disc.svg) has the version baked in as text, so it
# is stamped with $(VERSION) at build time. The stamp replaces the contents of
# whichever text node looks like a version tag (>vX.Y.Z< — only the version
# <text> element matches; "HOVER" does not), so artwork and attribute changes
# to the SVG do not touch this Makefile.
#
# Unlike the hover CLI there is no windres/.syso step here: Wails embeds the
# resources itself, picking them up from their conventional locations —
# build/appicon.png (Linux packaging) and build/windows/icon.ico (the .exe
# icon). Building therefore needs rsvg-convert and ImageMagick on PATH.
RSVG_CONVERT ?= rsvg-convert
MAGICK       ?= magick

ICON_DIR  := build/icon
ICON_SVG  := assets/logo-disc.svg
ICON_VSVG := $(ICON_DIR)/logo-disc-versioned.svg
ICON_PNG  := build/appicon.png
ICON_ICO  := build/windows/icon.ico

$(ICON_VSVG): $(ICON_SVG) FORCE
	@mkdir -p $(ICON_DIR)
	sed -E 's/>v[0-9][0-9.]*</>$(VERSION)</' $(ICON_SVG) > $@
	@grep -qF '>$(VERSION)<' $@ || { echo "  ! could not stamp VERSION into $(ICON_SVG)"; exit 1; }

$(ICON_ICO): $(ICON_VSVG) FORCE
	@mkdir -p $(dir $@)
	for s in 16 32 48 256; do \
		$(RSVG_CONVERT) -w $$s -h $$s $(ICON_VSVG) -o $(ICON_DIR)/icon-$$s.png || exit 1; \
	done
	$(MAGICK) $(ICON_DIR)/icon-16.png $(ICON_DIR)/icon-32.png \
		$(ICON_DIR)/icon-48.png $(ICON_DIR)/icon-256.png $@
	$(RSVG_CONVERT) -w 1024 -h 1024 $(ICON_VSVG) -o $(ICON_PNG)

.PHONY: icon
icon: $(ICON_ICO)
	@echo "[icon] $(ICON_PNG) + $(ICON_ICO) stamped with $(VERSION)"

.PHONY: FORCE
FORCE:

# ── DEFAULT TARGETS ───────────────────────────────────────────────────────────

.PHONY: all build build-windows dev test vet check clean help $(PLATFORMS) linux windows

all: $(PLATFORMS)

# Back-compat aliases.
linux: linux-x86_64
windows: windows-x86_64
build: linux-x86_64
build-windows: windows-x86_64

## dev — live-reloading development window
dev: embed-dir
	wails dev $(TAGS) -skipembedcreate

# ── EMBED DIRECTORY ───────────────────────────────────────────────────────────
# wails build/dev are run with -skipembedcreate, and this target does that step
# instead. The step it skips only makes sure frontend/dist exists for the
# `//go:embed all:frontend/dist` in main.go, but to find embed directives it
# type-checks the whole project with the golang.org/x/tools that the wails CLI
# was built with — and Wails v2.13.0's x/tools (v0.44.0) cannot read Go 1.27's
# standard-library export data, dying with
#   internal error: package "bufio" without types was imported from ...
# Drop -skipembedcreate and this target once the wails CLI is rebuilt against
# an x/tools that supports the Go toolchain in use.
.PHONY: embed-dir
embed-dir:
	@mkdir -p frontend/dist
	@test -n "$$(ls -A frontend/dist)" || touch frontend/dist/.gitkeep

# ── PER-PLATFORM BUILD TEMPLATE ───────────────────────────────────────────────

define PLATFORM_TEMPLATE

.PHONY: $(1)
$(1): $(ICON_ICO) embed-dir
	@echo "\n[$(1)] wails build -platform $$($(1)_WAILS)"
	wails build -platform $$($(1)_WAILS) -skipembedcreate \
		$$(if $$(filter linux/%,$$($(1)_WAILS)),$(TAGS)) \
		-o hoverdeck-$(1)$$(if $$(filter windows/%,$$($(1)_WAILS)),.exe)
	@echo "[$(1)] Binary ready: build/bin/hoverdeck-$(1)$$(if $$(filter windows/%,$$($(1)_WAILS)),.exe)"

endef

$(foreach p,$(PLATFORMS),$(eval $(call PLATFORM_TEMPLATE,$(p))))

# There is no stdlib target any more. Until 0.8 the standard library had to be
# staged next to the hoverdeck binary for `import <...>` to resolve; 0.8 made
# it an ordinary installed package, so hoverdeck reads the same lockfiles the
# compiler does — ~/.hover, or the project's own hover.lock. `hover --setup`
# is what puts it there, and hoverdeck can run that from its Settings window.

## test — backend unit tests
test:
	go test ./...

## vet — static checks over Go and TypeScript
vet:
	go vet ./...
	cd frontend && npx tsc --noEmit

## check — everything CI would run
check: vet test

clean:
	rm -rf build/bin build/icon frontend/dist

help:
	@echo "hoverdeck Build System"
	@echo "  make <platform>  - Build one platform:"
	@echo "                     $(PLATFORMS)"
	@echo "  make all         - Build every platform into build/bin/"
	@echo "  make icon        - Stamp \$$VERSION into the logo and rebuild appicon/icon.ico"
	@echo "  make dev         - Live-reloading development window"
	@echo "  make check       - vet + test (what CI runs)"
	@echo "  make clean       - Remove build artifacts"
	@echo ""
	@echo "  VERSION=$(VERSION) (override with VERSION=v0.8.0)"
	@echo "  Building needs rsvg-convert and ImageMagick on PATH."
	@echo "  macOS is unsupported by project policy; BSDs/riscv64/linux-386"
	@echo "  have no Wails runtime, and linux/arm64 needs an aarch64"
	@echo "  toolchain + webkit2gtk-4.1 sysroot (not cross-buildable here)."
