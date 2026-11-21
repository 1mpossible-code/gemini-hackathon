// Research tab: the research swarm (forge_research FastAPI app on :8000, proxied by
// Vite under /research, /static and /api) shown inside the studio. The iframe stays
// mounted so a running research stream survives switching tabs. When a run finishes,
// the app's "Engineer PCB" button posts {type:'forge:engineer', brief, parts} here and
// the studio generates a board for it.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { setStudio, useStudio } from '@/state/studio'

type Engineer = { type: 'forge:engineer'; brief: string; parts?: { name: string; role?: string }[] }

export function ResearchPane() {
  const mode = useStudio((s) => s.mode)
  const [up, setUp] = useState<boolean | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const d = e.data as Engineer
      if (e.origin !== location.origin || d?.type !== 'forge:engineer' || !d.brief) return
      const parts = (d.parts ?? []).map((p) => p.name).join(', ')
      setStudio({
        mode: 'engineer',
        scale: 'board',
        selected: null,
        device: null,
        pendingPrompt: parts ? `${d.brief} Build it around: ${parts}.` : d.brief,
      })
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [])

  // Only load the iframe once the tab is first opened and the server answers.
  useEffect(() => {
    if (mode !== 'research' || up) return
    let stop = false
    const check = () =>
      fetch('/api/session')
        .then((r) => !stop && setUp(r.ok))
        .catch(() => !stop && setUp(false))
    check()
    const id = setInterval(check, 3000)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [mode, up])

  return (
    <div className={mode === 'research' ? 'absolute inset-0 z-20 bg-background' : 'hidden'}>
      {up && <iframe title="FORGE research" src="/research/" onLoad={() => setLoaded(true)} className="size-full border-0" />}
      <AnimatePresence>
        {(!up || !loaded) && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 grid place-items-center bg-background">
            <div className="max-w-md text-center">
              <div className="label-mono">Research swarm</div>
              {up === false ? (
                <>
                  <p className="mt-2 text-sm">The research server is not running.</p>
                  <pre className="mt-3 rounded-lg border border-border bg-card px-3 py-2 text-left font-mono text-[11px] text-muted-foreground">
                    uv run --locked --python 3.12 python -m forge_research.studio
                  </pre>
                  <p className="mt-2 text-[11px] text-muted-foreground">Run it from the repository root. This tab connects when it answers on port 8000.</p>
                </>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">Connecting…</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
