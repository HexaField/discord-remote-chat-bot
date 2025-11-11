// Lightweight helper for opening Server-Sent Events progress streams
export function openProgressEventSource(
  videoId: string | null | undefined,
  universe: string | null | undefined,
  onMessage?: (obj: any) => void,
  onError?: () => void
): EventSource | null {
  if (!videoId) return null
  try {
    const qs = universe ? `?universe=${encodeURIComponent(universe)}` : ''
    const url = `/api/videos/${videoId}/progress/stream${qs}`
    const es = new EventSource(url)
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data)
        onMessage && onMessage(parsed)
      } catch (e) {
        // ignore parse errors
      }
    }
    es.onerror = () => {
      onError && onError()
    }
    return es
  } catch (e) {
    return null
  }
}

// Open a temporary EventSource that will auto-close after ttlMs (default 10min).
export function openTemporaryProgressEventSource(
  videoId: string | null | undefined,
  universe: string | null | undefined,
  onMessage?: (obj: any) => void,
  ttlMs = 10 * 60 * 1000
): EventSource | null {
  const es = openProgressEventSource(videoId, universe, onMessage, undefined)
  if (!es) return null
  const t = setTimeout(() => {
    try {
      es.close()
    } catch (e) {}
    try {
      clearTimeout(t)
    } catch (e) {}
  }, ttlMs)
  return es
}
