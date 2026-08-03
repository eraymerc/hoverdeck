package plot

import (
	"fmt"
	"math"
)

// ── Resampling ───────────────────────────────────────────────────────────────

// resampleUniform linearly interpolates a signal onto n evenly spaced points.
//
// Adaptive solvers emit unevenly spaced timesteps, and every frequency-domain
// operation below assumes a constant sample interval, so this runs first.
func resampleUniform(t, v []float64, n int) (out []float64, fs float64) {
	if len(t) < 2 || n < 2 {
		return nil, 0
	}
	t0, t1 := t[0], t[len(t)-1]
	dt := (t1 - t0) / float64(n-1)
	if dt <= 0 {
		return nil, 0
	}
	out = make([]float64, n)
	idx := 0
	for i := 0; i < n; i++ {
		target := t0 + float64(i)*dt
		for idx < len(t)-2 && t[idx+1] <= target {
			idx++
		}
		a, b := t[idx], t[idx+1]
		va, vb := v[idx], v[idx+1]
		if b == a {
			out[i] = va
			continue
		}
		out[i] = va + (target-a)/(b-a)*(vb-va)
	}
	return out, 1.0 / dt
}

// ── FFT ──────────────────────────────────────────────────────────────────────

// fftRadix2 performs an in-place iterative Cooley-Tukey FFT.
//
// This is the main reason the viewer is fast: the previous implementation
// evaluated the DFT sum directly, which is O(N·K) — about 8.4 million
// trigonometric evaluations for a 4096-point transform. This is O(N log N),
// roughly 49 thousand butterfly operations for the same input.
//
// len(re) must be a power of two.
func fftRadix2(re, im []float64) {
	n := len(re)
	if n <= 1 {
		return
	}

	// Bit-reversal permutation.
	for i, j := 1, 0; i < n; i++ {
		bit := n >> 1
		for ; j&bit != 0; bit >>= 1 {
			j ^= bit
		}
		j |= bit
		if i < j {
			re[i], re[j] = re[j], re[i]
			im[i], im[j] = im[j], im[i]
		}
	}

	for length := 2; length <= n; length <<= 1 {
		ang := -2 * math.Pi / float64(length)
		wRe, wIm := math.Cos(ang), math.Sin(ang)
		for i := 0; i < n; i += length {
			curRe, curIm := 1.0, 0.0
			half := length / 2
			for j := 0; j < half; j++ {
				uRe, uIm := re[i+j], im[i+j]
				vRe := re[i+j+half]*curRe - im[i+j+half]*curIm
				vIm := re[i+j+half]*curIm + im[i+j+half]*curRe

				re[i+j], im[i+j] = uRe+vRe, uIm+vIm
				re[i+j+half], im[i+j+half] = uRe-vRe, uIm-vIm

				curRe, curIm = curRe*wRe-curIm*wIm, curRe*wIm+curIm*wRe
			}
		}
	}
}

func nextPow2(n int) int {
	p := 1
	for p < n {
		p <<= 1
	}
	return p
}

// windowFn returns the window taper and its amplitude correction factor.
// The correction restores the true peak amplitude that tapering removes, so
// a 1 V sine still reads 1 V in the spectrum.
func windowFn(kind string, n int) (w []float64, acf float64) {
	w = make([]float64, n)
	den := float64(n - 1)
	switch kind {
	case "hamming":
		acf = 1.8518
		for i := range w {
			w[i] = 0.54 - 0.46*math.Cos(2*math.Pi*float64(i)/den)
		}
	case "blackman":
		acf = 2.38
		for i := range w {
			x := float64(i) / den
			w[i] = 0.42 - 0.5*math.Cos(2*math.Pi*x) + 0.08*math.Cos(4*math.Pi*x)
		}
	case "none", "rect", "rectangular":
		acf = 1.0
		for i := range w {
			w[i] = 1
		}
	default: // hanning
		acf = 2.0
		for i := range w {
			w[i] = 0.5 * (1 - math.Cos(2*math.Pi*float64(i)/den))
		}
	}
	return w, acf
}

// Spectrum is a magnitude spectrum plus the analysis parameters used.
type Spectrum struct {
	Freqs []float64 `json:"freqs"`
	Mags  []float64 `json:"mags"`
	Fs    float64   `json:"fs"`
	N     int       `json:"n"`
	Peak  float64   `json:"peak"`
	PeakF float64   `json:"peakF"`
}

