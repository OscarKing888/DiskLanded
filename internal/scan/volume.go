package scan

// Volume describes the file system that holds a scan root.
type Volume struct {
	Mount   string   `json:"mount"`
	Total   int64    `json:"total"`
	Used    int64    `json:"used"`
	Free    int64    `json:"free"` // available to the current user
	Percent float64  `json:"percent"`
	Roots   []string `json:"roots"`
}

// Volumes returns one entry per distinct volume among roots.
func Volumes(roots []string) ([]Volume, []Failure) {
	var out []Volume
	var bad []Failure
	idx := map[string]int{}
	for _, r := range roots {
		v, err := volumeOf(r)
		if err != nil {
			bad = append(bad, Failure{Path: r, Reason: Reason(err)})
			continue
		}
		if i, ok := idx[v.Mount]; ok {
			out[i].Roots = append(out[i].Roots, r)
			continue
		}
		if v.Total > 0 {
			v.Percent = float64(v.Used) / float64(v.Total) * 100
		}
		v.Roots = []string{r}
		idx[v.Mount] = len(out)
		out = append(out, v)
	}
	return out, bad
}
