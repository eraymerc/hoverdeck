package hvr

import (
	"strings"
)

// Source wraps a .hvr file's text with the offset math and bracket scanning
// that everything else in hoverdeck needs.
//
// The compiler's AST gives us Line/Column for the *start* of a statement but
// no end position, and its Expression.String() is a normalising pretty-printer
// ("-15" comes back as "(-15)"). Neither is good enough for a tool whose whole
// job is to show and surgically edit the user's real text, so we recover exact
// spans by scanning the source directly from the token position the AST hands us.
type Source struct {
	Path string
	Text string

	// lineStart[i] is the byte offset where 1-based line i+1 begins.
	lineStart []int
}

func NewSource(path, text string) *Source {
	s := &Source{Path: path, Text: text}
	s.index()
	return s
}

func (s *Source) index() {
	s.lineStart = []int{0}
	for i := 0; i < len(s.Text); i++ {
		if s.Text[i] == '\n' {
			s.lineStart = append(s.lineStart, i+1)
		}
	}
}

// LineCount reports the number of lines in the file.
func (s *Source) LineCount() int { return len(s.lineStart) }

// Offset converts a 1-based line and 1-based column (the convention the Hover
// lexer uses) into a byte offset. Out-of-range input is clamped rather than
// panicking: positions come from a parser that may have recovered from errors.
func (s *Source) Offset(line, col int) int {
	if line < 1 {
		line = 1
	}
	if line > len(s.lineStart) {
		line = len(s.lineStart)
	}
	off := s.lineStart[line-1] + (col - 1)
	if off < 0 {
		off = 0
	}
	if off > len(s.Text) {
		off = len(s.Text)
	}
	return off
}

