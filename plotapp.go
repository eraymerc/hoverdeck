package main

import (
	"encoding/csv"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"hoverdeck/internal/plot"
)

// The waveform viewer's bound API.
//
// The dataset stays in Go and the frontend only ever receives decimated
// traces, so opening a multi-hundred-megabyte run does not mean shipping it
// through the JavaScript bridge.

// PlotInfo describes the loaded dataset.
type PlotInfo struct {
	Path     string   `json:"path"`
	Name     string   `json:"name"`
	Open     bool     `json:"open"`
	Columns  []string `json:"columns"`
	Signals  []string `json:"signals"`
	XKey     string   `json:"xKey"`
	Rows     int      `json:"rows"`
	TMin     float64  `json:"tMin"`
	TMax     float64  `json:"tMax"`
	Fs       float64  `json:"fs"`
	Computed []string `json:"computed"`
}

func (a *App) plotInfo() *PlotInfo {
	if a.dataset == nil {
		return &PlotInfo{Open: false}
	}
	d := a.dataset
	lo, hi := d.Range()
	info := &PlotInfo{
		Path:    d.Path,
		Name:    filepath.Base(d.Path),
		Open:    true,
		Columns: d.Cols,
		Signals: d.Signals(),
		XKey:    d.XKey,
		Rows:    d.Rows,
		TMin:    lo,
		TMax:    hi,
		Fs:      d.SampleRate(),
	}
	for _, c := range d.Cols {
		if d.IsComputed(c) {
			info.Computed = append(info.Computed, c)
		}
	}
	return info
}

// OpenPlot loads a CSV of simulation results.
func (a *App) OpenPlot(path string) (*PlotInfo, error) {
	if path == "" {
		return nil, fmt.Errorf("no file given")
	}
	d, err := plot.Load(path)
	if err != nil {
		return nil, err
	}
	a.dataset = d
	return a.plotInfo(), nil
}

// PickPlot opens a file dialog for a results CSV.
func (a *App) PickPlot() (*PlotInfo, error) {
	dir := a.runDir()
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "Open simulation results",
		DefaultDirectory: dir,
		Filters: []runtime.FileFilter{
			{DisplayName: "CSV results (*.csv)", Pattern: "*.csv"},
		},
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return a.plotInfo(), nil
	}
	return a.OpenPlot(path)
}

// PlotInfoNow returns the current dataset state without reloading.
func (a *App) PlotInfoNow() *PlotInfo { return a.plotInfo() }

// LatestResults returns the path of the most recent simulation_output.csv, so
// the viewer can open automatically once a run finishes.
func (a *App) LatestResults() string {
	if a.settings == nil {
		return ""
	}
	dir := a.runDir()
	if dir == "" {
		return ""
	}
	p := filepath.Join(dir, "simulation_output.csv")
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		return p
	}
	return ""
}

// SetPlotX changes which column is the independent variable, which is what
// turns a transient plot into an X-Y parametric one.
func (a *App) SetPlotX(col string) (*PlotInfo, error) {
	if a.dataset == nil {
		return nil, fmt.Errorf("no results loaded")
	}
	if _, ok := a.dataset.Column(col); !ok {
		return nil, fmt.Errorf("no such column: %s", col)
	}
	a.dataset.XKey = col
	return a.plotInfo(), nil
}

// PlotSeries returns decimated traces for the given signals over a window.
//
// `buckets` should be the pixel width of the plot area: the result carries at
// most two points per bucket, which is all the screen can show.
func (a *App) PlotSeries(names []string, x0, x1 float64, buckets int) ([]plot.Trace, error) {
	if a.dataset == nil {
		return nil, fmt.Errorf("no results loaded")
	}
	if len(names) == 0 {
		return []plot.Trace{}, nil
	}
	return a.dataset.Series(names, x0, x1, buckets)
}

// PlotFFT computes a magnitude spectrum.
func (a *App) PlotFFT(o plot.FFTOptions) (*plot.Spectrum, error) {
	if a.dataset == nil {
		return nil, fmt.Errorf("no results loaded")
	}
	return a.dataset.Spectrum(o)
}

// PlotTHD computes total harmonic distortion.
func (a *App) PlotTHD(o plot.FFTOptions) (*plot.THDResult, error) {
	if a.dataset == nil {
		return nil, fmt.Errorf("no results loaded")
	}
	return a.dataset.THD(o)
}

