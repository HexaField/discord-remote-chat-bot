import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import VideoCard from './VideoCard'

export type VideoItem = { id: string; title?: string }

export default function App() {
  const [videos, setVideos] = createSignal<VideoItem[]>([])
  const [selected, setSelected] = createSignal<string | null>(null)

  createEffect(() => {
    fetch('/api/videos')
      .then((r) => r.json())
      .then(setVideos)
      .catch((err) => console.error('Failed to load videos', err))
  })

  const [sidebarWidth, setSidebarWidth] = createSignal<number>(300)
  const [collapsed, setCollapsed] = createSignal<boolean>(false)

  // read video from search params on mount and handle popstate
  onMount(() => {
    const params = new URLSearchParams(window.location.search)
    const v = params.get('video')
    if (v) setSelected(v)
    const onPop = () => {
      const p = new URLSearchParams(window.location.search).get('video')
      setSelected(p)
    }
    window.addEventListener('popstate', onPop)
    onCleanup(() => window.removeEventListener('popstate', onPop))
  })

  // keep search params in sync with selection (replaceState only when changed)
  createEffect(() => {
    const v = selected()
    const params = new URLSearchParams(window.location.search)
    const cur = params.get('video')
    if (v === cur) return
    if (v) params.set('video', v)
    else params.delete('video')
    const q = params.toString()
    const url = window.location.pathname + (q ? `?${q}` : '')
    history.replaceState(null, '', url)
  })

  return (
    // full-viewport app container; prevent outer scrolling while allowing inner panels to scroll
    <div class="flex flex-col h-full w-full p-0 gap-0 overflow-hidden bg-gray-100">
      <main class="flex-1 flex h-full">
        {/* Sidebar */}
        <div
          class="flex-none border-r bg-white h-full flex flex-col"
          style={{ width: collapsed() ? '56px' : `${sidebarWidth()}px` }}
        >
          <div class="flex items-center justify-between p-2">
            <div class="flex items-center gap-2">
              <button
                class="p-1 rounded hover:bg-gray-100"
                onClick={() => setCollapsed((c) => !c)}
                aria-label="Toggle sidebar"
              >
                {collapsed() ? '▸' : '◂'}
              </button>
              {/* hide title when collapsed */}
              {!collapsed() && <span class="font-semibold">Videos</span>}
            </div>
            {!collapsed() && <div class="text-xs text-gray-500">{videos().length} items</div>}
          </div>

          <div class="flex-1 overflow-auto">
            <For each={videos()}>
              {(v) => (
                <button
                  class={`w-full text-left p-3 hover:bg-gray-50 flex items-center gap-2 ${selected() === v.id ? 'bg-gray-100' : ''}`}
                  onClick={() => setSelected((p) => (p === v.id ? null : v.id))}
                >
                  <div class="w-8 h-8 bg-gray-200 rounded flex items-center justify-center text-xs">YT</div>
                  {/* hide text content when collapsed */}
                  {!collapsed() && (
                    <div class="truncate">
                      <div class="font-semibold truncate">{v.title ?? v.id}</div>
                      <div class="text-xs text-gray-500 truncate">{v.id}</div>
                    </div>
                  )}
                </button>
              )}
            </For>
          </div>

          {/* Resize handle for sidebar */}
          {!collapsed() && (
            <div class="h-6 p-1 border-t flex items-center justify-center">
              <div
                class="w-full h-1 bg-transparent cursor-col-resize"
                onMouseDown={(e: MouseEvent) => {
                  e.preventDefault()
                  const startX = e.clientX
                  const startW = sidebarWidth()
                  const onMove = (ev: MouseEvent) => {
                    const dx = ev.clientX - startX
                    setSidebarWidth(Math.max(120, startW + dx))
                  }
                  const onUp = () => {
                    window.removeEventListener('mousemove', onMove)
                    window.removeEventListener('mouseup', onUp)
                  }
                  window.addEventListener('mousemove', onMove)
                  window.addEventListener('mouseup', onUp)
                }}
              />
            </div>
          )}
        </div>

        {/* Main content area (graph + transcript/video) */}
        <div class="flex-1 h-full overflow-hidden">
          <div class="p-4 h-full">
            <Show
              when={selected()}
              fallback={<div class="text-gray-500">Select a video from the left to view details.</div>}
            >
              <div class="h-full">
                <VideoCard id={selected()!} />
              </div>
            </Show>
          </div>
        </div>
      </main>
    </div>
  )
}
