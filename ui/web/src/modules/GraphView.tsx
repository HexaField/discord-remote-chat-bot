import * as d3 from 'd3'
import type { JSX } from 'solid-js'
import { createEffect, onCleanup, onMount } from 'solid-js'

type NodeDatum = d3.SimulationNodeDatum & { id: string; label?: string; type?: string; provenance?: any }

type LinkDatum = d3.SimulationLinkDatum<NodeDatum> & {
  source: string | NodeDatum
  target: string | NodeDatum
  label?: string
}

export default function GraphView(props: {
  data: { nodes: NodeDatum[]; links: LinkDatum[] } | null
  // set of node ids to highlight (others will be dimmed)
  highlightedNodes?: Set<string> | null
  // optional callback when user hovers a node: { id, provenance, x, y }
  onNodeHover?: (arg: { id: string; provenance?: any[] | null; x: number; y: number }) => void
  onNodeOut?: () => void
}): JSX.Element {
  let container!: HTMLDivElement
  let svg!: SVGSVGElement
  let sim: d3.Simulation<NodeDatum, LinkDatum> | null = null
  let svgSel: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null
  let zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null
  let lastW = 800
  let lastH = 400
  let currentK = 1

  // width/height will be computed from the container size so the SVG fills available height
  let resizeObserver: ResizeObserver | null = null

  function render() {
    if (!props.data) return
    // compute node radii based on label length so labels can sit inside nodes
    const nodes: NodeDatum[] = props.data.nodes.map((n) => {
      const label = (n.label ?? n.id ?? '').toString()
      const base = 8
      const extra = Math.min(28, Math.max(0, Math.floor(label.length * 0.45)))
      return { ...n, r: base + extra }
    })
    const links: LinkDatum[] = props.data.links.map((l) => ({ ...l }))

    const selection = d3.select(svg)
    svgSel = selection
    selection.selectAll('*').remove()
    // ensure svg background is white
    selection.style('background', '#ffffff')

    // compute container size so graph fills available space
    const rect = container?.getBoundingClientRect() ?? { width: 800, height: 400 }
    const w = Math.max(300, Math.floor(rect.width))
    const h = Math.max(200, Math.floor(rect.height))
    lastW = w
    lastH = h

    // Pre-cluster nodes by connected components and assign initial positions
    // so the simulation begins with clusters placed apart and reduces overlap.
    try {
      // build adjacency map
      const adj = new Map<string, Set<string>>()
      const nodeById = new Map<string, NodeDatum>()
      for (const n of nodes) nodeById.set(n.id, n)
      for (const lk of links) {
        const sid = typeof lk.source === 'string' ? lk.source : (lk.source as NodeDatum).id
        const tid = typeof lk.target === 'string' ? lk.target : (lk.target as NodeDatum).id
        if (!sid || !tid) continue
        if (!adj.has(sid)) adj.set(sid, new Set())
        if (!adj.has(tid)) adj.set(tid, new Set())
        adj.get(sid)!.add(tid)
        adj.get(tid)!.add(sid)
      }

      // find connected components via DFS
      const visited = new Set<string>()
      const components: string[][] = []
      for (const n of nodes) {
        const id = n.id
        if (visited.has(id)) continue
        const stack = [id]
        const comp: string[] = []
        while (stack.length) {
          const cur = stack.pop() as string
          if (!cur || visited.has(cur)) continue
          visited.add(cur)
          comp.push(cur)
          const neigh = adj.get(cur)
          if (!neigh) continue
          for (const nb of neigh) if (!visited.has(nb)) stack.push(nb)
        }
        // also include isolated nodes (no adjacency entries)
        if (comp.length === 0) comp.push(id)
        components.push(comp)
      }

      if (components.length > 0) {
        const bigR = Math.max(120, Math.min(w, h) / 3)
        // place each component around a circle
        for (let ci = 0; ci < components.length; ci++) {
          const comp = components[ci]
          const angle = (ci / components.length) * Math.PI * 2
          const cx = w / 2 + Math.cos(angle) * bigR
          const cy = h / 2 + Math.sin(angle) * bigR
          // cluster radius scales with sqrt(size)
          const clusterRadius = Math.max(30, Math.sqrt(comp.length) * 20)
          for (let i = 0; i < comp.length; i++) {
            const id = comp[i]
            const node = nodeById.get(id)
            if (!node) continue
            // scatter nodes within the cluster radius
            const a = (i / comp.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.5
            const r = clusterRadius * (0.4 + Math.random() * 0.6)
            node.x = cx + Math.cos(a) * r
            node.y = cy + Math.sin(a) * r
            // small initial velocity to help settling
            node.vx = (Math.random() - 0.5) * 2
            node.vy = (Math.random() - 0.5) * 2
          }
        }
      }
    } catch (e) {
      // clustering is best-effort; ignore on failure
      console.debug('Clustering failed', e)
    }

    // Root group and zoomable group
    selection
      .attr('viewBox', `0 0 ${w} ${h}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('width', w)
      .attr('height', h)
    const rootG = selection.append('g')
    const zoomG = rootG.append('g')

    // Setup zoom/pan on the svg
    zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 8])
      .on('zoom', (event) => {
        zoomG.attr('transform', event.transform.toString())
        currentK = event.transform.k
      })
    selection.call(zoomBehavior as any)

    // Configure forces to keep graph compact and avoid large expansion when
    // nodes are dragged. We use milder repulsion, a stronger link force with
    // shorter distance, weak x/y centering forces and a small collision
    // radius. Also increase alpha decay so simulations settle faster.
    sim = d3
      .forceSimulation<NodeDatum>(nodes)
      .force(
        'link',
        d3
          .forceLink<NodeDatum, LinkDatum>(links)
          .id((d) => d.id)
          // distance depends on node radii so larger nodes keep more separation
          .distance((d: any) => {
            const s = typeof d.source === 'string' ? 12 : (d.source.r ?? 12)
            const t = typeof d.target === 'string' ? 12 : (d.target.r ?? 12)
            // increase base link distance to reduce label/node overlap
            return Math.max(40, (s + t + 12) * 3)
          })
          .strength(0.8)
      )
      // increase repulsion to scale the simulation up (twice the previous strength)
      .force('charge', d3.forceManyBody().strength(-80))
      .force('center', d3.forceCenter(w / 2, h / 2))
      .force('x', d3.forceX(w / 2).strength(0.02))
      .force('y', d3.forceY(h / 2).strength(0.02))
      .force(
        'collide',
        d3
          .forceCollide<NodeDatum>()
          .radius((d: any) => (d.r ?? 8) + 4)
          .strength(0.7)
      )
      .alphaDecay(0.05)

    const link = zoomG
      .append('g')
      .attr('stroke', '#999')
      .selectAll('line')
      .data(links)
      .enter()
      .append('line')
      .attr('stroke-opacity', 0.6)

    // link labels (predicate info) as + or -
    const linkLabel = zoomG
      .append('g')
      .attr('class', 'link-labels')
      .selectAll('text')
      .data(links)
      .enter()
      .append('text')
      .attr('class', 'link-label')
      .attr('font-size', 10)
      .attr('text-anchor', 'middle')
      .attr('fill', '#333')
      .attr('pointer-events', 'none')
      .text((d) => {
        const lbl = (d.label || '').toString()
        const l = lbl.toLowerCase()
        // heuristic: negative predicates contain words like 'not', 'neg', 'false', or explicit '-'
        if (l.includes('not') || l.includes('neg') || l.includes('false') || l.includes('-') || l.startsWith('!'))
          return '-'
        return '+'
      })

    // create node groups so label can be centered inside circle
    const nodeG = zoomG.append('g').selectAll('g').data(nodes).enter().append('g').attr('class', 'node-group')

    // rectangle node background (will size after measuring text bbox)
    const bgRect = nodeG
      .append('rect')
      .attr('width', (d: any) => d.r ?? 16)
      .attr('height', (d: any) => d.r ?? 16)
      .attr('x', (d: any) => -(d.r ?? 16) / 2)
      .attr('y', (d: any) => -(d.r ?? 16) / 2)
      .attr('rx', 6)
      .attr('ry', 6)
      // colour nodes by their semantic type (driver/obstacle/actor/other)
      .attr('fill', (d: any) => {
        const t = (d.type || '').toString().toLowerCase()
        const map: { [k: string]: string } = {
          driver: '#88cc88',
          obstacle: '#ff8888',
          actor: '#ffcc66',
          other: '#88aaff'
        }
        return map[t] || map['other']
      })
      .attr('opacity', (d) =>
        props.highlightedNodes && props.highlightedNodes.size ? (props.highlightedNodes.has(d.id) ? 1 : 0.12) : 1
      )

    // attach drag to groups so the whole label+circle moves together
    nodeG.call(
      d3
        .drag<SVGGElement, NodeDatum>()
        .on('start', (event, d) => {
          if (!event.active && sim) sim.alphaTarget(0.06).restart()
          d.fx = d.x
          d.fy = d.y
        })
        .on('drag', (event, d) => {
          d.fx = event.x
          d.fy = event.y
        })
        .on('end', (event, d) => {
          if (!event.active && sim) sim.alphaTarget(0)
          d.fx = null
          d.fy = null
        })
    )

    nodeG.on('mouseover', function (event, d) {
      d3.select(this).select('circle').attr('stroke', '#222').attr('stroke-width', 1.5)
      try {
        props.onNodeHover?.({ id: d.id, provenance: (d as any).provenance ?? null, x: event.clientX, y: event.clientY })
      } catch (e) {}
    })
    nodeG.on('mouseout', function () {
      d3.select(this).select('circle').attr('stroke', null).attr('stroke-width', null)
      try {
        props.onNodeOut?.()
      } catch (e) {}
    })

    const label = nodeG
      .append('text')
      .text((d: any) => d.label ?? d.id)
      .attr('font-size', 10)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      // choose text colour for contrast: use black for light/amber nodes (actor), white otherwise
      .attr('fill', (d: any) => {
        const t = (d.type || '').toString().toLowerCase()
        return t === 'actor' ? '#000' : '#fff'
      })
      .style('pointer-events', 'none')

    // measure label bbox and size the rect accordingly
    label.each(function (d: any) {
      try {
        const textEl = this as SVGTextElement
        const bbox = textEl.getBBox()
        const pad = 8
        const w = Math.max(24, bbox.width + pad * 2)
        const h = Math.max(18, bbox.height + pad * 2)
        d.__rectW = w
        d.__rectH = h
        const g = d3.select(this.parentNode as SVGGElement)
        g.select('rect')
          .attr('width', w)
          .attr('height', h)
          .attr('x', -w / 2)
          .attr('y', -h / 2)
      } catch (e) {
        // if getBBox fails (rare), leave defaults
      }
    })

    sim.on('tick', () => {
      link
        .attr('x1', (d) => (typeof d.source === 'string' ? 0 : d.source.x) as number)
        .attr('y1', (d) => (typeof d.source === 'string' ? 0 : d.source.y) as number)
        .attr('x2', (d) => (typeof d.target === 'string' ? 0 : d.target.x) as number)
        .attr('y2', (d) => (typeof d.target === 'string' ? 0 : d.target.y) as number)

      // position link labels at link midpoints
      linkLabel
        .attr('x', (d) => {
          const sx = typeof d.source === 'string' ? 0 : (d.source.x as number)
          const tx = typeof d.target === 'string' ? 0 : (d.target.x as number)
          return (sx + tx) / 2
        })
        .attr('y', (d) => {
          const sy = typeof d.source === 'string' ? 0 : (d.source.y as number)
          const ty = typeof d.target === 'string' ? 0 : (d.target.y as number)
          return (sy + ty) / 2 - 8
        })
      // position node groups by translating the group to node x/y
      nodeG.attr('transform', (d: any) => `translate(${d.x},${d.y})`)
    })
  }

  // react to highlight changes without rebuilding the simulation
  createEffect(() => {
    // access prop to track changes
    const h = props.highlightedNodes
    if (!svgSel) return
    // update node/link opacity based on highlightedNodes
    const selNodes = svgSel.selectAll('circle')
    const selLinks = svgSel.selectAll('line')
    const selLinkLabels = svgSel.selectAll('text.link-label')
    if (h && h.size) {
      selNodes.attr('opacity', (d: any) => (h.has(d.id) ? 1 : 0.12))
      selLinks.attr('opacity', (d: any) => {
        // if either end is highlighted, keep link visible
        const s = typeof d.source === 'string' ? d.source : d.source.id
        const t = typeof d.target === 'string' ? d.target : d.target.id
        return h.has(s) || h.has(t) ? 0.9 : 0.08
      })
      selLinkLabels.attr('opacity', (d: any) => {
        const s = typeof d.source === 'string' ? d.source : d.source.id
        const t = typeof d.target === 'string' ? d.target : d.target.id
        return h.has(s) || h.has(t) ? 1 : 0.12
      })
    } else {
      selNodes.attr('opacity', 1)
      selLinks.attr('opacity', 0.6)
      selLinkLabels.attr('opacity', 1)
    }
  })

  // Update svg/view size and the force center without restarting the simulation.
  function updateSize() {
    if (!svgSel) return
    const rect = container?.getBoundingClientRect() ?? { width: 800, height: 400 }
    const w = Math.max(300, Math.floor(rect.width))
    const h = Math.max(200, Math.floor(rect.height))
    lastW = w
    lastH = h
    svgSel.attr('viewBox', `0 0 ${w} ${h}`).attr('width', w).attr('height', h)
    // update center force to new center without restarting simulation
    if (sim) {
      sim.force('center', d3.forceCenter(w / 2, h / 2))
    }
  }

  // Fit all nodes into view with padding
  const reframe = () => {
    if (!svgSel || !zoomBehavior) return
    // Prefer to compute bounding box from simulation node positions so we
    // don't rely on DOM attributes that may be relative (groups with transforms).
    const snodes = sim ? sim.nodes() : []
    if (!snodes || snodes.length === 0) return
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    snodes.forEach((n: any) => {
      const cx = n.x
      const cy = n.y
      if (Number.isFinite(cx) && Number.isFinite(cy)) {
        minX = Math.min(minX, cx)
        minY = Math.min(minY, cy)
        maxX = Math.max(maxX, cx)
        maxY = Math.max(maxY, cy)
      }
    })
    const bw = Math.max(1, maxX - minX)
    const bh = Math.max(1, maxY - minY)
    const pad = 40 // pixels padding
    const kx = (lastW - 2 * pad) / bw
    const ky = (lastH - 2 * pad) / bh
    let k = Math.min(kx, ky)
    // clamp to zoom extent
    const ext = zoomBehavior.scaleExtent()
    k = Math.max(ext[0], Math.min(ext[1], k))
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const tx = lastW / 2 - k * cx
    const ty = lastH / 2 - k * cy
    const transform = d3.zoomIdentity.translate(tx, ty).scale(k)
    svgSel
      .transition()
      .duration(500)
      .call(zoomBehavior.transform as any, transform)
  }

  onMount(() => {
    // Initial try in case data was already present
    render()
    // observe size changes so we can re-render to fill available space
    if (container && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (props.data) {
          // on resize, update svg size and force center without restarting the simulation
          updateSize()
        }
      })
      resizeObserver.observe(container)
    }
  })

  // Re-render when data changes
  createEffect(() => {
    // access to track
    const d = props.data
    if (!d) return
    // Only rebuild the simulation when the actual data reference changes.
    // This prevents unrelated prop updates (like hover/highlight sets) from
    // stopping/restarting the D3 simulation.
    if ((render as any).__lastData === d) return
    ;(render as any).__lastData = d
    // stop any running simulation and rerender with new data
    sim?.stop()
    render()
  })

  const zoomIn = () => {
    if (svgSel && zoomBehavior) {
      svgSel
        .transition()
        .duration(200)
        .call(zoomBehavior.scaleBy as any, 1.2)
    }
  }

  const zoomOut = () => {
    if (svgSel && zoomBehavior) {
      svgSel
        .transition()
        .duration(200)
        .call(zoomBehavior.scaleBy as any, 1 / 1.2)
    }
  }

  onCleanup(() => {
    sim?.stop()
    if (resizeObserver && container) {
      resizeObserver.unobserve(container)
      resizeObserver.disconnect()
      resizeObserver = null
    }
  })

  return (
    <div ref={(el) => (container = el)} class="relative w-full h-full border rounded">
      <div class="absolute top-2 right-2 flex gap-2 z-10">
        <button class="px-2 py-1 text-sm bg-white border rounded shadow hover:bg-gray-50" onClick={zoomIn}>
          +
        </button>
        <button class="px-2 py-1 text-sm bg-white border rounded shadow hover:bg-gray-50" onClick={zoomOut}>
          -
        </button>
        <button class="px-2 py-1 text-sm bg-white border rounded shadow hover:bg-gray-50" onClick={reframe}>
          ⤢
        </button>
      </div>
      <svg ref={(el) => (svg = el)} class="w-full h-full"></svg>
    </div>
  )
}
