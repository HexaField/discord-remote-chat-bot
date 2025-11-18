import * as d3 from 'd3'
import type { JSX } from 'solid-js'
import { createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import { openTemporaryProgressEventSource } from '../lib/progressStream'
import useVideoProgress from '../lib/useVideoProgress'

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
  // optional callback when user clicks a node or the background.
  // If a node is clicked, arg.id is the node id and arg.provenance may be present.
  // If the background is clicked, arg.id will be null.
  onNodeClick?: (arg: { id: string | null; provenance?: any[] | null; x?: number; y?: number }) => void
  // id of a node that should be treated as selected/focused in the view
  selectedNodeId?: string | null
  // optional video id used by the regenerate button
  videoId?: string
  // callback invoked when a new graph JSON is available after regeneration
  onRegenerated?: (data: { nodes: NodeDatum[]; links: LinkDatum[] } | null) => void
  // when true, draw colored outlines around nodes per source id using sourcePalette
  showSourceOutlines?: boolean
  sourcePalette?: Record<string, string>
  universe?: string
}): JSX.Element {
  const videoId = props.videoId
  const onRegenerated = props.onRegenerated
  const [hasTranscript, setHasTranscript] = createSignal(false)
  const [isCheckingTranscript, setIsCheckingTranscript] = createSignal(false)
  // centralized per-video progress (SSE + fallback) hook
  const { videoProgress, setVideoProgress, checkingVideoProgress, getProgressES } = useVideoProgress(
    () => props.videoId,
    () => props.universe
  )

  // Check for transcript existence when there's no graph data so we can
  // present the Regenerate button to generate a graph from an existing
  // transcript. We re-check when videoId or universe or data changes.
  createEffect(() => {
    const vid = videoId
    if (!vid) {
      setHasTranscript(false)
      return
    }
    // if we already have graph data with nodes, no need to fetch transcript
    if (props.data && (props.data.nodes?.length ?? 0) > 0) {
      setHasTranscript(false)
      return
    }
    ;(async () => {
      setIsCheckingTranscript(true)
      try {
        const u = props.universe ? `?universe=${encodeURIComponent(props.universe)}` : ''
        const r = await fetch(`/api/videos/${vid}/transcript${u}`)
        if (!r.ok) {
          setHasTranscript(false)
          return
        }
        const json = await r.json()
        const ok = Array.isArray(json) ? json.length > 0 : Boolean(json && Object.keys(json).length > 0)
        setHasTranscript(ok)
      } catch (e) {
        setHasTranscript(false)
      } finally {
        setIsCheckingTranscript(false)
      }
    })()
  })

  // Hook manages SSE/fetch and cleanup. Keep a small effect so the component
  // still reacts to changes in props.videoId/props.universe and we can clear
  // local progress when no video is selected.
  createEffect(() => {
    const vid = videoId
    if (!vid) {
      setVideoProgress(null)
      return
    }
    void vid
  })
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
    // ensure svg background uses CSS variable so theme changes propagate
    selection.style('background', 'var(--bg-card)')

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
    // group for per-source bubbles (Universe view) drawn behind nodes
    const bubbleG = zoomG.append('g').attr('class', 'source-bubbles').attr('pointer-events', 'none')

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
    // Build per-source centers so nodes that share the same source are
    // biased toward the same region. We place source centers around a
    // circle and add forceX/forceY that pull nodes to their source center.
    const sourceList: string[] = []
    const nodePrimarySource = new Map<string, string | null>()
    for (const n of nodes) {
      const sids: string[] = Array.isArray((n as any).__sourceIds)
        ? (n as any).__sourceIds
        : Array.isArray(n.provenance)
          ? (n.provenance as any[]).map((p) => p?.source || p?.sourceId || p?.id).filter(Boolean)
          : []
      const primary = sids && sids.length ? sids[0] : null
      nodePrimarySource.set(n.id, primary)
      if (primary && !sourceList.includes(primary)) sourceList.push(primary)
    }
    const sourceCenters = new Map<string, { x: number; y: number }>()
    if (sourceList.length > 0) {
      const bigR = Math.max(120, Math.min(w, h) / 3)
      for (let i = 0; i < sourceList.length; i++) {
        const angle = (i / sourceList.length) * Math.PI * 2
        const cx = w / 2 + Math.cos(angle) * (bigR * 0.7)
        const cy = h / 2 + Math.sin(angle) * (bigR * 0.7)
        sourceCenters.set(sourceList[i], { x: cx, y: cy })
      }
    }

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
          .strength(0.95)
      )
      // stronger repulsion to reduce overlaps but allow clustering by source
      .force('charge', d3.forceManyBody().strength(-2000))
      // weak center fallback
      .force('center', d3.forceCenter(w / 2, h / 2).strength(0.02))
      // replace global x/y with source-targeted forces; nodes without a
      // primary source will be attracted to the center
      .force(
        'sourceX',
        d3
          .forceX<NodeDatum>()
          .x((d: any) => {
            const ps = nodePrimarySource.get(d.id)
            return ps && sourceCenters.has(ps) ? (sourceCenters.get(ps) as any).x : w / 2
          })
          .strength((d: any) => (nodePrimarySource.get(d.id) ? 0.6 : 0.02))
      )
      .force(
        'sourceY',
        d3
          .forceY<NodeDatum>()
          .y((d: any) => {
            const ps = nodePrimarySource.get(d.id)
            return ps && sourceCenters.has(ps) ? (sourceCenters.get(ps) as any).y : h / 2
          })
          .strength((d: any) => (nodePrimarySource.get(d.id) ? 0.6 : 0.02))
      )
      .force(
        'collide',
        d3
          .forceCollide<NodeDatum>()
          .radius((d: any) => (d.r ?? 8) + 6)
          .strength(0.9)
      )
      .alphaDecay(0.02)
      // kick the simulation to be more 'energetic' so clusters form faster
      .alpha(0.8)

    // NOTE: we'll render arrowheads as separate path elements (one per link)
    // instead of using SVG markers. This avoids cross-browser/ID issues and
    // lets us position the tip exactly on the target node border.

    const link = zoomG
      .append('g')
      .selectAll('line')
      .data(links)
      .enter()
      .append('line')
      .attr('stroke', 'var(--muted)')
      .attr('stroke-opacity', 0.6)

    // (arrow shapes are created after node label measurement so we have rect sizes)

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
      .attr('pointer-events', 'none')
      .text((d) => {
        const lbl = (d.label || '').toString()
        const l = lbl.toLowerCase()
        // heuristic: negative predicates contain words like 'not', 'neg', 'false', or explicit '-'
        if (l.includes('not') || l.includes('neg') || l.includes('false') || l.includes('-') || l.startsWith('!'))
          return 'decreases'
        return ''
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
      d3.select(this).select('rect').attr('stroke', 'var(--text)').attr('stroke-width', 1.5)
      try {
        props.onNodeHover?.({ id: d.id, provenance: (d as any).provenance ?? null, x: event.clientX, y: event.clientY })
      } catch (e) {}
    })
    nodeG.on('mouseout', function () {
      d3.select(this).select('rect').attr('stroke', null).attr('stroke-width', null)
      try {
        props.onNodeOut?.()
      } catch (e) {}
    })

    // handle click on a node: stop propagation so svg/background click won't also fire
    nodeG.on('click', function (event, d) {
      try {
        event.stopPropagation()
      } catch (e) {}
      try {
        // debug: log node clicks so we can verify handler wiring
        try {
          // eslint-disable-next-line no-console
          console.debug('GraphView node click', d.id)
        } catch (e) {}
        props.onNodeClick?.({
          id: d.id,
          provenance: (d as any).provenance ?? null,
          x: (event as any).clientX,
          y: (event as any).clientY
        })
      } catch (e) {}
    })

    const label = nodeG
      .append('text')
      .text((d: any) => d.label ?? d.id)
      .attr('font-size', 10)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      // choose text colour for contrast: use black for light/amber nodes (actor), white otherwise
      .attr('fill', 'var(--on-accent)')
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

        // per-node outlines removed in favor of per-source bubbles rendered
        // at the simulation tick stage
      } catch (e) {
        // if getBBox fails (rare), leave defaults
      }
    })

    // create arrow shapes after node sizes are measured so we can place the
    // arrow tips exactly at the target rectangle boundary and keep arrows on top
    const arrow = zoomG
      .append('g')
      .attr('class', 'link-arrows')
      .selectAll('path')
      .data(links)
      .enter()
      .append('path')
      .attr('class', 'link-arrow')
      .attr('d', 'M0,0 L-9,6 L-6,0 L-9,-6 Z')
      .attr('fill', 'var(--muted)')
      .attr('pointer-events', 'none')

    sim.on('tick', () => {
      link
        .attr('x1', (d: any) => (typeof d.source === 'string' ? 0 : d.source.x) as number)
        .attr('y1', (d: any) => (typeof d.source === 'string' ? 0 : d.source.y) as number)
        .attr('x2', (d: any) => {
          const sx = typeof d.source === 'string' ? 0 : d.source.x
          const sy = typeof d.source === 'string' ? 0 : d.source.y
          const tx = typeof d.target === 'string' ? 0 : d.target.x
          const ty = typeof d.target === 'string' ? 0 : d.target.y
          if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(tx) || !Number.isFinite(ty)) return tx
          const target = typeof d.target === 'string' ? null : d.target
          const w = (target && (target.__rectW ?? (target.r ? target.r * 2 : 16))) || 16
          const h = (target && (target.__rectH ?? (target.r ? target.r * 2 : 16))) || 16
          const hw = w / 2
          const hh = h / 2
          const ux = sx - tx
          const uy = sy - ty
          const absUx = Math.abs(ux)
          const absUy = Math.abs(uy)
          if (absUx === 0 && absUy === 0) return tx
          const k = Math.max(absUx / (hw || 1), absUy / (hh || 1))
          const scale = k === 0 ? 0 : 1 / k
          const ix = tx + ux * scale
          return ix
        })
        .attr('y2', (d: any) => {
          const sx = typeof d.source === 'string' ? 0 : d.source.x
          const sy = typeof d.source === 'string' ? 0 : d.source.y
          const tx = typeof d.target === 'string' ? 0 : d.target.x
          const ty = typeof d.target === 'string' ? 0 : d.target.y
          if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(tx) || !Number.isFinite(ty)) return ty
          const target = typeof d.target === 'string' ? null : d.target
          const w = (target && (target.__rectW ?? (target.r ? target.r * 2 : 16))) || 16
          const h = (target && (target.__rectH ?? (target.r ? target.r * 2 : 16))) || 16
          const hw = w / 2
          const hh = h / 2
          const ux = sx - tx
          const uy = sy - ty
          const absUx = Math.abs(ux)
          const absUy = Math.abs(uy)
          if (absUx === 0 && absUy === 0) return ty
          const k = Math.max(absUx / (hw || 1), absUy / (hh || 1))
          const scale = k === 0 ? 0 : 1 / k
          const iy = ty + uy * scale
          return iy
        })

      // position per-link arrowheads so the tip sits on the target rectangle edge
      arrow.attr('transform', (d: any) => {
        const sx = typeof d.source === 'string' ? 0 : d.source.x
        const sy = typeof d.source === 'string' ? 0 : d.source.y
        const tx = typeof d.target === 'string' ? 0 : d.target.x
        const ty = typeof d.target === 'string' ? 0 : d.target.y
        if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(tx) || !Number.isFinite(ty)) return ''
        const target = typeof d.target === 'string' ? null : d.target
        const w = (target && (target.__rectW ?? (target.r ? target.r * 2 : 16))) || 16
        const h = (target && (target.__rectH ?? (target.r ? target.r * 2 : 16))) || 16
        const hw = w / 2
        const hh = h / 2
        const ux = sx - tx
        const uy = sy - ty
        const absUx = Math.abs(ux)
        const absUy = Math.abs(uy)
        if (absUx === 0 && absUy === 0) return ''
        const k = Math.max(absUx / (hw || 1), absUy / (hh || 1))
        const scale = k === 0 ? 0 : 1 / k
        const ix = tx + ux * scale
        const iy = ty + uy * scale
        const angle = (Math.atan2(ty - sy, tx - sx) * 180) / Math.PI
        return `translate(${ix},${iy}) rotate(${angle})`
      })

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

      // update per-source bubbles (Universe view) — compute hull per source and render
      try {
        const snodes = sim ? (sim.nodes() as any[]) : []
        const sourceMap = new Map<string, { id: string; points: [number, number][] }>()
        for (const n of snodes) {
          const srcs: string[] = Array.isArray((n as any).__sourceIds) ? (n as any).__sourceIds : []
          if (!srcs || !srcs.length) continue
          for (const s of srcs) {
            if (!sourceMap.has(s)) sourceMap.set(s, { id: s, points: [] })
            const entry = sourceMap.get(s)!
            if (Number.isFinite(n.x) && Number.isFinite(n.y)) entry.points.push([n.x as number, n.y as number])
          }
        }

        const sourcesArr = Array.from(sourceMap.values())
        // bind paths
        const pathGen = d3.line().curve(d3.curveCardinalClosed.tension(0.6))
        const pads = 20 // padding around hull
        const bubbles = bubbleG.selectAll('path.bubble').data(sourcesArr, (d: any) => d.id)
        bubbles.exit().remove()
        const be = bubbles.enter().append('path').attr('class', 'bubble').attr('pointer-events', 'none')
        const all = be.merge(bubbles as any)
        all.each(function (d: any) {
          const pts = d.points || []
          let pathStr = ''
          if (!pts || pts.length === 0) {
            pathStr = ''
          } else if (pts.length === 1) {
            const x = pts[0][0]
            const y = pts[0][1]
            const r = 30
            const p = d3.path()
            p.arc(x, y, r, 0, Math.PI * 2)
            pathStr = p.toString()
            // store centroid for label placement
            d.__centroid = [x, y]
          } else {
            // compute convex hull
            const hull = d3.polygonHull(pts as [number, number][])
            let poly: [number, number][] = hull ?? pts
            // inflate polygon by pushing points away from centroid
            const centroid = d3.polygonCentroid(poly)
            const inflated = poly.map(([x, y]) => {
              const dx = x - centroid[0]
              const dy = y - centroid[1]
              const len = Math.sqrt(dx * dx + dy * dy) || 1
              const k = 1 + pads / len
              return [centroid[0] + dx * k, centroid[1] + dy * k]
            })
            // store centroid for label placement (use centroid of inflated polygon)
            d.__centroid = d3.polygonCentroid(inflated as any)
            pathStr = pathGen(inflated as any) || ''
          }
          d3.select(this).attr('d', pathStr)
        })

        // style bubbles
        all
          .attr('fill', (d: any) => (props.sourcePalette ? props.sourcePalette[d.id] || '#999' : '#999'))
          .attr('fill-opacity', 0.07)
          .attr('stroke', (d: any) => (props.sourcePalette ? props.sourcePalette[d.id] || '#666' : '#666'))
          .attr('stroke-opacity', 0.7)
          .attr('stroke-width', 2)
        // render centered source labels using the same colour as the outline
        try {
          const labelSel = bubbleG.selectAll('text.bubble-label').data(sourcesArr, (d: any) => d.id)
          labelSel.exit().remove()
          const labelEnter = labelSel
            .enter()
            .append('text')
            .attr('class', 'bubble-label')
            .attr('pointer-events', 'none')
            .attr('text-anchor', 'middle')
            .attr('dominant-baseline', 'central')
            .attr('font-weight', 600 as any)
            .attr('font-size', 14)
          const labelsAll = labelEnter.merge(labelSel as any)
          labelsAll.each(function (d: any) {
            const col = props.sourcePalette ? props.sourcePalette[d.id] || '#666' : '#666'
            const cent = (d as any).__centroid || (d.points && d.points[0]) || [0, 0]
            d3.select(this).attr('x', cent[0]).attr('y', cent[1]).text(d.id).attr('fill', col).attr('opacity', 0.95)
          })
        } catch (e) {
          // ignore label rendering errors
        }
      } catch (e) {
        // don't let bubble rendering break the whole tick
      }
    })

    // background click clears selection
    selection.on('click', (event) => {
      try {
        // if click target is the svg itself or the root group (not a node-group), treat as background
        const tgt = event.target as Element
        if (!tgt.closest || !tgt.closest('.node-group')) {
          try {
            // eslint-disable-next-line no-console
            console.debug('GraphView background click')
          } catch (e) {}
          props.onNodeClick?.({ id: null })
        }
      } catch (e) {}
    })
  }

  // react to highlight changes without rebuilding the simulation
  createEffect(() => {
    // access prop to track changes
    const h = props.highlightedNodes
    if (!svgSel) return
    // update node/link opacity based on highlightedNodes (include selectedNodeId so selection persists)
    const selRect = svgSel.selectAll('g.node-group').selectAll('rect')
    const selLinks = svgSel.selectAll('line')
    const selLinkLabels = svgSel.selectAll('text.link-label')
    const selId = props.selectedNodeId ?? null
    const active = new Set<string>()
    if (h && h.size) for (const v of Array.from(h)) active.add(v)
    if (selId) active.add(selId)
    if (active.size) {
      selRect.attr('opacity', (d: any) => (active.has(d.id) ? 1 : 0.12))
      selLinks.attr('opacity', (d: any) => {
        const s = typeof d.source === 'string' ? d.source : d.source.id
        const t = typeof d.target === 'string' ? d.target : d.target.id
        return active.has(s) || active.has(t) ? 0.9 : 0.08
      })
      selLinkLabels.attr('opacity', (d: any) => {
        const s = typeof d.source === 'string' ? d.source : d.source.id
        const t = typeof d.target === 'string' ? d.target : d.target.id
        return active.has(s) || active.has(t) ? 1 : 0.12
      })
    } else {
      selRect.attr('opacity', 1)
      selLinks.attr('opacity', 0.6)
      selLinkLabels.attr('opacity', 1)
    }

    // apply selection styling (stroke) and bring selected node to front
    const nodeGroups = svgSel.selectAll('g.node-group')
    nodeGroups
      .select('rect')
      .attr('stroke', (d: any) => (selId && d.id === selId ? 'var(--text)' : null))
      .attr('stroke-width', (d: any) => (selId && d.id === selId ? 1.5 : null))
    if (selId) {
      try {
        nodeGroups.filter((d: any) => d.id === selId).raise()
      } catch (e) {}
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
      {/* Overlay message when no graph data is available */}
      {(!props.data || (props.data.nodes?.length ?? 0) === 0) && (
        <div class="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <div class="text-gray-500 text-sm">No Graph</div>
        </div>
      )}

      <div class="absolute top-2 right-2 flex gap-2 z-30">
        {videoId && (hasTranscript() || (props.data && (props.data.nodes?.length ?? 0) === 0) || props.data) ? (
          <div class="flex items-center gap-2">
            {videoProgress() ? (
              <div class="text-sm text-gray-600">{videoProgress()!.status || 'Processing…'}</div>
            ) : null}
            <button
              disabled={isCheckingTranscript() || Boolean(videoProgress())}
              class={
                'px-2 py-1 text-sm bg-white border rounded shadow hover:bg-gray-50 ' +
                (isCheckingTranscript() || videoProgress() ? 'opacity-50 cursor-not-allowed' : '')
              }
              onClick={async () => {
                if (!videoId) return
                // ensure SSE is open so we don't miss initial progress events
                try {
                  if (!getProgressES()) {
                    try {
                      // open a temporary EventSource so we capture early progress events
                      openTemporaryProgressEventSource(videoId, props.universe, (j) => setVideoProgress(j))
                    } catch (e) {}
                  }
                } catch (e) {}
                try {
                  const b = document.activeElement as HTMLElement // keep focus
                  // include optional universe query param
                  const u = props.universe ? `?universe=${encodeURIComponent(props.universe)}` : ''
                  // POST to trigger regeneration
                  await fetch(`/api/videos/${videoId}/regenerate${u}`, { method: 'POST' })
                  // fetch updated graph
                  const r = await fetch(`/api/videos/${videoId}/graph${u}`)
                  if (r.ok) {
                    const json = await r.json()
                    onRegenerated?.(json)
                  }
                  if (b) b.focus()
                } catch (e) {
                  console.error('Regenerate failed', e)
                }
              }}
            >
              Regenerate
            </button>
          </div>
        ) : null}
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