// FFTOptions configures a spectrum computation.
type FFTOptions struct {
	Column   string  `json:"column"`
	TStart   float64 `json:"tStart"`
	TEnd     float64 `json:"tEnd"`
	FMin     float64 `json:"fMin"`
	FMax     float64 `json:"fMax"`
	Window   string  `json:"window"`
	Points   int     `json:"points"`
	RemoveDC bool    `json:"removeDC"`
}

// Spectrum computes the single-sided magnitude spectrum of one column.
func (d *Dataset) Spectrum(o FFTOptions) (*Spectrum, error) {
	d.mu.RLock()
	y, ok := d.Data[o.Column]
	x := d.Data[d.XKey]
	d.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("no such signal: %s", o.Column)
	}

	lo, hi := d.IndexRange(o.TStart, o.TEnd)
	if hi-lo < 8 {
		return nil, fmt.Errorf("time window is too short to analyse")
	}
	seg, segT := y[lo:hi+1], x[lo:hi+1]

	n := nextPow2(o.Points)
	if n < 256 {
		n = 4096
	}
	sig, fs := resampleUniform(segT, seg, n)
	if fs <= 0 {
		return nil, fmt.Errorf("could not determine the sample rate")
	}

	if o.RemoveDC {
		var sum float64
		for _, v := range sig {
			sum += v
		}
		mean := sum / float64(n)
		for i := range sig {
			sig[i] -= mean
		}
	}

	w, acf := windowFn(o.Window, n)
	re := make([]float64, n)
	im := make([]float64, n)
	for i := range sig {
		re[i] = sig[i] * w[i]
	}
	fftRadix2(re, im)

	half := n / 2
	kStart, kEnd := 0, half
	if o.FMin > 0 {
		kStart = int(math.Floor(o.FMin * float64(n) / fs))
	}
	if o.FMax > 0 {
		kEnd = int(math.Ceil(o.FMax * float64(n) / fs))
	}
	kStart = clampInt(kStart, 0, half)
	kEnd = clampInt(kEnd, kStart, half)

	sp := &Spectrum{Fs: fs, N: n}
	scale := 2.0 * acf / float64(n)
	for k := kStart; k <= kEnd; k++ {
		mag := scale * math.Hypot(re[k], im[k])
		switch {
		case k == 0 && o.RemoveDC:
			mag = 0
		case k == 0:
			mag /= 2 // DC is not mirrored, so it is not doubled
		}
		sp.Freqs = append(sp.Freqs, float64(k)*fs/float64(n))
		sp.Mags = append(sp.Mags, mag)
		if k > 0 && mag > sp.Peak {
			sp.Peak, sp.PeakF = mag, float64(k)*fs/float64(n)
		}
	}
	return sp, nil
}

// THDResult reports total harmonic distortion for one signal.
type THDResult struct {
	Column    string  `json:"column"`
	THD       float64 `json:"thd"`
	FundFreq  float64 `json:"fundFreq"`
	FundRMS   float64 `json:"fundRMS"`
	TotalRMS  float64 `json:"totalRMS"`
	TStart    float64 `json:"tStart"`
	TEnd      float64 `json:"tEnd"`
}

// THD measures distortion as the RMS of everything that is not the
// fundamental, relative to the fundamental — the same definition the previous
// viewer used, so results stay comparable.
func (d *Dataset) THD(o FFTOptions) (*THDResult, error) {
	d.mu.RLock()
	y, ok := d.Data[o.Column]
	x := d.Data[d.XKey]
	d.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("no such signal: %s", o.Column)
	}

	lo, hi := d.IndexRange(o.TStart, o.TEnd)
	if hi-lo < 10 {
		return nil, fmt.Errorf("time window is too short for THD")
	}
	seg := y[lo : hi+1]

	var dc float64
	if o.RemoveDC {
		var sum float64
		for _, v := range seg {
			sum += v
		}
		dc = sum / float64(len(seg))
	}
	var sumSq float64
	for _, v := range seg {
		e := v - dc
		sumSq += e * e
	}
	totalRMS := math.Sqrt(sumSq / float64(len(seg)))

	// The fundamental is taken as the largest non-DC spectral peak.
	full := o
	full.FMin, full.FMax = 0, 0
	sp, err := d.Spectrum(full)
	if err != nil {
		return nil, err
	}
	if sp.Peak == 0 {
		return nil, fmt.Errorf("no fundamental found — the signal looks like DC or noise")
	}

	fundRMS := sp.Peak / math.Sqrt2
	rest := totalRMS*totalRMS - fundRMS*fundRMS
	if rest < 0 {
		rest = 0
	}
	return &THDResult{
		Column:   o.Column,
		THD:      math.Sqrt(rest) / fundRMS * 100,
		FundFreq: sp.PeakF,
		FundRMS:  fundRMS,
		TotalRMS: totalRMS,
		TStart:   x[lo],
		TEnd:     x[hi],
	}, nil
}

