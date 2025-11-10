import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import VideoCard from './VideoCard'

export type VideoItem = { id: string; title?: string; thumbnail?: string }

export default function App() {
  const [videos, setVideos] = createSignal<VideoItem[]>([])
  const [selected, setSelected] = createSignal<string | null>(null)

  createEffect(() => {
    // initial load
    fetch('/api/videos')
      .then((r) => r.json())
      .then(setVideos)
      .catch((err) => console.error('Failed to load videos', err))
  })

  // helper to refresh videos list from server
  async function refreshVideos() {
    try {
      const r = await fetch('/api/videos')
      if (r.ok) setVideos(await r.json())
    } catch (e) {
      console.error('Failed to refresh videos', e)
    }
  }

  const [sidebarWidth, setSidebarWidth] = createSignal<number>(300)
  const [collapsed, setCollapsed] = createSignal<boolean>(false)

  // Theme: 'system' | 'light' | 'dark'
  const THEME_STORAGE = 'theme'
  const [theme, setTheme] = createSignal<'system' | 'light' | 'dark'>('system')
  let mediaQ: MediaQueryList | null = null

  function applyTheme(t: 'system' | 'light' | 'dark') {
    try {
      if (t === 'dark') {
        document.documentElement.classList.add('dark')
      } else if (t === 'light') {
        document.documentElement.classList.remove('dark')
      } else {
        // system
        const mq = window.matchMedia('(prefers-color-scheme: dark)')
        if (mq.matches) document.documentElement.classList.add('dark')
        else document.documentElement.classList.remove('dark')
      }
    } catch (e) {}
  }

  function cycleTheme() {
    const cur = theme()
    const next = cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system'
    setTheme(next)
    try {
      localStorage.setItem(THEME_STORAGE, next)
    } catch (e) {}
    applyTheme(next)
  }

  onMount(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE) as 'system' | 'light' | 'dark' | null
      if (saved === 'light' || saved === 'dark' || saved === 'system') setTheme(saved)
      else setTheme('system')
    } catch (e) {
      setTheme('system')
    }
    // apply initial theme
    applyTheme(theme())

    // listen for system preference changes when in 'system' mode
    try {
      mediaQ = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = () => {
        if (theme() === 'system') applyTheme('system')
      }
      // addEventListener may not exist on older browsers; fall back to addListener
      if (mediaQ.addEventListener) mediaQ.addEventListener('change', onChange)
      else if (mediaQ.addListener) mediaQ.addListener(onChange)
      onCleanup(() => {
        if (!mediaQ) return
        if ((mediaQ as any).removeEventListener) (mediaQ as any).removeEventListener('change', onChange)
        else if ((mediaQ as any).removeListener) (mediaQ as any).removeListener(onChange)
      })
    } catch (e) {}
  })

  // read video from search params on mount and handle popstate
  onMount(() => {
    const params = new URLSearchParams(window.location.search)
    const v = params.get('v')
    if (v) setSelected(v)
    const onPop = () => {
      const p = new URLSearchParams(window.location.search).get('v')
      setSelected(p)
    }
    window.addEventListener('popstate', onPop)
    onCleanup(() => window.removeEventListener('popstate', onPop))
  })

  // keep search params in sync with selection (replaceState only when changed)
  createEffect(() => {
    const v = selected()
    const params = new URLSearchParams(window.location.search)
    const cur = params.get('v')
    if (v === cur) return
    if (v) params.set('v', v)
    else params.delete('v')
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
          onDrop={async (e: DragEvent) => {
            e.preventDefault()
            try {
              const dt = e.dataTransfer
              if (!dt) return
              // files dropped
              if (dt.files && dt.files.length > 0) {
                const fd = new FormData()
                for (let i = 0; i < dt.files.length; i++) fd.append('files', dt.files[i])
                await fetch('/api/videos/import', { method: 'POST', body: fd })
                await refreshVideos()
                return
              }
              // text/uri list dropped
              const text = dt.getData('text/plain') || dt.getData('text/uri-list')
              if (text) {
                await fetch('/api/videos/import', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text })
                })
                await refreshVideos()
              }
            } catch (e) {
              console.error('Import failed', e)
            }
          }}
          onDragOver={(e: DragEvent) => e.preventDefault()}
          onPaste={async (e: ClipboardEvent) => {
            try {
              const text = e.clipboardData?.getData('text/plain')
              if (!text) return
              await fetch('/api/videos/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
              })
              await refreshVideos()
            } catch (err) {
              console.error('Paste import failed', err)
            }
          }}
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
            <div class="flex items-center gap-2">
              {!collapsed() && <div class="text-xs text-gray-500">{videos().length} items</div>}
              {/* Theme toggle: cycles system -> light -> dark */}
              {!collapsed() && (
                <button
                  class="p-1 rounded hover:bg-gray-100 text-sm"
                  onClick={cycleTheme}
                  title="Cycle theme: System → Light → Dark"
                >
                  {theme() === 'system' && '🖥 System'}
                  {theme() === 'light' && '🌞 Light'}
                  {theme() === 'dark' && '🌙 Dark'}
                </button>
              )}
              {collapsed() && (
                <button class="p-1 rounded hover:bg-gray-100 text-sm" onClick={cycleTheme} title="Cycle theme">
                  {theme() === 'system' && '🖥'}
                  {theme() === 'light' && '🌞'}
                  {theme() === 'dark' && '🌙'}
                </button>
              )}
            </div>
          </div>

          <div class="flex-1 overflow-auto">
            <For each={videos()}>
              {(v) => (
                <button
                  class={`w-full text-left p-3 hover:bg-gray-50 flex items-center gap-2 ${selected() === v.id ? 'bg-gray-100' : ''}`}
                  onClick={() => setSelected((p) => (p === v.id ? null : v.id))}
                >
                  <div class="w-8 h-8 bg-gray-200 rounded overflow-hidden">
                    {v.thumbnail ? (
                      <img src={v.thumbnail} alt={v.title ?? v.id} class="w-8 h-8 object-cover" />
                    ) : (
                      <div class="w-8 h-8 flex items-center justify-center text-xs">YT</div>
                    )}
                  </div>
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
