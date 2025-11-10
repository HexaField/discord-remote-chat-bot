import * as d3 from 'd3'
import type { JSX } from 'solid-js'
import { createEffect, onCleanup, onMount } from 'solid-js'

type NodeDatum = d3.SimulationNodeDatum & { id: string; label?: string; type?: string }

type LinkDatum = d3.SimulationLinkDatum<NodeDatum> & {
  source: string | NodeDatum
  target: string | NodeDatum
  label?: string
}

export default function GraphView(props: { data: { nodes: NodeDatum[]; links: LinkDatum[] } | null }): JSX.Element {
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
    const nodes: NodeDatum[] = props.data.nodes.map((n) => ({ ...n }))
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

    sim = d3
      .forceSimulation<NodeDatum>(nodes)
      .force(
        'link',
        d3
          .forceLink<NodeDatum, LinkDatum>(links)
          .id((d) => d.id)
          .distance(60)
      )
      .force('charge', d3.forceManyBody().strength(-100))
      .force('center', d3.forceCenter(w / 2, h / 2))

    const link = zoomG
      .append('g')
      .attr('stroke', '#999')
      .selectAll('line')
      .data(links)
      .enter()
      .append('line')
      .attr('stroke-opacity', 0.6)

    const node = zoomG
      .append('g')
      .selectAll('circle')
      .data(nodes)
      .enter()
      .append('circle')
      .attr('r', 6)
      .attr('fill', (d) => (d.type === 'entity' ? '#2563eb' : '#16a34a'))
      .call(
        d3
          .drag<SVGCircleElement, NodeDatum>()
          .on('start', (event, d) => {
            if (!event.active && sim) sim.alphaTarget(0.3).restart()
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

    const label = zoomG
      .append('g')
      .selectAll('text')
      .data(nodes)
      .enter()
      .append('text')
      .text((d) => d.label ?? d.id)
      .attr('font-size', 10)
      .attr('dx', 8)
      .attr('dy', 4)

    sim.on('tick', () => {
      link
        .attr('x1', (d) => (typeof d.source === 'string' ? 0 : d.source.x) as number)
        .attr('y1', (d) => (typeof d.source === 'string' ? 0 : d.source.y) as number)
        .attr('x2', (d) => (typeof d.target === 'string' ? 0 : d.target.x) as number)
        .attr('y2', (d) => (typeof d.target === 'string' ? 0 : d.target.y) as number)

      node.attr('cx', (d) => d.x as number).attr('cy', (d) => d.y as number)
      label.attr('x', (d) => (d.x as number) + 8).attr('y', (d) => (d.y as number) + 4)
    })
  }

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
    const svgNode = svgSel.node()
    if (!svgNode) return
    const circles = svgNode.querySelectorAll('circle')
    if (!circles || circles.length === 0) return
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    circles.forEach((c) => {
      const cx = parseFloat(c.getAttribute('cx') || '0')
      const cy = parseFloat(c.getAttribute('cy') || '0')
      if (Number.isFinite(cx) && Number.isFinite(cy)) {
        minX = Math.min(minX, cx)
        minY = Math.min(minY, cy)
        maxX = Math.max(maxX, cx)
        maxY = Math.max(maxY, cy)
      }
    })
    if (minX === Infinity) return
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
