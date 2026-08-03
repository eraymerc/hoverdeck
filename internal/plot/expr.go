package plot

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// A small arithmetic expression evaluator for the maths channel feature,
// e.g. "main.v_out - main.v_in" or "sqrt(abs(i_d)) * 1.5".
//
// The browser version built these with `new Function`, handing the expression
// straight to the JavaScript engine. That is not available here and would not
// be a good idea anyway: this evaluator only knows arithmetic, a fixed set of
// maths functions, and the dataset's own column names, so a typo produces a
// clear error instead of arbitrary code.
//
// Column names contain dots (main.lc_out), so identifiers deliberately allow
// '.' as an interior character.

type exprNode interface {
	eval(row int, cols map[string][]float64) float64
}

type numNode float64

func (n numNode) eval(int, map[string][]float64) float64 { return float64(n) }

type colNode string

func (c colNode) eval(row int, cols map[string][]float64) float64 {
	v := cols[string(c)]
	if row < len(v) {
		return v[row]
	}
	return math.NaN()
}

type binNode struct {
	op   byte
	l, r exprNode
}

func (b binNode) eval(row int, cols map[string][]float64) float64 {
	l := b.l.eval(row, cols)
	r := b.r.eval(row, cols)
	switch b.op {
	case '+':
		return l + r
	case '-':
		return l - r
	case '*':
		return l * r
	case '/':
		return l / r // ±Inf on divide-by-zero, which plots as a gap
	case '%':
		return math.Mod(l, r)
	case '^':
		return math.Pow(l, r)
	}
	return math.NaN()
}

type negNode struct{ x exprNode }

func (n negNode) eval(row int, cols map[string][]float64) float64 {
	return -n.x.eval(row, cols)
}

type callNode struct {
	fn   string
	args []exprNode
}

func (c callNode) eval(row int, cols map[string][]float64) float64 {
	a := make([]float64, len(c.args))
	for i, arg := range c.args {
		a[i] = arg.eval(row, cols)
	}
	switch c.fn {
	case "abs":
		return math.Abs(a[0])
	case "sqrt":
		return math.Sqrt(a[0])
	case "sin":
		return math.Sin(a[0])
	case "cos":
		return math.Cos(a[0])
	case "tan":
		return math.Tan(a[0])
	case "atan":
		return math.Atan(a[0])
	case "exp":
		return math.Exp(a[0])
	case "log":
		return math.Log(a[0])
	case "log10":
		return math.Log10(a[0])
	case "floor":
		return math.Floor(a[0])
	case "ceil":
		return math.Ceil(a[0])
	case "sign":
		if a[0] > 0 {
			return 1
		} else if a[0] < 0 {
			return -1
		}
		return 0
	case "min":
		return math.Min(a[0], a[1])
	case "max":
		return math.Max(a[0], a[1])
	case "pow":
		return math.Pow(a[0], a[1])
	case "atan2":
		return math.Atan2(a[0], a[1])
	}
	return math.NaN()
}

// funcArity lists the callable functions and how many arguments each takes.
var funcArity = map[string]int{
	"abs": 1, "sqrt": 1, "sin": 1, "cos": 1, "tan": 1, "atan": 1,
	"exp": 1, "log": 1, "log10": 1, "floor": 1, "ceil": 1, "sign": 1,
	"min": 2, "max": 2, "pow": 2, "atan2": 2,
}

// ── Lexer ────────────────────────────────────────────────────────────────────

type tokKind int

const (
	tkEOF tokKind = iota
	tkNum
	tkIdent
	tkOp
	tkLParen
	tkRParen
	tkComma
)

type token struct {
	kind tokKind
	s    string
	num  float64
	pos  int
}

func lexExpr(s string) ([]token, error) {
	var out []token
	i := 0
	for i < len(s) {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c >= '0' && c <= '9' || (c == '.' && i+1 < len(s) && s[i+1] >= '0' && s[i+1] <= '9'):
			j := i
			for j < len(s) && (s[j] >= '0' && s[j] <= '9' || s[j] == '.') {
				j++
			}
			if j < len(s) && (s[j] == 'e' || s[j] == 'E') {
				k := j + 1
				if k < len(s) && (s[k] == '+' || s[k] == '-') {
					k++
				}
				if k < len(s) && s[k] >= '0' && s[k] <= '9' {
					for k < len(s) && s[k] >= '0' && s[k] <= '9' {
						k++
					}
					j = k
				}
			}
			v, err := strconv.ParseFloat(s[i:j], 64)
			if err != nil {
				return nil, fmt.Errorf("bad number %q", s[i:j])
			}
			out = append(out, token{kind: tkNum, num: v, pos: i})
			i = j
		case isIdentStart(c):
			j := i
			for j < len(s) && isIdentPart(s[j]) {
				j++
			}
			out = append(out, token{kind: tkIdent, s: s[i:j], pos: i})
			i = j
		case c == '(':
			out = append(out, token{kind: tkLParen, pos: i})
			i++
		case c == ')':
			out = append(out, token{kind: tkRParen, pos: i})
			i++
		case c == ',':
			out = append(out, token{kind: tkComma, pos: i})
			i++
		case strings.IndexByte("+-*/%^", c) >= 0:
			// ** is accepted as a synonym for ^, matching Hover's own power
			// operator, so an expression can be pasted from a .hvr file.
			if c == '*' && i+1 < len(s) && s[i+1] == '*' {
				out = append(out, token{kind: tkOp, s: "^", pos: i})
				i += 2
				continue
			}
			out = append(out, token{kind: tkOp, s: string(c), pos: i})
			i++
		default:
			return nil, fmt.Errorf("unexpected character %q at position %d", string(c), i+1)
		}
	}
	out = append(out, token{kind: tkEOF, pos: len(s)})
	return out, nil
}