// ── Measurements ─────────────────────────────────────────────────────────────

// Measurement is a time-bounded summary of one signal.
type Measurement struct {
	Column string  `json:"column"`
	Max    float64 `json:"max"`
	Min    float64 `json:"min"`
	PkPk   float64 `json:"pkpk"`
	Avg    float64 `json:"avg"`
	RMS    float64 `json:"rms"`
	TStart float64 `json:"tStart"`
	TEnd   float64 `json:"tEnd"`
	N      int     `json:"n"`
}

// Measure computes max, min, peak-to-peak, mean and RMS over a time window.
func (d *Dataset) Measure(column string, t0, t1 float64) (*Measurement, error) {
	d.mu.RLock()
	y, ok := d.Data[column]
	x := d.Data[d.XKey]
	d.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("no such signal: %s", column)
	}

	lo, hi := d.IndexRange(t0, t1)
	if hi < lo || lo >= len(y) {
		return nil, fmt.Errorf("time window is empty")
	}
	if hi >= len(y) {
		hi = len(y) - 1
	}
	seg := y[lo : hi+1]

	m := &Measurement{Column: column, Max: seg[0], Min: seg[0], N: len(seg), TStart: x[lo], TEnd: x[hi]}
	var sum, sumSq float64
	for _, v := range seg {
		if v > m.Max {
			m.Max = v
		}
		if v < m.Min {
			m.Min = v
		}
		sum += v
		sumSq += v * v
	}
	m.Avg = sum / float64(len(seg))
	m.RMS = math.Sqrt(sumSq / float64(len(seg)))
	m.PkPk = m.Max - m.Min
	return m, nil
}

// ── Filters ──────────────────────────────────────────────────────────────────

// FilterOptions configures a filter run.
type FilterOptions struct {
	Column string  `json:"column"`
	Type   string  `json:"type"` // ma | ideal_lp | ideal_hp | ideal_bp | butter_lp | butter_hp
	Points int     `json:"points"`
	FC1    float64 `json:"fc1"`
	FC2    float64 `json:"fc2"`
	Taps   int     `json:"taps"`
}

// Filter applies a filter and returns the result plus a suggested name.
func (d *Dataset) Filter(o FilterOptions) (string, []float64, error) {
	d.mu.RLock()
	src, ok := d.Data[o.Column]
	d.mu.RUnlock()
	if !ok {
		return "", nil, fmt.Errorf("no such signal: %s", o.Column)
	}
	fs := d.SampleRate()
	if fs <= 0 {
		return "", nil, fmt.Errorf("could not determine the sample rate")
	}
	nyq := fs / 2

	switch o.Type {
	case "ma":
		if o.Points < 2 {
			return "", nil, fmt.Errorf("the moving-average window must be at least 2 points")
		}
		return fmt.Sprintf("%s_MA%d", o.Column, o.Points), movingAverage(src, o.Points), nil

	case "ideal_lp", "ideal_hp", "ideal_bp":
		if o.FC1 <= 0 || o.FC1 >= nyq {
			return "", nil, fmt.Errorf("cutoff must be between 0 and the Nyquist frequency (%.0f Hz)", nyq)
		}
		if o.Type == "ideal_bp" && (o.FC2 <= o.FC1 || o.FC2 >= nyq) {
			return "", nil, fmt.Errorf("band-pass needs f_low < f_high < Nyquist (%.0f Hz)", nyq)
		}
		taps := o.Taps
		if taps < 11 {
			taps = 101
		}
		if taps%2 == 0 {
			taps++ // odd length keeps the filter exactly linear-phase
		}
		h := generateFIR(o.Type, o.FC1, o.FC2, fs, taps)
		suffix := map[string]string{"ideal_lp": "LP", "ideal_hp": "HP", "ideal_bp": "BP"}[o.Type]
		return fmt.Sprintf("%s_FIR_%s", o.Column, suffix), convolveFIR(src, h), nil

	case "butter_lp", "butter_hp":
		if o.FC1 <= 0 || o.FC1 >= nyq {
			return "", nil, fmt.Errorf("cutoff must be between 0 and the Nyquist frequency (%.0f Hz)", nyq)
		}
		suffix := "LP"
		if o.Type == "butter_hp" {
			suffix = "HP"
		}
		return fmt.Sprintf("%s_Butter_%s", o.Column, suffix), biquadFiltFilt(src, o.Type, o.FC1, fs), nil
	}
	return "", nil, fmt.Errorf("unknown filter type %q", o.Type)
}