// LineOf returns the 1-based line containing the given byte offset.
func (s *Source) LineOf(off int) int {
	lo, hi := 0, len(s.lineStart)-1
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if s.lineStart[mid] <= off {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return lo + 1
}

// LineText returns the text of a 1-based line without its terminator.
func (s *Source) LineText(line int) string {
	if line < 1 || line > len(s.lineStart) {
		return ""
	}
	start := s.lineStart[line-1]
	end := len(s.Text)
	if line < len(s.lineStart) {
		end = s.lineStart[line] - 1
	}
	if end > 0 && end <= len(s.Text) && end-1 < len(s.Text) && end-1 >= start && s.Text[end-1] == '\r' {
		end--
	}
	if start > end {
		return ""
	}
	return s.Text[start:end]
}

// Span is a half-open byte range [Start, End) with its 1-based line bounds.
type Span struct {
	Start     int `json:"start"`
	End       int `json:"end"`
	StartLine int `json:"startLine"`
	EndLine   int `json:"endLine"`
}

func (s *Source) span(start, end int) Span {
	if start < 0 {
		start = 0
	}
	if end > len(s.Text) {
		end = len(s.Text)
	}
	if end < start {
		end = start
	}
	return Span{Start: start, End: end, StartLine: s.LineOf(start), EndLine: s.LineOf(max(start, end-1))}
}

// Text returns the source text covered by a span.
func (s *Source) TextOf(sp Span) string {
	if sp.Start < 0 || sp.End > len(s.Text) || sp.Start > sp.End {
		return ""
	}
	return s.Text[sp.Start:sp.End]
}

// skipTrivia advances past whitespace, // line comments and /* */ block
// comments starting at off, returning the offset of the next real character.
func (s *Source) skipTrivia(off int) int {
	for off < len(s.Text) {
		c := s.Text[off]
		switch {
		case c == ' ' || c == '\t' || c == '\r' || c == '\n':
			off++
		case c == '/' && off+1 < len(s.Text) && s.Text[off+1] == '/':
			for off < len(s.Text) && s.Text[off] != '\n' {
				off++
			}
		case c == '/' && off+1 < len(s.Text) && s.Text[off+1] == '*':
			off += 2
			for off+1 < len(s.Text) && !(s.Text[off] == '*' && s.Text[off+1] == '/') {
				off++
			}
			off = min(off+2, len(s.Text))
		default:
			return off
		}
	}
	return off
}

// matchGroup scans a balanced bracket group that begins at the opening
// delimiter `open` at or after `from` (skipping only trivia in between).
// It returns the span covering the delimiters inclusive, the span covering
// just the interior, and whether a group was actually found.
//
// Nesting, string literals and comments inside the group are all handled, so
// `R<1/B>()[a, b]` and `PMSM<0.002, 0.15>(w_out)[va, vb, vc]` both scan
// correctly, as does a static arg containing a comparison or a nested call.
func (s *Source) matchGroup(from int, open, close byte) (outer Span, inner Span, ok bool) {
	i := s.skipTrivia(from)
	if i >= len(s.Text) || s.Text[i] != open {
		return Span{}, Span{}, false
	}
	start := i
	depth := 0
	for i < len(s.Text) {
		c := s.Text[i]
		switch {
		case c == '/' && i+1 < len(s.Text) && s.Text[i+1] == '/':
			for i < len(s.Text) && s.Text[i] != '\n' {
				i++
			}
			continue
		case c == '/' && i+1 < len(s.Text) && s.Text[i+1] == '*':
			i += 2
			for i+1 < len(s.Text) && !(s.Text[i] == '*' && s.Text[i+1] == '/') {
				i++
			}
			i = min(i+2, len(s.Text))
			continue
		case c == '"':
			i++
			for i < len(s.Text) && s.Text[i] != '"' {
				if s.Text[i] == '\\' {
					i++
				}
				i++
			}
			i++
			continue
		case c == open:
			depth++
		case c == close:
			depth--
			if depth == 0 {
				return s.span(start, i + 1), s.span(start+1, i), true
			}
		}
		i++
	}
	return Span{}, Span{}, false
}

// matchBraceBlock finds the `{ ... }` block at or after `from` and returns the
// span of the whole block. Used to determine where a module declaration ends,
// which the AST does not record.
func (s *Source) matchBraceBlock(from int) (Span, bool) {
	// Scan forward for the first '{' that is not inside a comment or string.
	i := from
	for i < len(s.Text) {
		c := s.Text[i]
		switch {
		case c == '/' && i+1 < len(s.Text) && s.Text[i+1] == '/':
			for i < len(s.Text) && s.Text[i] != '\n' {
				i++
			}
			continue
		case c == '/' && i+1 < len(s.Text) && s.Text[i+1] == '*':
			i += 2
			for i+1 < len(s.Text) && !(s.Text[i] == '*' && s.Text[i+1] == '/') {
				i++
			}
			i = min(i+2, len(s.Text))
			continue
		case c == '"':
			i++
			for i < len(s.Text) && s.Text[i] != '"' {
				if s.Text[i] == '\\' {
					i++
				}
				i++
			}
			i++
			continue
		case c == '{':
			outer, _, ok := s.matchGroup(i, '{', '}')
			return outer, ok
		}
		i++
	}
	return Span{}, false
}

// findSemicolon returns the offset just past the first top-level ';' at or
// after `from`, skipping comments and strings.
func (s *Source) findSemicolon(from int) int {
	i := from
	for i < len(s.Text) {
		c := s.Text[i]
		switch {
		case c == '/' && i+1 < len(s.Text) && s.Text[i+1] == '/':
			for i < len(s.Text) && s.Text[i] != '\n' {
				i++
			}
			continue
		case c == '/' && i+1 < len(s.Text) && s.Text[i+1] == '*':
			i += 2
			for i+1 < len(s.Text) && !(s.Text[i] == '*' && s.Text[i+1] == '/') {
				i++
			}
			i = min(i+2, len(s.Text))
			continue
		case c == '"':
			i++
			for i < len(s.Text) && s.Text[i] != '"' {
				if s.Text[i] == '\\' {
					i++
				}
				i++
			}
			i++
			continue
		case c == ';':
			return i + 1
		}
		i++
	}
	return len(s.Text)
}

// splitArgs splits the interior of an argument group on top-level commas,
// returning each argument's exact span. Commas nested inside brackets, braces,
// parens, strings or comments do not split.
func (s *Source) splitArgs(inner Span) []Span {
	var out []Span
	if inner.Start >= inner.End {
		return out
	}
	depth := 0
	segStart := inner.Start
	i := inner.Start
	for i < inner.End {
		c := s.Text[i]
		switch {
		case c == '/' && i+1 < inner.End && s.Text[i+1] == '/':
			for i < inner.End && s.Text[i] != '\n' {
				i++
			}
			continue
		case c == '/' && i+1 < inner.End && s.Text[i+1] == '*':
			i += 2
			for i+1 < inner.End && !(s.Text[i] == '*' && s.Text[i+1] == '/') {
				i++
			}
			i = min(i+2, inner.End)
			continue
		case c == '"':
			i++
			for i < inner.End && s.Text[i] != '"' {
				if s.Text[i] == '\\' {
					i++
				}
				i++
			}
			i++
			continue
		case c == '(' || c == '[' || c == '{' || c == '<':
			depth++
		case c == ')' || c == ']' || c == '}' || c == '>':
			depth--
		case c == ',' && depth == 0:
			out = append(out, s.trimSpan(s.span(segStart, i)))
			segStart = i + 1
		}
		i++
	}
	last := s.trimSpan(s.span(segStart, inner.End))
	if strings.TrimSpace(s.TextOf(last)) != "" || len(out) > 0 {
		out = append(out, last)
	}
	return out
}

// trimSpan shrinks a span to cover only its meaningful text, dropping
// whitespace and comments on either side. It works by walking the span once
// and remembering the first and last characters that are neither whitespace
// nor part of a comment, which handles padding on either side as well as
// comments that sit between the value and a delimiter — `a /* x */` trims to
// `a`, not `a /* x */`.
func (s *Source) trimSpan(sp Span) Span {
	first, last := -1, -1
	i := sp.Start
	for i < sp.End {
		c := s.Text[i]
		switch {
		case c == '/' && i+1 < sp.End && s.Text[i+1] == '/':
			for i < sp.End && s.Text[i] != '\n' {
				i++
			}
			continue
		case c == '/' && i+1 < sp.End && s.Text[i+1] == '*':
			i += 2
			for i+1 < sp.End && !(s.Text[i] == '*' && s.Text[i+1] == '/') {
				i++
			}
			i = min(i+2, sp.End)
			continue
		case c == ' ' || c == '\t' || c == '\r' || c == '\n':
			i++
			continue
		}
		if first == -1 {
			first = i
		}
		last = i
		i++
	}
	if first == -1 {
		return s.span(sp.Start, sp.Start)
	}
	return s.span(first, last+1)
}
