import { createEffect, createSignal, onCleanup } from 'solid-js'
import { openProgressEventSource } from './progressStream'

export type ProgressObj = { status?: string; updated?: number } | null

// videoIdAccessor and universeAccessor are accessors so the effect re-runs
export function useVideoProgress(
  videoIdAccessor: () => string | null | undefined,
  universeAccessor?: () => string | null | undefined
) {
  const [videoProgress, setVideoProgress] = createSignal<ProgressObj>(null)
  const [checkingVideoProgress, setCheckingVideoProgress] = createSignal(false)
  let progressES: EventSource | null = null

  createEffect(() => {
    const vid = videoIdAccessor && videoIdAccessor()
    const universe = universeAccessor && universeAccessor()
    if (!vid) {
      setVideoProgress(null)
      setCheckingVideoProgress(false)
      return
    }
    setCheckingVideoProgress(true)
    const es = openProgressEventSource(
      vid,
      universe as any,
      (j: any) => {
        setVideoProgress(j)
        setCheckingVideoProgress(false)
      },
      () => setCheckingVideoProgress(false)
    )
    progressES = es

    // fallback: if EventSource couldn't be opened, do a single fetch
    if (!es) {
      ;(async () => {
        try {
          const u = universe ? `?universe=${encodeURIComponent(universe)}` : ''
          const r = await fetch(`/api/videos/${vid}/progress${u}`)
          if (!r.ok) {
            setVideoProgress(null)
            return
          }
          const j = await r.json()
          setVideoProgress(j)
        } catch (err) {
          setVideoProgress(null)
        } finally {
          setCheckingVideoProgress(false)
        }
      })()
    }

    onCleanup(() => {
      try {
        progressES && progressES.close()
      } catch (e) {}
      progressES = null
    })
  })

  return { videoProgress, setVideoProgress, checkingVideoProgress, getProgressES: () => progressES }
}

export default useVideoProgress