func isIdentStart(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_'
}

func isIdentPart(c byte) bool {
	return isIdentStart(c) || c >= '0' && c <= '9' || c == '.'
}

// ── Parser (precedence climbing) ─────────────────────────────────────────────

type exprParser struct {
	toks []token
	pos  int
	cols map[string]bool
	used map[string]bool
}

func (p *exprParser) peek() token  { return p.toks[p.pos] }
func (p *exprParser) next() token  { t := p.toks[p.pos]; p.pos++; return t }

func precOf(op string) int {
	switch op {
	case "+", "-":
		return 1
	case "*", "/", "%":
		return 2
	case "^":
		return 3
	}
	return 0
}

func (p *exprParser) parseExpr(minPrec int) (exprNode, error) {
	lhs, err := p.parseUnary()
	if err != nil {
		return nil, err
	}
	for {
		t := p.peek()
		if t.kind != tkOp {
			return lhs, nil
		}
		prec := precOf(t.s)
		if prec < minPrec {
			return lhs, nil
		}
		p.next()
		// ^ is right-associative, the rest left-associative.
		nextMin := prec + 1
		if t.s == "^" {
			nextMin = prec
		}
		rhs, err := p.parseExpr(nextMin)
		if err != nil {
			return nil, err
		}
		lhs = binNode{op: t.s[0], l: lhs, r: rhs}
	}
}

func (p *exprParser) parseUnary() (exprNode, error) {
	t := p.peek()
	if t.kind == tkOp && (t.s == "-" || t.s == "+") {
		p.next()
		x, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		if t.s == "-" {
			return negNode{x}, nil
		}
		return x, nil
	}
	return p.parsePrimary()
}

func (p *exprParser) parsePrimary() (exprNode, error) {
	t := p.next()
	switch t.kind {
	case tkNum:
		return numNode(t.num), nil

	case tkLParen:
		inner, err := p.parseExpr(1)
		if err != nil {
			return nil, err
		}
		if p.next().kind != tkRParen {
			return nil, fmt.Errorf("missing closing parenthesis")
		}
		return inner, nil

	case tkIdent:
		// A call if followed by '(' — otherwise a column or constant.
		if p.peek().kind == tkLParen {
			arity, ok := funcArity[strings.ToLower(t.s)]
			if !ok {
				return nil, fmt.Errorf("unknown function %q", t.s)
			}
			p.next() // consume '('
			var args []exprNode
			if p.peek().kind != tkRParen {
				for {
					a, err := p.parseExpr(1)
					if err != nil {
						return nil, err
					}
					args = append(args, a)
					if p.peek().kind == tkComma {
						p.next()
						continue
					}
					break
				}
			}
			if p.next().kind != tkRParen {
				return nil, fmt.Errorf("missing closing parenthesis after %s(", t.s)
			}
			if len(args) != arity {
				return nil, fmt.Errorf("%s() takes %d argument(s), got %d", t.s, arity, len(args))
			}
			return callNode{fn: strings.ToLower(t.s), args: args}, nil
		}

		switch strings.ToLower(t.s) {
		case "pi":
			return numNode(math.Pi), nil
		case "e":
			return numNode(math.E), nil
		}
		if !p.cols[t.s] {
			return nil, fmt.Errorf("unknown signal %q", t.s)
		}
		p.used[t.s] = true
		return colNode(t.s), nil
	}
	return nil, fmt.Errorf("unexpected token at position %d", t.pos+1)
}

// Compute evaluates expr for every row and stores the result as `name`.
//
// The expression is parsed once into a tree and then evaluated per row, so the
// parsing cost is paid a single time no matter how many samples there are.
func (d *Dataset) Compute(name, expr string) ([]float64, error) {
	if strings.TrimSpace(expr) == "" {
		return nil, fmt.Errorf("the expression is empty")
	}
	if strings.TrimSpace(name) == "" {
		return nil, fmt.Errorf("give the new curve a name")
	}

	toks, err := lexExpr(expr)
	if err != nil {
		return nil, err
	}

	d.mu.RLock()
	cols := make(map[string]bool, len(d.Data))
	for k := range d.Data {
		cols[k] = true
	}
	data := d.Data
	rows := d.Rows
	d.mu.RUnlock()

	p := &exprParser{toks: toks, cols: cols, used: map[string]bool{}}
	tree, err := p.parseExpr(1)
	if err != nil {
		return nil, err
	}
	if p.peek().kind != tkEOF {
		return nil, fmt.Errorf("unexpected trailing input at position %d", p.peek().pos+1)
	}
	// An expression referencing no signal is allowed on purpose: a constant
	// like "3.3" is a useful horizontal reference line to compare a waveform
	// against. Typos cannot slip through this way, because an unrecognised
	// identifier is already rejected as an unknown signal.

	out := make([]float64, rows)
	for i := 0; i < rows; i++ {
		out[i] = tree.eval(i, data)
	}
	return out, nil
}
