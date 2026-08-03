// Package plot loads simulation output and does the numeric work for the
// waveform viewer.
//
// All of it lives in Go on purpose. The previous browser-based viewer was slow
// for three separate reasons, and each is addressed here:
//
//   - a naive O(N·K) DFT, replaced by a radix-2 FFT (dsp.go)
//   - drawing every sample, replaced by min/max decimation to the pixel width
//   - parsing megabytes of CSV in JavaScript, replaced by a streaming parser
//
// The frontend receives at most a few thousand points per trace and only has
// to stroke them.
package plot

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Dataset is one loaded CSV: columns of float64, plus any columns computed
// afterwards by the maths and filter tools.
type Dataset struct {
	mu sync.RWMutex

	Path string
	Cols []string             // display order, including computed columns
	Data map[string][]float64 // column name -> samples
	Rows int
	XKey string // the column treated as the independent variable

	computed map[string]bool
}

// Load reads a CSV of numeric columns.
//
// The parser is deliberately simple rather than general: simulation output is
// a plain numeric table with a header row, so there are no quoted fields or
// embedded separators to handle, and skipping that machinery is most of the
// speed win over a general-purpose reader.
func Load(path string) (*Dataset, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)

	if !sc.Scan() {
		return nil, fmt.Errorf("%s is empty", path)
	}
	// Strip a UTF-8 BOM, which some tools put in front of the header.
	header := splitLine(strings.TrimPrefix(sc.Text(), "\ufeff"))
	if len(header) == 0 {
		return nil, fmt.Errorf("%s has no header row", path)
	}

	ds := &Dataset{
		Path:     path,
		Cols:     make([]string, 0, len(header)),
		Data:     make(map[string][]float64, len(header)),
		computed: map[string]bool{},
	}
	for i, h := range header {
		name := strings.TrimSpace(h)
		if name == "" {
			name = fmt.Sprintf("col%d", i+1)
		}
		// Duplicate headers would otherwise silently overwrite each other.
		base, n := name, 2
		for _, exists := ds.Data[name]; exists; _, exists = ds.Data[name] {
			name = fmt.Sprintf("%s_%d", base, n)
			n++
		}
		ds.Cols = append(ds.Cols, name)
		ds.Data[name] = make([]float64, 0, 4096)
	}

	fields := make([]string, 0, len(header))
	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields = splitLineInto(line, fields[:0])
		for i, name := range ds.Cols {
			var v float64
			if i < len(fields) {
				v, _ = strconv.ParseFloat(strings.TrimSpace(fields[i]), 64)
			}
			ds.Data[name] = append(ds.Data[name], v)
		}
		ds.Rows++
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if ds.Rows == 0 {
		return nil, fmt.Errorf("%s has a header but no data rows", path)
	}

	ds.XKey = guessXKey(ds.Cols)
	return ds, nil
}

// splitLine splits a CSV line on commas.
func splitLine(s string) []string {
	return splitLineInto(s, nil)
}

func splitLineInto(s string, dst []string) []string {
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == ',' {
			dst = append(dst, s[start:i])
			start = i + 1
		}
	}
	dst = append(dst, s[start:])
	// Tolerate CRLF input without paying for a full trim on every field.
	if n := len(dst); n > 0 {
		dst[n-1] = strings.TrimRight(dst[n-1], "\r")
	}
	return dst
}

// guessXKey picks the independent variable: a column literally called time,
// else the first column, which is where every hover run puts it.
func guessXKey(cols []string) string {
	for _, c := range cols {
		if strings.EqualFold(c, "time") {
			return c
		}
	}
	if len(cols) > 0 {
		return cols[0]
	}
	return ""
}

// Signals returns every column that can be plotted against the X column.
func (d *Dataset) Signals() []string {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]string, 0, len(d.Cols))
	for _, c := range d.Cols {
		if c != d.XKey {
			out = append(out, c)
		}
	}
	return out
}

// Column returns one column's samples.
func (d *Dataset) Column(name string) ([]float64, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	v, ok := d.Data[name]
	return v, ok
}

// AddColumn stores a computed column, replacing any previous one of that name.
func (d *Dataset) AddColumn(name string, values []float64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, exists := d.Data[name]; !exists {
		d.Cols = append(d.Cols, name)
	}
	d.Data[name] = values
	d.computed[name] = true
}

// IsComputed reports whether a column was produced by maths or filtering
// rather than read from the file.
func (d *Dataset) IsComputed(name string) bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.computed[name]
}

// RemoveColumn drops a computed column. Columns read from the file stay.
func (d *Dataset) RemoveColumn(name string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.computed[name] {
		return fmt.Errorf("%q came from the file and cannot be removed", name)
	}
	delete(d.Data, name)
	delete(d.computed, name)
	for i, c := range d.Cols {
		if c == name {
			d.Cols = append(d.Cols[:i], d.Cols[i+1:]...)
			break
		}
	}
	return nil
}

// Range reports the first and last value of the X column.
func (d *Dataset) Range() (lo, hi float64) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	x := d.Data[d.XKey]
	if len(x) == 0 {
		return 0, 0
	}
	return x[0], x[len(x)-1]
}

