# hoverdeck — Linux and Windows only.
#
# macOS is deliberately unsupported, matching the hover-lang project policy;
# platform_darwin.go fails the build with an explanation if you try.

BIN        := build/bin/hoverdeck
HOVER_LANG ?= ../hover-lang

# Arch and other current distros ship webkit2gtk-4.1; older ones have 4.0.
# Wails needs to be told which one to link against.
WEBKIT_TAG := $(shell pkg-config --exists webkit2gtk-4.1 && echo webkit2_41)
ifneq ($(WEBKIT_TAG),)
  TAGS := -tags $(WEBKIT_TAG)
endif

.PHONY: all dev build build-windows test vet clean stdlib check

all: build

## dev — live-reloading development window
dev:
	wails dev $(TAGS)

## build — production binary for the host platform
build:
	wails build -platform linux/amd64 $(TAGS)
	@$(MAKE) --no-print-directory stdlib

## build-windows — cross-compile a Windows binary
build-windows:
	wails build -platform windows/amd64

## stdlib — copy the Hover standard library next to the binary, so
## `import <...>` resolves the same way it does for the hover compiler
stdlib:
	@if [ -d "$(HOVER_LANG)/standard_library" ]; then \
		rm -rf build/bin/standard_library; \
		cp -r "$(HOVER_LANG)/standard_library" build/bin/; \
		echo "standard_library staged next to $(BIN)"; \
	else \
		echo "warning: $(HOVER_LANG)/standard_library not found — set HOVER_LANG=<path>"; \
	fi

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
	rm -rf build/bin frontend/dist
