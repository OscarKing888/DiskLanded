package scan

import (
	"errors"
	"path/filepath"
	"sort"
)

// GraphNode is a bounded sunburst subtree. Other nodes are display-only sums.
type GraphNode struct {
	Path            string      `json:"path"`
	Name            string      `json:"name"`
	Kind            string      `json:"kind"`
	Alloc           int64       `json:"alloc"`
	Logical         int64       `json:"logical"`
	Appeared        int64       `json:"appeared,omitempty"`
	Modified        int64       `json:"modified,omitempty"`
	AppearedIsMtime bool        `json:"appearedIsMtime,omitempty"`
	Children        []GraphNode `json:"children"`
}

type GraphView struct {
	Root        GraphNode   `json:"root"`
	Breadcrumbs []GraphNode `json:"breadcrumbs"`
}

// GraphIndex keeps the complete hierarchy server-side. Rendering a subtree
// never depends on the 2,000-row limit used by the list view.
type GraphIndex struct {
	nodes    map[string]GraphNode
	children map[string][]string
	parent   map[string]string
}

func (r *Result) GraphIndex(filesOnly bool, minAlloc, since int64) *GraphIndex {
	g := &GraphIndex{nodes: map[string]GraphNode{}, children: map[string][]string{}, parent: map[string]string{}}
	g.nodes[""] = GraphNode{Name: "扫描目录", Kind: "dir"}
	for _, d := range r.Dirs {
		n := GraphNode{Path: d.Path, Name: filepath.Base(d.Path), Kind: "dir"}
		if n.Name == string(filepath.Separator) || n.Name == "." {
			n.Name = d.Path
		}
		if !filesOnly {
			n.Alloc, n.Logical = d.Alloc, d.Logical
		}
		g.nodes[d.Path] = n
	}
	rootPaths := map[string]bool{}
	for _, path := range r.Roots {
		rootPaths[path] = true
	}
	for path := range g.nodes {
		if path == "" {
			continue
		}
		parent := filepath.Dir(path)
		if _, ok := g.nodes[parent]; parent == path || rootPaths[path] || !ok {
			parent = ""
		}
		g.parent[path] = parent
		g.children[parent] = append(g.children[parent], path)
	}
	for _, f := range r.Files {
		if filesOnly && (f.Alloc < minAlloc || f.Appeared < since) {
			continue
		}
		parent := filepath.Dir(f.Path)
		if _, ok := g.nodes[parent]; !ok {
			continue
		}
		g.nodes[f.Path] = GraphNode{Path: f.Path, Name: filepath.Base(f.Path), Kind: "file",
			Alloc: f.Alloc, Logical: f.Logical, Appeared: f.Appeared, Modified: f.Modified, AppearedIsMtime: f.AppearedIsMtime}
		g.parent[f.Path] = parent
		g.children[parent] = append(g.children[parent], f.Path)
		if filesOnly {
			for p := parent; ; p = g.parent[p] {
				n := g.nodes[p]
				n.Alloc += f.Alloc
				n.Logical += f.Logical
				g.nodes[p] = n
				if p == "" {
					break
				}
			}
		}
	}
	if !filesOnly {
		root := g.nodes[""]
		for _, path := range g.children[""] {
			n := g.nodes[path]
			root.Alloc += n.Alloc
			root.Logical += n.Logical
		}
		g.nodes[""] = root
	}
	for parent, children := range g.children {
		sort.Slice(children, func(i, j int) bool {
			a, b := g.nodes[children[i]], g.nodes[children[j]]
			if a.Alloc != b.Alloc {
				return a.Alloc > b.Alloc
			}
			return a.Path < b.Path
		})
		g.children[parent] = children
	}
	return g
}

// View expands up to four rings. Small sectors and overflow are grouped,
// while their full weight remains represented by a grey sector.
func (g *GraphIndex) View(path string) (GraphView, error) {
	n, ok := g.nodes[path]
	if !ok || n.Kind != "dir" {
		return GraphView{}, errors.New("该目录不在扫描结果中")
	}
	trail := []GraphNode{}
	for p := path; ; p = g.parent[p] {
		n := g.nodes[p]
		n.Children = nil
		trail = append(trail, n)
		if p == "" {
			break
		}
	}
	for i, j := 0, len(trail)-1; i < j; i, j = i+1, j-1 {
		trail[i], trail[j] = trail[j], trail[i]
	}
	budget := 1200
	return GraphView{Root: g.subtree(path, 4, &budget), Breadcrumbs: trail}, nil
}

func (g *GraphIndex) subtree(path string, depth int, budget *int) GraphNode {
	n := g.nodes[path]
	n.Children = []GraphNode{}
	if n.Kind != "dir" || depth == 0 || n.Alloc == 0 {
		return n
	}
	var shown int64
	for _, child := range g.children[path] {
		c := g.nodes[child]
		if c.Alloc <= 0 {
			continue
		}
		if *budget <= 0 || len(n.Children) >= 36 || (depth < 4 && float64(c.Alloc)/float64(n.Alloc) < 0.004) {
			continue
		}
		*budget--
		c.Children = []GraphNode{}
		n.Children = append(n.Children, c)
		shown += c.Alloc
	}
	// 先保留本层节点，再展开下一层，避免大分支耗尽预算后遮掉同层目录。
	for i := range n.Children {
		if n.Children[i].Kind == "dir" {
			n.Children[i] = g.subtree(n.Children[i].Path, depth-1, budget)
		}
	}
	if remaining := n.Alloc - shown; remaining > 0 {
		n.Children = append(n.Children, GraphNode{Name: "其他项目", Kind: "other", Alloc: remaining, Children: []GraphNode{}})
	}
	return n
}