// PlotMeasure computes time-bounded measurements.
func (a *App) PlotMeasure(column string, t0, t1 float64) (*plot.Measurement, error) {
	if a.dataset == nil {
		return nil, fmt.Errorf("no results loaded")
	}
	return a.dataset.Measure(column, t0, t1)
}

// PlotFilter applies a filter and adds the result as a new curve.
func (a *App) PlotFilter(o plot.FilterOptions) (*PlotInfo, error) {
	if a.dataset == nil {
		return nil, fmt.Errorf("no results loaded")
	}
	name, values, err := a.dataset.Filter(o)
	if err != nil {
		return nil, err
	}
	a.dataset.AddColumn(name, values)
	info := a.plotInfo()
	info.Name = name // the caller selects the new curve by this name
	return info, nil
}

// PlotCompute evaluates a maths expression and adds it as a new curve.
func (a *App) PlotCompute(name, expr string) (*PlotInfo, error) {
	if a.dataset == nil {
		return nil, fmt.Errorf("no results loaded")
	}
	values, err := a.dataset.Compute(name, expr)
	if err != nil {
		return nil, err
	}
	a.dataset.AddColumn(name, values)
	return a.plotInfo(), nil
}

// PlotRemoveColumn drops a computed curve.
func (a *App) PlotRemoveColumn(name string) (*PlotInfo, error) {
	if a.dataset == nil {
		return nil, fmt.Errorf("no results loaded")
	}
	if err := a.dataset.RemoveColumn(name); err != nil {
		return nil, err
	}
	return a.plotInfo(), nil
}

// PlotExport writes the selected signals to a CSV at full resolution.
//
// Export deliberately writes every sample rather than the decimated view: the
// decimation exists to make drawing fast, not to throw data away.
func (a *App) PlotExport(names []string, x0, x1 float64) (string, error) {
	if a.dataset == nil {
		return "", fmt.Errorf("no results loaded")
	}
	if len(names) == 0 {
		return "", fmt.Errorf("select at least one signal to export")
	}

	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Export plotted data",
		DefaultFilename: "export.csv",
		Filters: []runtime.FileFilter{
			{DisplayName: "CSV (*.csv)", Pattern: "*.csv"},
		},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}

	d := a.dataset
	xs, ok := d.Column(d.XKey)
	if !ok {
		return "", fmt.Errorf("no X column")
	}
	lo, hi := d.IndexRange(x0, x1)

	cols := make([][]float64, 0, len(names))
	header := []string{d.XKey}
	for _, n := range names {
		if v, ok := d.Column(n); ok {
			cols = append(cols, v)
			header = append(header, n)
		}
	}

	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	w := csv.NewWriter(f)
	defer w.Flush()
	if err := w.Write(header); err != nil {
		return "", err
	}

	rec := make([]string, len(header))
	for i := lo; i <= hi && i < len(xs); i++ {
		rec[0] = strconv.FormatFloat(xs[i], 'g', -1, 64)
		for j, c := range cols {
			v := 0.0
			if i < len(c) {
				v = c[i]
			}
			rec[j+1] = strconv.FormatFloat(v, 'g', -1, 64)
		}
		if err := w.Write(rec); err != nil {
			return "", err
		}
	}
	return path, nil
}

// PlotExportSpectrum writes a computed spectrum to CSV.
func (a *App) PlotExportSpectrum(o plot.FFTOptions) (string, error) {
	if a.dataset == nil {
		return "", fmt.Errorf("no results loaded")
	}
	sp, err := a.dataset.Spectrum(o)
	if err != nil {
		return "", err
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Export spectrum",
		DefaultFilename: "fft_export.csv",
		Filters: []runtime.FileFilter{
			{DisplayName: "CSV (*.csv)", Pattern: "*.csv"},
		},
	})
	if err != nil || path == "" {
		return "", err
	}
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	w := csv.NewWriter(f)
	defer w.Flush()
	_ = w.Write([]string{"Frequency (Hz)", "Magnitude"})
	for i := range sp.Freqs {
		_ = w.Write([]string{
			strconv.FormatFloat(sp.Freqs[i], 'g', -1, 64),
			strconv.FormatFloat(sp.Mags[i], 'g', -1, 64),
		})
	}
	return path, nil
}
