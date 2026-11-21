// One app. This pane is the research studio (brief, swarm, workbench, 3D
// assembly). Engineer PCB posts forge:engineer and the shell swaps to the
// PCB studio without leaving the page. The iframe stays mounted so going
// back does not wipe the run.
import { useEffect } from 'react'
import { setStudio, useStudio } from '@/state/studio'

type Engineer = { type: 'forge:engineer'; brief: string; parts?: { name: string; role?: string }[] }

export function ResearchPane() {
  const mode = useStudio((s) => s.mode)

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const d = e.data as Engineer
      if (e.origin !== location.origin || d?.type !== 'forge:engineer' || !d.brief) return
      const parts = (d.parts ?? []).map((p) => p.name).filter(Boolean).join(', ')
      setStudio({
        mode: 'engineer',
        scale: 'system',
        selected: null,
        device: null,
        // /api/generate rejects prompts over 2000 characters.
        pendingPrompt: (parts ? `${d.brief} Build it around: ${parts}.` : d.brief).slice(0, 2000),
      })
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [])

  return (
    <iframe
      title="FORGE research and engineering studio"
      src={new URLSearchParams(location.search).get('run') === 'sample' ? '/research/?run=sample' : '/research/'}
      className={mode === 'research' ? 'fixed inset-0 z-40 h-dvh w-full border-0 bg-[#050505]' : 'hidden'}
    />
  )
}
