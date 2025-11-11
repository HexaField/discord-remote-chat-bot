import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import GraphView from './GraphView'
import VideoCard from './VideoCard'

export type VideoItem = { id: string; title?: string; thumbnail?: string }

export default function App() {
  const [videos, setVideos] = createSignal<VideoItem[]>([])
  const [selected, setSelected] = createSignal<string | null>(null)
  const [hoveredVideo, setHoveredVideo] = createSignal<string | null>(null)
  const [universes, setUniverses] = createSignal<string[]>([])
  const [selectedUniverse, setSelectedUniverse] = createSignal<string>('default')

  // load universes and videos for the selected universe
  createEffect(() => {
    // load universes
    fetch('/api/universes')
      .then((r) => r.json())
      .then((list) => {
        if (Array.isArray(list) && list.length) {
          setUniverses(list)
          // if current selectedUniverse not in list, pick first
          if (!list.includes(selectedUniverse())) setSelectedUniverse(list[0])
        } else {
          // ensure at least 'default' exists as UI-friendly option
          setUniverses(['default'])
          if (!selectedUniverse()) setSelectedUniverse('default')
        }
      })
      .catch((err) => {
        console.error('Failed to load universes', err)
        setUniverses(['default'])
      })

    // load videos for selected universe
    const u = selectedUniverse()
    fetch(`/api/videos${u ? `?universe=${encodeURIComponent(u)}` : ''}`)
      .then((r) => r.json())
      .then(setVideos)
      .catch((err) => console.error('Failed to load videos', err))
  })

  // helper to refresh videos list from server
  async function refreshVideos() {
    try {
      const u = selectedUniverse()
      const r = await fetch(`/api/videos${u ? `?universe=${encodeURIComponent(u)}` : ''}`)
      if (r.ok) setVideos(await r.json())
    } catch (e) {
      console.error('Failed to refresh videos', e)
    }
  }

  // File input ref and upload handler for the "Add Video +" button
  let fileInput: HTMLInputElement | undefined
  async function handleFilesUpload(files: FileList | null) {
    if (!files || files.length === 0) return
    const fd = new FormData()
    for (let i = 0; i < files.length; i++) fd.append('files', files[i])
    // include selected universe
    fd.append('universe', selectedUniverse())
    try {
      await fetch(`/api/videos/import`, { method: 'POST', body: fd })
      await refreshVideos()
    } catch (e) {
      console.error('Upload failed', e)
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

    // read video & universe from search params on mount
    try {
      const params = new URLSearchParams(window.location.search)
      const v = params.get('v')
      const u = params.get('u')
      if (v) setSelected(v)
      if (u) setSelectedUniverse(u)
    } catch (e) {}

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
  const [videoGraphExists, setVideoGraphExists] = createSignal<boolean | null>(null)
  const [videoGraphLoading, setVideoGraphLoading] = createSignal(false)

  async function loadUniverse() {
    setUniverseLoading(true)
    try {
      const u = selectedUniverse()
      const items = await fetch(`/api/videos${u ? `?universe=${encodeURIComponent(u)}` : ''}`).then((r) => r.json())
      // fetch all graphs in parallel
      const fetches = items.map(async (it: any) => {
        try {
          const r = await fetch(`/api/videos/${it.id}/graph${u ? `?universe=${encodeURIComponent(u)}` : ''}`)
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
    const u = selectedUniverse()
    const params = new URLSearchParams(window.location.search)
    const curV = params.get('v')
    const curU = params.get('u')
    if (v === curV && u === curU) return
    if (v) params.set('v', v)
    else params.delete('v')
    if (u) params.set('u', u)
    else params.delete('u')
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

  // When a specific video is selected, check whether a graph exists for it so
  // the UI can show a helpful "No Graph" message before rendering VideoCard.
  createEffect(() => {
    const id = selected()
    if (!id || id === UNIVERSE_ID) {
      setVideoGraphExists(null)
      setVideoGraphLoading(false)
      return
    }
    setVideoGraphLoading(true)
    setVideoGraphExists(null)
    ;(async () => {
      try {
        const u = selectedUniverse()
        const r = await fetch(`/api/videos/${id}/graph${u ? `?universe=${encodeURIComponent(u)}` : ''}`)
        if (!r.ok) {
          setVideoGraphExists(false)
          return
        }
        const j = await r.json()
        const hasNodes = Array.isArray(j.nodes) && j.nodes.length > 0
        const hasLinks = Array.isArray(j.links) && j.links.length > 0
        setVideoGraphExists(hasNodes || hasLinks)
      } catch (e) {
        setVideoGraphExists(false)
      } finally {
        setVideoGraphLoading(false)
      }
    })()
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
                // include selected universe in the upload
                fd.append('universe', selectedUniverse())
                await fetch(`/api/videos/import`, { method: 'POST', body: fd })
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
              await fetch(`/api/videos/import?universe=${encodeURIComponent(selectedUniverse())}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, universe: selectedUniverse() })
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
              {!collapsed() && (
                <div class="flex items-center gap-2">
                  <span class="font-semibold">Videos</span>
                  <select
                    class="text-sm border rounded px-2 py-0.5"
                    value={selectedUniverse()}
                    onInput={(e: any) => setSelectedUniverse(e.target.value)}
                  >
                    <For each={universes()}>{(u) => <option value={u}>{u}</option>}</For>
                  </select>
                  <button
                    class="text-xs px-2 py-0.5 border rounded hover:bg-gray-50"
                    onClick={async () => {
                      const name = window.prompt('Create universe (name)')
                      if (!name) return
                      try {
                        const r = await fetch('/api/universes', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ name })
                        })
                        if (r.ok) {
                          // refresh universes
                          const list = await fetch('/api/universes').then((r) => r.json())
                          setUniverses(list)
                          setSelectedUniverse(name.replace(/[^a-zA-Z0-9-_]/g, '-'))
                          await refreshVideos()
                        }
                      } catch (e) {
                        console.error('Create universe failed', e)
                      }
                    }}
                  >
                    +
                  </button>
                </div>
              )}
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
                <div
                  class={`w-full text-left p-0 hover:bg-gray-50 flex items-center gap-2 overflow-hidden ${selected() === v.id ? 'bg-gray-100' : ''}`}
                  onMouseEnter={() => setHoveredVideo(v.id)}
                  onMouseLeave={() => setHoveredVideo(null)}
                >
                  <button
                    class="flex-1 text-left p-3 flex items-center gap-2 min-w-0"
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
                      <div class="truncate min-w-0">
                        <div class="font-semibold truncate">{v.title ?? v.id}</div>
                        <div class="text-xs text-gray-500 truncate">{v.id}</div>
                      </div>
                    )}
                  </button>

                  {/* Delete button shown on hover */}
                  <div class="pr-2 pl-1">
                    <Show when={hoveredVideo() === v.id}>
                      <button
                        class="w-7 h-7 flex items-center justify-center rounded-full bg-red-600 text-white text-xs hover:bg-red-700"
                        onClick={async (e) => {
                          try {
                            e.stopPropagation()
                            const ok = window.confirm('Are you sure you want to delete this video and all artifacts?')
                            if (!ok) return
                            const u = selectedUniverse()
                            const res = await fetch(
                              `/api/videos/${encodeURIComponent(v.id)}${u ? `?universe=${encodeURIComponent(u)}` : ''}`,
                              { method: 'DELETE' }
                            )
                            if (!res.ok) {
                              const body = await res.json().catch(() => null)
                              window.alert('Delete failed: ' + (body?.error || res.statusText))
                              return
                            }
                            await refreshVideos()
                            if (selected() === v.id) setSelected(null)
                          } catch (err) {
                            console.error('Delete failed', err)
                            window.alert('Delete failed')
                          }
                        }}
                        title="Delete video"
                      >
                        ×
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>

          {/* Add Video button and hidden file input */}
          <div class="p-2 border-t flex items-center justify-center">
            <input
              ref={(el) => (fileInput = el)}
              type="file"
              multiple
              accept="audio/*,video/*,.vtt,.txt"
              class="hidden"
              onChange={(e) => handleFilesUpload((e.target as HTMLInputElement).files)}
            />
            <button
              class="w-full text-sm py-2 px-3 bg-white border rounded hover:bg-gray-50"
              onClick={() => fileInput && fileInput.click()}
            >
              Add Video +
            </button>
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
                ) : // Per-video view: show helpful states when graph is missing or loading
                videoGraphLoading() ? (
                  <div class="h-full border rounded bg-white flex items-center justify-center text-gray-500">
                    Loading…
                  </div>
                ) : videoGraphExists() === false ? (
                  <div class="h-full border rounded bg-white flex items-center justify-center text-gray-500">
                    No Graph
                  </div>
                ) : (
                  <VideoCard id={selected()!} universe={selectedUniverse()} />
                )}
              </div>
            </Show>
          </div>
        </div>
      </main>
    </div>
  )
}
