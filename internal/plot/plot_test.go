package plot

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeCSV builds a dataset file from a generator function.
func writeCSV(t *testing.T, cols []string, rows int, gen func(i int) []float64) string {
	t.Helper()
	var b strings.Builder
	b.WriteString(strings.Join(cols, ","))
	b.WriteByte('\n')
	for i := 0; i < rows; i++ {
		vals := gen(i)
		parts := make([]string, len(vals))
		for j, v := range vals {
			parts[j] = fmt.Sprintf("%g", v)
		}
		b.WriteString(strings.Join(parts, ","))
		b.WriteByte('\n')
	}
	p := filepath.Join(t.TempDir(), "out.csv")
	if err := os.WriteFile(p, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// sineDataset is a 1 kHz, 2 V-amplitude sine sampled at 100 kHz.
func sineDataset(t *testing.T) *Dataset {
	t.Helper()
	const fs = 100000.0
	p := writeCSV(t, []string{"Time", "v_out"}, 10000, func(i int) []float64 {
		tt := float64(i) / fs
		return []float64{tt, 2 * math.Sin(2*math.Pi*1000*tt)}
	})
	d, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestLoadParsesHeaderAndColumns(t *testing.T) {
	d := sineDataset(t)
	if d.Rows != 10000 {
		t.Errorf("rows: got %d, want 10000", d.Rows)
	}
	if d.XKey != "Time" {
		t.Errorf("X key: got %q, want Time", d.XKey)
	}
	if got := d.Signals(); len(got) != 1 || got[0] != "v_out" {
		t.Errorf("signals: got %v", got)
	}
	if fs := d.SampleRate(); math.Abs(fs-100000) > 1 {
		t.Errorf("sample rate: got %g, want ~100000", fs)
	}
}

func TestLoadHandlesDuplicateAndBlankHeaders(t *testing.T) {
	p := writeCSV(t, []string{"Time", "v", "v", ""}, 3, func(i int) []float64 {
		return []float64{float64(i), 1, 2, 3}
	})
	d, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	// Duplicates must not silently overwrite each other.
	if len(d.Cols) != 4 {
		t.Fatalf("want 4 distinct columns, got %v", d.Cols)
	}
	if d.Cols[2] != "v_2" {
		t.Errorf("duplicate column should be renamed, got %q", d.Cols[2])
	}
	if d.Cols[3] != "col4" {
		t.Errorf("blank header should be named, got %q", d.Cols[3])
	}
}

func TestFFTFindsFundamentalWithCorrectAmplitude(t *testing.T) {
	d := sineDataset(t)
	sp, err := d.Spectrum(FFTOptions{
		Column: "v_out", Window: "hanning", Points: 4096, RemoveDC: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	// A 1 kHz input must peak at 1 kHz, within one frequency bin.
	binWidth := sp.Fs / float64(sp.N)
	if math.Abs(sp.PeakF-1000) > 2*binWidth {
		t.Errorf("peak frequency: got %.1f Hz, want ~1000 Hz (bin %.1f Hz)", sp.PeakF, binWidth)
	}
	// The window's amplitude correction should recover the true 2 V peak.
	if math.Abs(sp.Peak-2.0) > 0.1 {
		t.Errorf("peak magnitude: got %.4f, want ~2.0", sp.Peak)
	}
}

func TestFFTMatchesNaiveDFT(t *testing.T) {
	// The radix-2 FFT must agree with the direct summation the old viewer
	// used — this is the correctness anchor for the 170x speed-up.
	const n = 256
	re := make([]float64, n)
	im := make([]float64, n)
	sig := make([]float64, n)
	for i := 0; i < n; i++ {
		sig[i] = math.Sin(2*math.Pi*5*float64(i)/n) + 0.5*math.Cos(2*math.Pi*13*float64(i)/n)
		re[i] = sig[i]
	}
	fftRadix2(re, im)

	for k := 0; k < n/2; k++ {
		var sr, si float64
		for j := 0; j < n; j++ {
			ang := 2 * math.Pi * float64(k) * float64(j) / n
			sr += sig[j] * math.Cos(ang)
			si -= sig[j] * math.Sin(ang)
		}
		gotMag := math.Hypot(re[k], im[k])
		wantMag := math.Hypot(sr, si)
		if math.Abs(gotMag-wantMag) > 1e-6*math.Max(1, wantMag) {
			t.Fatalf("bin %d: fft magnitude %g, naive DFT %g", k, gotMag, wantMag)
		}
	}
}

func TestMeasureOnKnownSine(t *testing.T) {
	d := sineDataset(t)
	m, err := d.Measure("v_out", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(m.Max-2) > 0.01 || math.Abs(m.Min+2) > 0.01 {
		t.Errorf("min/max: got %.4f/%.4f, want ~-2/2", m.Min, m.Max)
	}
	if math.Abs(m.PkPk-4) > 0.02 {
		t.Errorf("peak-to-peak: got %.4f, want ~4", m.PkPk)
	}
	if math.Abs(m.Avg) > 0.01 {
		t.Errorf("mean of a full-cycle sine should be ~0, got %.4f", m.Avg)
	}
	// RMS of a 2 V amplitude sine is 2/sqrt(2).
	if math.Abs(m.RMS-2/math.Sqrt2) > 0.01 {
		t.Errorf("RMS: got %.4f, want %.4f", m.RMS, 2/math.Sqrt2)
	}
}

func TestMeasureRespectsTimeWindow(t *testing.T) {
	// A ramp makes the window boundaries easy to verify.
	p := writeCSV(t, []string{"Time", "y"}, 1001, func(i int) []float64 {
		tt := float64(i) / 1000
		return []float64{tt, tt}
	})
	d, _ := Load(p)

	m, err := d.Measure("y", 0.2, 0.4)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(m.Min-0.2) > 1e-3 || math.Abs(m.Max-0.4) > 1e-3 {
		t.Errorf("window not honoured: min %.4f max %.4f, want 0.2/0.4", m.Min, m.Max)
	}
	if math.Abs(m.Avg-0.3) > 1e-3 {
		t.Errorf("windowed mean: got %.4f, want ~0.3", m.Avg)
	}
}

func TestTHDOfPureSineIsSmall(t *testing.T) {
	d := sineDataset(t)
	r, err := d.THD(FFTOptions{Column: "v_out", Window: "hanning", Points: 8192, RemoveDC: true})
	if err != nil {
		t.Fatal(err)
	}
	if r.THD > 5 {
		t.Errorf("a pure sine should have low THD, got %.2f%%", r.THD)
	}
	if math.Abs(r.FundFreq-1000) > 30 {
		t.Errorf("fundamental: got %.1f Hz, want ~1000", r.FundFreq)
	}
}

func TestTHDOfDistortedSineIsLarger(t *testing.T) {
	const fs = 100000.0
	// Fundamental plus a 30% third harmonic: THD should be around 30%.
	p := writeCSV(t, []string{"Time", "y"}, 20000, func(i int) []float64 {
		tt := float64(i) / fs
		return []float64{tt, math.Sin(2*math.Pi*1000*tt) + 0.3*math.Sin(2*math.Pi*3000*tt)}
	})
	d, _ := Load(p)
	r, err := d.THD(FFTOptions{Column: "y", Window: "hanning", Points: 8192, RemoveDC: true})
	if err != nil {
		t.Fatal(err)
	}
	if r.THD < 20 || r.THD > 45 {
		t.Errorf("THD: got %.2f%%, expected roughly 30%%", r.THD)
	}
}

func TestDecimationPreservesExtremes(t *testing.T) {
	// A flat signal with one narrow spike. Point-sampling would miss the
	// spike entirely; min/max decimation must keep it.
	const n = 100000
	p := writeCSV(t, []string{"Time", "y"}, n, func(i int) []float64 {
		v := 0.0
		if i == 54321 {
			v = 9.5
		}
		return []float64{float64(i) * 1e-6, v}
	})
	d, _ := Load(p)

	traces, err := d.Series([]string{"y"}, 0, 0, 800)
	if err != nil {
		t.Fatal(err)
	}
	tr := traces[0]
	if len(tr.X) > 1700 {
		t.Errorf("decimation should cap the point count, got %d", len(tr.X))
	}
	if math.Abs(tr.Max-9.5) > 1e-9 {
		t.Errorf("the spike was lost by decimation: max is %g", tr.Max)
	}
	found := false
	for _, v := range tr.Y {
		if math.Abs(v-9.5) < 1e-9 {
			found = true
		}
	}
	if !found {
		t.Error("the spike is missing from the emitted points")
	}
	if tr.N != n {
		t.Errorf("trace should report the original sample count, got %d", tr.N)
	}
}

func TestSeriesWindowNarrowsData(t *testing.T) {
	d := sineDataset(t)
	all, _ := d.Series([]string{"v_out"}, 0, 0, 500)
	win, _ := d.Series([]string{"v_out"}, 0.01, 0.02, 500)
	if win[0].N >= all[0].N {
		t.Errorf("a narrower window should cover fewer samples: %d vs %d", win[0].N, all[0].N)
	}
}

func TestMovingAverageSmoothsAndStaysAligned(t *testing.T) {
	const fs = 10000.0
	p := writeCSV(t, []string{"Time", "y"}, 4000, func(i int) []float64 {
		tt := float64(i) / fs
		// 50 Hz signal plus 2 kHz noise.
		return []float64{tt, math.Sin(2*math.Pi*50*tt) + 0.4*math.Sin(2*math.Pi*2000*tt)}
	})
	d, _ := Load(p)

	name, out, err := d.Filter(FilterOptions{Column: "y", Type: "ma", Points: 20})
	if err != nil {
		t.Fatal(err)
	}
	if name != "y_MA20" {
		t.Errorf("name: got %q", name)
	}
	d.AddColumn(name, out)

	before, _ := d.Measure("y", 0.1, 0.3)
	after, _ := d.Measure(name, 0.1, 0.3)
	if after.RMS >= before.RMS {
		t.Errorf("smoothing should reduce RMS: %.4f -> %.4f", before.RMS, after.RMS)
	}
}

func TestButterworthLowPassRemovesHighFrequency(t *testing.T) {
	const fs = 100000.0
	p := writeCSV(t, []string{"Time", "y"}, 20000, func(i int) []float64 {
		tt := float64(i) / fs
		return []float64{tt, math.Sin(2*math.Pi*100*tt) + math.Sin(2*math.Pi*10000*tt)}
	})
	d, _ := Load(p)

	_, out, err := d.Filter(FilterOptions{Column: "y", Type: "butter_lp", FC1: 1000})
	if err != nil {
		t.Fatal(err)
	}
	d.AddColumn("filtered", out)

	// The 10 kHz component should be strongly attenuated, the 100 Hz kept.
	sp, err := d.Spectrum(FFTOptions{Column: "filtered", Window: "hanning", Points: 8192, RemoveDC: true})
	if err != nil {
		t.Fatal(err)
	}
	var lowMag, highMag float64
	for i, f := range sp.Freqs {
		if math.Abs(f-100) < 40 && sp.Mags[i] > lowMag {
			lowMag = sp.Mags[i]
		}
		if math.Abs(f-10000) < 200 && sp.Mags[i] > highMag {
			highMag = sp.Mags[i]
		}
	}
	if lowMag < 0.5 {
		t.Errorf("passband component was attenuated: %.4f", lowMag)
	}
	if highMag > 0.05 {
		t.Errorf("stopband component survived: %.4f", highMag)
	}
}

func TestFilterRejectsCutoffAboveNyquist(t *testing.T) {
	d := sineDataset(t) // fs = 100 kHz, Nyquist = 50 kHz
	for _, ft := range []string{"butter_lp", "ideal_lp"} {
		if _, _, err := d.Filter(FilterOptions{Column: "v_out", Type: ft, FC1: 90000}); err == nil {
			t.Errorf("%s: expected a cutoff above Nyquist to be rejected", ft)
		}
	}
	if _, _, err := d.Filter(FilterOptions{Column: "v_out", Type: "ideal_bp", FC1: 2000, FC2: 1000}); err == nil {
		t.Error("expected band-pass with f_high < f_low to be rejected")
	}
}

func TestComputeExpressions(t *testing.T) {
	p := writeCSV(t, []string{"Time", "main.a", "main.b"}, 100, func(i int) []float64 {
		return []float64{float64(i), float64(i) * 2, float64(i) * 3}
	})
	d, _ := Load(p)

	cases := []struct {
		expr string
		row  int
		want float64
	}{
		{"main.b - main.a", 10, 10},          // dotted column names
		{"main.a * 2 + 1", 5, 21},            // precedence
		{"(main.a + main.b) / 5", 5, 5},      // parentheses
		{"-main.a", 4, -8},                   // unary minus
		{"main.a ** 2", 3, 36},               // Hover-style power
		{"2 ^ 3", 0, 8},                      // right-assoc power
		{"sqrt(main.b * 9)", 3, 9},           // function call: sqrt(9*9)
		{"max(main.a, main.b)", 7, 21},       // two-argument function
		{"abs(main.a - main.b)", 9, 9},       // nested
	}
	for _, c := range cases {
		got, err := d.Compute("tmp", c.expr)
		if err != nil {
			t.Errorf("%q: %v", c.expr, err)
			continue
		}
		if math.Abs(got[c.row]-c.want) > 1e-9 {
			t.Errorf("%q at row %d: got %g, want %g", c.expr, c.row, got[c.row], c.want)
		}
	}
}

func TestComputeRejectsBadExpressions(t *testing.T) {
	p := writeCSV(t, []string{"Time", "a"}, 10, func(i int) []float64 {
		return []float64{float64(i), 1}
	})
	d, _ := Load(p)

	for _, expr := range []string{
		"",              // empty
		"nosuch + 1",    // unknown signal
		"a +",           // truncated
		"(a",            // unbalanced
		"bogus(a)",      // unknown function
		"max(a)",        // wrong arity
		"a $ 2",         // illegal character
	} {
		if _, err := d.Compute("x", expr); err == nil {
			t.Errorf("expected %q to be rejected", expr)
		}
	}
}

func TestComputedColumnLifecycle(t *testing.T) {
	d := sineDataset(t)
	vals, err := d.Compute("double", "v_out * 2")
	if err != nil {
		t.Fatal(err)
	}
	d.AddColumn("double", vals)

	if !d.IsComputed("double") {
		t.Error("computed column should be flagged")
	}
	if d.IsComputed("v_out") {
		t.Error("a column from the file must not be flagged as computed")
	}
	if err := d.RemoveColumn("v_out"); err == nil {
		t.Error("removing a file column should be refused")
	}
	if err := d.RemoveColumn("double"); err != nil {
		t.Errorf("removing a computed column should work: %v", err)
	}
	if _, ok := d.Column("double"); ok {
		t.Error("column still present after removal")
	}
}

func TestLoadRejectsEmptyAndHeaderOnly(t *testing.T) {
	dir := t.TempDir()
	empty := filepath.Join(dir, "empty.csv")
	os.WriteFile(empty, nil, 0o644)
	if _, err := Load(empty); err == nil {
		t.Error("expected an empty file to be rejected")
	}

	hdr := filepath.Join(dir, "hdr.csv")
	os.WriteFile(hdr, []byte("Time,v\n"), 0o644)
	if _, err := Load(hdr); err == nil {
		t.Error("expected a header-only file to be rejected")
	}
}
