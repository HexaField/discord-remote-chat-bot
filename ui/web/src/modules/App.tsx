import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import GraphView from './GraphView'
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

  // Universe combined graph state: when the special "UNIVERSE" list item is selected
  const UNIVERSE_ID = 'UNIVERSE'
  const [universeData, setUniverseData] = createSignal<{ nodes: any[]; links: any[] } | null>(null)
  const [universeLoading, setUniverseLoading] = createSignal(false)

  async function loadUniverse() {
    setUniverseLoading(true)
    try {
      const items = await fetch('/api/videos').then((r) => r.json())
      // fetch all graphs in parallel
      const fetches = items.map(async (it: any) => {
        try {
          const r = await fetch(`/api/videos/${it.id}/graph`)
          if (!r.ok) return null
          const g = await r.json()
          return { id: it.id, graph: g }
        } catch (e) {
          return null
        }
      })
      const results = await Promise.all(fetches)

      // Deduplicate nodes by label+type and deduplicate identical links
      const nodeKeyToNode = new Map<string, any>() // key -> node obj
      const usedIds = new Set<string>()
      const linksOut: any[] = []
      const linkKeys = new Set<string>()

      for (const res of results) {
        if (!res || !res.graph) continue
        const vid = res.id
        const g = res.graph

        // map original id -> unified id for this graph
        const originalToUnified = new Map<string, string>()

        // process nodes
        for (const n of g.nodes || []) {
          // support string nodes or object nodes
          const label = (typeof n === 'string' ? n : (n.label ?? n.id ?? String(n))) || ''
          const type = (typeof n === 'object' && n ? n.type : undefined) || ''
          const key = `${label}::${type}`
          if (nodeKeyToNode.has(key)) {
            const existing = nodeKeyToNode.get(key)
            // record source id set
            if (!existing.__sourceIds) existing.__sourceIds = []
            if (!existing.__sourceIds.includes(vid)) existing.__sourceIds.push(vid)
            // map original id to existing unified id
            const unifiedId = existing.id
            if (typeof n === 'object' && n && n.id) originalToUnified.set(n.id, unifiedId)
          } else {
            // generate a safe id from label
            const base =
              String(label || 'node')
                .replace(/[^a-zA-Z0-9-_]/g, '-')
                .slice(0, 60) || `node-${Date.now()}`
            let uid = base
            let suffix = 1
            while (usedIds.has(uid)) {
              uid = `${base}-${suffix++}`
            }
            usedIds.add(uid)
            const nodeObj: any = { id: uid, label, type: type || undefined, __sourceIds: [vid] }
            nodeKeyToNode.set(key, nodeObj)
            if (typeof n === 'object' && n && n.id) originalToUnified.set(n.id, uid)
          }
        }

        // process links, mapping to unified ids
        for (const l of g.links || []) {
          const srcOrig = l.source
          const tgtOrig = l.target
          // try to resolve original ids to unified ids
          const srcUnified =
            originalToUnified.get(srcOrig) ??
            (() => {
              // fallback: try to resolve by label on the global map
              const srcLabel = (g.nodes || []).find(
                (nn: any) => (nn as any).id === srcOrig || (nn as any).label === srcOrig
              )
              if (srcLabel) {
                const lbl = srcLabel.label ?? srcLabel.id
                const t = srcLabel.type ?? ''
                const k = `${lbl}::${t}`
                return nodeKeyToNode.get(k)?.id
              }
              return undefined
            })()
          const tgtUnified =
            originalToUnified.get(tgtOrig) ??
            (() => {
              const tgtLabel = (g.nodes || []).find(
                (nn: any) => (nn as any).id === tgtOrig || (nn as any).label === tgtOrig
              )
              if (tgtLabel) {
                const lbl = tgtLabel.label ?? tgtLabel.id
                const t = tgtLabel.type ?? ''
                const k = `${lbl}::${t}`
                return nodeKeyToNode.get(k)?.id
              }
              return undefined
            })()
          if (!srcUnified || !tgtUnified) continue
          const linkKey = `${srcUnified}::${tgtUnified}::${String(l.label || '')}`
          if (linkKeys.has(linkKey)) continue
          linkKeys.add(linkKey)
          linksOut.push({ source: srcUnified, target: tgtUnified, label: l.label })
        }
      }

      const nodesOut = Array.from(nodeKeyToNode.values())
      setUniverseData({ nodes: nodesOut, links: linksOut })
    } finally {
      setUniverseLoading(false)
    }
  }

  // build a simple color palette map for source videos (used only by Universe view)
  function buildSourcePalette() {
    const cols = [
      '#e6194b',
      '#3cb44b',
      '#ffe119',
      '#4363d8',
      '#f58231',
      '#911eb4',
      '#46f0f0',
      '#f032e6',
      '#bcf60c',
      '#fabebe',
      '#008080',
      '#e6beff',
      '#9a6324',
      '#fffac8'
    ]
    const map: Record<string, string> = {}
    const items = videos()
    for (let i = 0; i < items.length; i++) map[items[i].id] = cols[i % cols.length]
    return map
  }

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

  // when Universe is selected, load/refresh the combined graph
  createEffect(() => {
    if (selected() === UNIVERSE_ID) {
      loadUniverse()
    } else {
      // clear cached universe data when leaving view
      setUniverseData(null)
    }
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
            {/* Universe combined graph entry at top of the list */}
            <button
              class={`w-full text-left p-3 hover:bg-gray-50 flex items-center gap-2 ${selected() === UNIVERSE_ID ? 'bg-gray-100' : ''}`}
              onClick={() => setSelected((p) => (p === UNIVERSE_ID ? null : UNIVERSE_ID))}
            >
              <div class="w-8 h-8 bg-gray-200 rounded overflow-hidden flex items-center justify-center">🌐</div>
              {!collapsed() && (
                <div class="truncate">
                  <div class="font-semibold truncate">Universe</div>
                  <div class="text-xs text-gray-500 truncate">All videos combined</div>
                </div>
              )}
            </button>
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
                {selected() === UNIVERSE_ID ? (
                  <div class="h-full">
                    <h2 class="font-semibold mb-2">Universe Graph</h2>
                    <div class="h-full border rounded bg-white">
                      <GraphView data={universeData()} showSourceOutlines={true} sourcePalette={buildSourcePalette()} />
                    </div>
                  </div>
                ) : (
                  <VideoCard id={selected()!} />
                )}
              </div>
            </Show>
          </div>
        </div>
      </main>
    </div>
  )
}