// movingAverage smooths with a boxcar and shifts the result back by half the
// window, so the output stays aligned in time with the input.
func movingAverage(src []float64, pts int) []float64 {
	n := len(src)
	out := make([]float64, n)
	var sum float64
	for i := 0; i < n; i++ {
		sum += src[i]
		if i >= pts {
			sum -= src[i-pts]
		}
		w := pts
		if i+1 < pts {
			w = i + 1
		}
		out[i] = sum / float64(w)
	}
	shift := pts / 2
	centred := make([]float64, n)
	for i := 0; i < n; i++ {
		if i+shift < n {
			centred[i] = out[i+shift]
		} else {
			centred[i] = out[n-1]
		}
	}
	return centred
}

// generateFIR builds a windowed-sinc filter kernel.
func generateFIR(kind string, fc1, fc2, fs float64, taps int) []float64 {
	buildLP := func(fc float64) []float64 {
		wc := 2 * math.Pi * (fc / fs)
		m := float64(taps - 1)
		h := make([]float64, taps)
		var sum float64
		for i := 0; i < taps; i++ {
			k := float64(i) - m/2
			if k == 0 {
				h[i] = wc / math.Pi
			} else {
				h[i] = math.Sin(wc*k) / (math.Pi * k)
			}
			h[i] *= 0.54 - 0.46*math.Cos(2*math.Pi*float64(i)/m) // Hamming
			sum += h[i]
		}
		for i := range h { // unity DC gain
			h[i] /= sum
		}
		return h
	}

	switch kind {
	case "ideal_lp":
		return buildLP(fc1)
	case "ideal_hp":
		lp := buildLP(fc1)
		h := make([]float64, taps)
		for i := range h {
			h[i] = -lp[i]
		}
		h[taps/2] += 1 // spectral inversion
		return h
	case "ideal_bp":
		low := buildLP(fc1)
		high := buildLP(fc2)
		h := make([]float64, taps)
		for i := range h {
			h[i] = high[i] - low[i]
		}
		return h
	}
	return make([]float64, taps)
}

// convolveFIR convolves with a symmetric kernel, compensating the group delay
// so the output is not shifted in time, and clamping at the edges.
func convolveFIR(x, h []float64) []float64 {
	n, m := len(x), len(h)
	half := m / 2
	y := make([]float64, n)
	for i := 0; i < n; i++ {
		var sum float64
		for k := 0; k < m; k++ {
			idx := i - k + half
			switch {
			case idx < 0:
				sum += h[k] * x[0]
			case idx >= n:
				sum += h[k] * x[n-1]
			default:
				sum += h[k] * x[idx]
			}
		}
		y[i] = sum
	}
	return y
}

// biquadFiltFilt runs a 2nd-order Butterworth section forwards then backwards.
// The second pass cancels the phase shift of the first, so features stay where
// they occurred — at the cost of doubling the effective filter order.
func biquadFiltFilt(x []float64, kind string, fc, fs float64) []float64 {
	w0 := 2 * math.Pi * fc / fs
	alpha := math.Sin(w0) / (2 * 0.70710678) // Q = 1/sqrt(2)
	cw := math.Cos(w0)

	var b0, b1, b2 float64
	a0 := 1 + alpha
	a1 := -2 * cw
	a2 := 1 - alpha

	if kind == "butter_hp" {
		b0 = (1 + cw) / 2
		b1 = -(1 + cw)
		b2 = (1 + cw) / 2
	} else {
		b0 = (1 - cw) / 2
		b1 = 1 - cw
		b2 = (1 - cw) / 2
	}
	b0, b1, b2 = b0/a0, b1/a0, b2/a0
	a1, a2 = a1/a0, a2/a0

	pass := func(sig []float64) []float64 {
		out := make([]float64, len(sig))
		var x1, x2, y1, y2 float64
		for i, v := range sig {
			o := b0*v + b1*x1 + b2*x2 - a1*y1 - a2*y2
			x2, x1 = x1, v
			y2, y1 = y1, o
			out[i] = o
		}
		return out
	}

	fwd := pass(x)
	rev := reversed(fwd)
	back := pass(rev)
	return reversed(back)
}

func reversed(v []float64) []float64 {
	out := make([]float64, len(v))
	for i, x := range v {
		out[len(v)-1-i] = x
	}
	return out
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