// Trace is one decimated series ready to stroke.
type Trace struct {
	Name string    `json:"name"`
	X    []float64 `json:"x"`
	Y    []float64 `json:"y"`
	Min  float64   `json:"min"`
	Max  float64   `json:"max"`
	N    int       `json:"n"` // samples the trace was reduced from
}

// Series decimates the requested columns over [x0, x1] down to `buckets`
// horizontal positions.
//
// Decimation keeps the minimum and maximum of each bucket rather than
// sampling one value from it. That is what makes a 500k-point trace look
// identical to the full-resolution one at screen resolution: a narrow spike
// that point-sampling would skip still lands in some bucket's max.
func (d *Dataset) Series(names []string, x0, x1 float64, buckets int) ([]Trace, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	x := d.Data[d.XKey]
	if len(x) == 0 {
		return nil, fmt.Errorf("no X column")
	}
	if buckets < 2 {
		buckets = 2
	}
	if x1 <= x0 {
		x0, x1 = x[0], x[len(x)-1]
	}

	lo := sort.SearchFloat64s(x, x0)
	hi := sort.SearchFloat64s(x, x1)
	if lo > 0 {
		lo-- // include the sample just before the window so the line enters it
	}
	if hi < len(x) {
		hi++
	}
	if hi > len(x) {
		hi = len(x)
	}
	if lo >= hi {
		return nil, fmt.Errorf("selected range contains no samples")
	}

	out := make([]Trace, 0, len(names))
	for _, name := range names {
		y, ok := d.Data[name]
		if !ok {
			continue
		}
		out = append(out, decimate(name, x, y, lo, hi, buckets))
	}
	return out, nil
}

// decimate reduces x[lo:hi] / y[lo:hi] to at most 2*buckets points.
func decimate(name string, x, y []float64, lo, hi, buckets int) Trace {
	n := hi - lo
	t := Trace{Name: name, N: n}

	if n <= buckets*2 {
		t.X = append(t.X, x[lo:hi]...)
		t.Y = append(t.Y, y[lo:min(hi, len(y))]...)
		t.Min, t.Max = minMax(t.Y)
		return t
	}

	t.X = make([]float64, 0, buckets*2)
	t.Y = make([]float64, 0, buckets*2)

	step := float64(n) / float64(buckets)
	gMin, gMax := 0.0, 0.0
	first := true

	for b := 0; b < buckets; b++ {
		s := lo + int(float64(b)*step)
		e := lo + int(float64(b+1)*step)
		if e > hi {
			e = hi
		}
		if s >= e || s >= len(y) {
			continue
		}
		if e > len(y) {
			e = len(y)
		}

		iMin, iMax := s, s
		vMin, vMax := y[s], y[s]
		for i := s + 1; i < e; i++ {
			if y[i] < vMin {
				vMin, iMin = y[i], i
			}
			if y[i] > vMax {
				vMax, iMax = y[i], i
			}
		}
		if first {
			gMin, gMax = vMin, vMax
			first = false
		} else {
			if vMin < gMin {
				gMin = vMin
			}
			if vMax > gMax {
				gMax = vMax
			}
		}

		// Emit in the order the extremes occur so the stroke keeps the
		// shape of the underlying waveform rather than zig-zagging.
		if iMin <= iMax {
			t.X = append(t.X, x[iMin], x[iMax])
			t.Y = append(t.Y, vMin, vMax)
		} else {
			t.X = append(t.X, x[iMax], x[iMin])
			t.Y = append(t.Y, vMax, vMin)
		}
	}
	t.Min, t.Max = gMin, gMax
	return t
}

func minMax(v []float64) (float64, float64) {
	if len(v) == 0 {
		return 0, 0
	}
	lo, hi := v[0], v[0]
	for _, x := range v[1:] {
		if x < lo {
			lo = x
		}
		if x > hi {
			hi = x
		}
	}
	return lo, hi
}

// IndexRange maps a time window to sample indices, clamped to the data.
func (d *Dataset) IndexRange(t0, t1 float64) (int, int) {
	x := d.Data[d.XKey]
	if len(x) == 0 {
		return 0, 0
	}
	lo, hi := 0, len(x)-1
	if t0 > x[0] {
		lo = sort.SearchFloat64s(x, t0)
		if lo >= len(x) {
			lo = len(x) - 1
		}
	}
	if t1 > 0 && t1 < x[len(x)-1] {
		hi = sort.SearchFloat64s(x, t1)
		if hi >= len(x) {
			hi = len(x) - 1
		}
	}
	if hi < lo {
		hi = lo
	}
	return lo, hi
}

// SampleRate estimates Fs from the mean spacing of the X column.
func (d *Dataset) SampleRate() float64 {
	x := d.Data[d.XKey]
	if len(x) < 2 {
		return 0
	}
	dur := x[len(x)-1] - x[0]
	if dur <= 0 {
		return 0
	}
	return float64(len(x)-1) / dur
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
