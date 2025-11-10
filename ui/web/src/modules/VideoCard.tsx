import type { JSX } from 'solid-js'
import { createEffect, createSignal, For, onMount } from 'solid-js'
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

export default function VideoCard(props: { id: string }): JSX.Element {
  const [transcript, setTranscript] = createSignal<TranscriptChunk[]>([])
  const [graph, setGraph] = createSignal<GraphData | null>(null)
  const [leftWidth, setLeftWidth] = createSignal<number | null>(null) // pixels or null (use flex)
  let leftEl: HTMLDivElement | undefined
  let dividerEl: HTMLDivElement | undefined

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
    fetch(`/api/videos/${props.id}/transcript`)
      .then((r) => r.json())
      .then(setTranscript)
      .catch(() => {})
    fetch(`/api/videos/${props.id}/graph`)
      .then((r) => r.json())
      .then(setGraph)
      .catch(() => {})
  })

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
            <GraphView data={graph()} />
          </div>
        </div>

        {/* Divider / drag handle (only on md+) */}
        <div class="hidden md:flex items-center" ref={(el) => (dividerEl = el)}>
          <div class="w-2 h-full cursor-col-resize" style="touch-action: none;" onMouseDown={startDrag}>
            <div class="w-0.5 h-full mx-auto bg-gray-200" />
          </div>
        </div>

        <div class="flex-1 min-w-0">
          <h2 class="font-semibold mb-2">Transcript</h2>
          <div class="max-h-[240px] overflow-y-auto space-y-1 text-sm p-2 bg-white rounded border">
            <For each={transcript()}>
              {(chunk) => (
                <div class="p-1 rounded hover:bg-gray-50">
                  <span>{chunk.text}</span>
                </div>
              )}
            </For>
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
