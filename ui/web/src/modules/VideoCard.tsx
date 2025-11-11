import type { JSX } from 'solid-js'
import { createEffect, createMemo, createSignal, For, onMount } from 'solid-js'
import GraphView from './GraphView'

interface TranscriptChunk {
  text: string
  start?: number
  end?: number
  provenance?: any
}

interface GraphData {
  nodes: { id: string; label?: string; type?: string }[]
  links: { source: string; target: string; label?: string }[]
}

export default function VideoCard(props: { id: string; universe?: string }): JSX.Element {
  const [transcript, setTranscript] = createSignal<TranscriptChunk[]>([])
  const [graph, setGraph] = createSignal<GraphData | null>(null)
  const [highlightedNodes, setHighlightedNodes] = createSignal<Set<string> | null>(null)
  const [hoveredTranscriptIdxs, setHoveredTranscriptIdxs] = createSignal<Set<number> | null>(null)
  const [selectedNodeId, setSelectedNodeId] = createSignal<string | null>(null)
  const [tooltip, setTooltip] = createSignal<{
    visible: boolean
    x?: number
    y?: number
    items?: { idx?: number; start?: number; end?: number; text?: string }[]
  }>({ visible: false })
  const [leftWidth, setLeftWidth] = createSignal<number | null>(null) // pixels or null (use flex)
  let leftEl: HTMLDivElement | undefined
  let transcriptEl: HTMLDivElement | undefined

  onMount(() => {
    // Initialize left width: prefer saved value in localStorage, otherwise default to 2/3 of available width.
    const STORAGE_KEY = 'graphLeftWidth'
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const n = parseInt(saved, 10)
        if (!isNaN(n)) setLeftWidth(n)
      } else {
        // default to 2/3 of available width
        const pw = leftEl?.parentElement?.getBoundingClientRect().width ?? document.documentElement.clientWidth ?? 900
        setLeftWidth(Math.max(180, Math.floor((pw * 2) / 3)))
      }
    } catch (e) {
      // ignore storage errors and fallback to default
      const pw = leftEl?.parentElement?.getBoundingClientRect().width ?? document.documentElement.clientWidth ?? 900
      setLeftWidth(Math.max(180, Math.floor((pw * 2) / 3)))
    }
  })

  function startDrag(e: MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startW = leftEl ? leftEl.getBoundingClientRect().width : leftWidth() || 400
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      setLeftWidth(Math.max(180, startW + dx))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // persist the chosen width
      try {
        localStorage.setItem('graphLeftWidth', String(leftWidth() || 0))
      } catch (e) {}
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  createEffect(() => {
    const u = props.universe ? `?universe=${encodeURIComponent(props.universe)}` : ''
    fetch(`/api/videos/${props.id}/transcript${u}`)
      .then((r) => r.json())
      .then(setTranscript)
      .catch(() => {})
    fetch(`/api/videos/${props.id}/graph${u}`)
      .then((r) => r.json())
      .then(setGraph)
      .catch(() => {})
  })

  // Build quick lookup maps from graph/transcript for provenance mapping
  const nodeById = createMemo(() => {
    const g = graph()
    const m = new Map<string, any>()
    if (!g) return m
    for (const n of g.nodes) {
      m.set(n.id, n)
    }
    return m
  })

  // heuristics: map provenance entries to transcript chunk indices
  function provToChunkIndices(prov: any[] | undefined | null): Set<number> {
    const out = new Set<number>()
    if (!prov || !Array.isArray(prov)) return out
    const tx = transcript()
    for (const p of prov) {
      // if provenance explicitly references chunk index
      if (typeof p.chunkIndex === 'number') {
        out.add(p.chunkIndex)
        continue
      }
      if (typeof p.index === 'number') {
        out.add(p.index)
        continue
      }
      // if provenance gives start/end times, match overlapping transcript chunks
      if (typeof p.start === 'number' || typeof p.end === 'number') {
        const s = typeof p.start === 'number' ? p.start : -Infinity
        const e = typeof p.end === 'number' ? p.end : Infinity
        tx.forEach((c, i) => {
          const cs = c.start ?? -Infinity
          const ce = c.end ?? Infinity
          if (!(ce < s || cs > e)) out.add(i)
        })
        continue
      }
      // if provenance references transcript text, try to find chunk containing that text
      if (typeof p.text === 'string') {
        const needle = p.text.trim().slice(0, 80)
        tx.forEach((c, i) => {
          if (c.text && c.text.includes(needle)) out.add(i)
        })
        continue
      }
      // if provenance references node indices or ids, skip here
    }
    return out
  }

  // find node ids that reference a transcript index
  function nodesForTranscriptIndex(idx: number): Set<string> {
    const out = new Set<string>()
    const g = graph()
    if (!g) return out
    for (const n of g.nodes) {
      const prov = (n as any).provenance
      if (!prov) continue
      const idxs = provToChunkIndices(prov)
      if (idxs.has(idx)) out.add(n.id)
    }
    return out
  }

  // format seconds (number) into H:MM:SS or M:SS
  function formatTime(s: number | undefined): string {
    if (s === undefined || s === null || Number.isNaN(s)) return ''
    const total = Math.max(0, Math.floor(s))
    const hrs = Math.floor(total / 3600)
    const mins = Math.floor((total % 3600) / 60)
    const secs = total % 60
    const pad = (n: number) => String(n).padStart(2, '0')
    if (hrs > 0) return `${hrs}:${pad(mins)}:${pad(secs)}`
    return `${mins}:${pad(secs)}`
  }

  // handle node hover from GraphView
  function handleNodeHover(ev: { id: string; provenance?: any[] | null; x: number; y: number }) {
    // compute transcript chunks related to its provenance
    const idxs = provToChunkIndices(ev.provenance ?? undefined)
    setHoveredTranscriptIdxs(idxs.size ? idxs : null)
    // prepare tooltip items
    const items: { idx?: number; start?: number; end?: number; text?: string }[] = []
    if (idxs.size) {
      const tx = transcript()
      for (const i of Array.from(idxs)) {
        const c = tx[i]
        if (c) items.push({ idx: i, start: c.start, end: c.end, text: c.text })
      }
    } else if (ev.provenance && ev.provenance.length) {
      for (const p of ev.provenance) {
        items.push({ start: p.start, end: p.end, text: p.text })
      }
    }
    setTooltip({ visible: true, x: ev.x, y: ev.y, items })
  }

  function handleNodeOut() {
    setHighlightedNodes(null)
    setHoveredTranscriptIdxs(null)
    setTooltip({ visible: false })
  }

  // handle node click: toggle selection and scroll the transcript to the first related chunk
  function handleNodeClick(ev: { id: string | null; provenance?: any[] | null; x?: number; y?: number } | null) {
    if (!ev || ev.id === null) {
      // background click -> clear selection
      setHighlightedNodes(null)
      setHoveredTranscriptIdxs(null)
      setTooltip({ visible: false })
      setSelectedNodeId(null)
      return
    }
    const id = ev.id
    const cur = highlightedNodes()
    // toggle if same selected
    if (selectedNodeId() === id) {
      setSelectedNodeId(null)
      setHighlightedNodes(null)
      setHoveredTranscriptIdxs(null)
      setTooltip({ visible: false })
      return
    }
    // select this node
    setSelectedNodeId(id)
    setHighlightedNodes(new Set([id]))
    // resolve provenance from nodeById map if available
    const nb = nodeById().get(id)
    const prov = nb ? (nb.provenance as any[] | undefined) : ev.provenance
    const idxs = provToChunkIndices(prov)
    setHoveredTranscriptIdxs(idxs.size ? idxs : null)

    // scroll to the first matching transcript chunk if present
    if (idxs.size && transcriptEl) {
      const first = Array.from(idxs).sort((a, b) => a - b)[0]
      try {
        const target = transcriptEl.querySelector(`[data-idx="${first}"]`) as HTMLElement | null
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } catch (e) {}
    }
  }

  return (
    <div class="space-y-4 h-full">
      {/* two-column resizable: graph left, transcript+video right */}
      <div class="flex flex-col md:flex-row gap-4 h-full">
        <div
          class="flex-1 md:flex-none md:overflow-hidden md:h-full"
          style={{ width: leftWidth() ? `${leftWidth()}px` : 'auto' }}
        >
          <h2 class="font-semibold mb-2">Graph</h2>
          <div class="h-full border rounded bg-white">
            <GraphView
              data={graph()}
              highlightedNodes={highlightedNodes()}
              onNodeHover={handleNodeHover}
              onNodeOut={handleNodeOut}
              onNodeClick={handleNodeClick}
              selectedNodeId={selectedNodeId()}
              videoId={props.id}
              universe={props.universe}
              onRegenerated={(d: any) => {
                try {
                  setGraph(d)
                } catch (e) {}
              }}
            />
          </div>
        </div>

        {/* Divider / drag handle (only on md+) */}
        <div class="hidden md:flex items-center">
          <div class="w-2 h-full cursor-col-resize" style="touch-action: none;" onMouseDown={startDrag}>
            <div class="w-0.5 h-full mx-auto bg-gray-200" />
          </div>
        </div>

        <div class="flex-1 min-w-0">
          <h2 class="font-semibold mb-2">Transcript</h2>
          <div
            ref={(el) => (transcriptEl = el)}
            class="max-h-[240px] overflow-y-auto space-y-1 text-sm p-2 bg-white rounded border relative"
          >
            <For each={transcript()}>
              {(chunk, i) => {
                const idx = i()
                const isHighlighted = () => (hoveredTranscriptIdxs() ? hoveredTranscriptIdxs()!.has(idx) : false)
                return (
                  <div
                    data-idx={idx}
                    // make a group so child timestamp can respond to hover/focus
                    class={
                      'group p-1 rounded cursor-default focus:outline-none ' +
                      (isHighlighted() ? 'bg-yellow-50' : 'hover:bg-gray-50')
                    }
                    tabindex={0}
                    onMouseEnter={() => {
                      // compute nodes that reference this transcript chunk
                      const nodes = nodesForTranscriptIndex(idx)
                      setHighlightedNodes(nodes.size ? nodes : null)
                      setHoveredTranscriptIdxs(nodes.size ? new Set([idx]) : new Set([idx]))
                    }}
                    onMouseLeave={() => {
                      setHighlightedNodes(null)
                      setHoveredTranscriptIdxs(null)
                    }}
                    onFocus={() => {
                      const nodes = nodesForTranscriptIndex(idx)
                      setHighlightedNodes(nodes.size ? nodes : null)
                      setHoveredTranscriptIdxs(nodes.size ? new Set([idx]) : new Set([idx]))
                    }}
                    onBlur={() => {
                      setHighlightedNodes(null)
                      setHoveredTranscriptIdxs(null)
                    }}
                  >
                    {/* timestamp at start, gray by default, stronger on hover/focus */}
                    <time class="text-[12px] text-gray-400 mr-2 group-hover:text-gray-700 group-focus:text-gray-700 transition-colors">
                      {formatTime(chunk.start)}
                    </time>
                    <span>{chunk.text}</span>
                  </div>
                )
              }}
            </For>

            {/* tooltip shown when hovering a node */}
            {tooltip().visible && (
              <div
                class="absolute z-20 p-2 bg-white border rounded shadow text-xs max-w-xs"
                style={{
                  left: `${tooltip().x ?? 0}px`,
                  top: `${tooltip().y ?? 0}px`,
                  transform: 'translate(8px, 8px)'
                }}
              >
                <For each={tooltip().items ?? []}>
                  {(it) => (
                    <div class="mb-1">
                      {it.idx !== undefined ? <div class="text-[10px] text-gray-500">Chunk #{it.idx}</div> : null}
                      {it.start !== undefined || it.end !== undefined ? (
                        <div class="text-[10px] text-gray-500">
                          {it.start ?? ''} - {it.end ?? ''}
                        </div>
                      ) : null}
                      <div class="text-[12px]">{it.text}</div>
                    </div>
                  )}
                </For>
              </div>
            )}
          </div>

          {/* Video under the transcript */}
          <div class="mt-3 aspect-video">
            <iframe
              class="w-full h-full"
              src={`https://www.youtube.com/embed/${props.id}`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen
            />
          </div>
        </div>
      </div>
    </div>
  )
}
