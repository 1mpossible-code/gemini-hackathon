// One app. This pane is the research studio (brief, swarm, workbench, 3D
// assembly). Engineer PCB posts forge:engineer and the shell swaps to the
// PCB studio without leaving the page. The iframe stays mounted so going
// back does not wipe the run.
import { useEffect, useRef, useState } from 'react'
import { setStudio, useStudio } from '@/state/studio'
import { activateResearch, isResearchReference, loadResearch, researchPrompt, type ResearchContext } from '@/ai/researchHandoff'

export function ResearchPane() {
  const mode = useStudio((s) => s.mode)
  const board = useStudio((s) => s.board)
  const iframe = useRef<HTMLIFrameElement>(null)
  const [handoff, setHandoff] = useState<ResearchContext | null>(null)
  const [handoffError, setHandoffError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let controller: AbortController | null = null
    const receive = async (reference: unknown) => {
      controller?.abort()
      setHandoff(null)
      if (!isResearchReference(reference)) { setLoading(false); setHandoffError('Invalid research handoff. Return to research.'); return }
      const current = controller = new AbortController()
      setLoading(true)
      setHandoffError(null)
      try {
        const context = await loadResearch(reference, current.signal)
        if (current.signal.aborted) return
        const prompt = researchPrompt(context.snapshot)
        activateResearch(prompt, reference)
        setHandoff(context)
        setStudio({ mode: 'engineer', scale: 'system', selected: null, device: null, pendingPrompt: prompt })
        const url = new URL(location.href)
        url.searchParams.delete('research')
        url.searchParams.delete('researchHash')
        history.replaceState(null, '', url)
      } catch (error) {
        if (!current.signal.aborted) setHandoffError(error instanceof Error ? error.message : 'Research handoff failed')
      } finally { if (!current.signal.aborted) setLoading(false) }
    }
    const on = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== iframe.current?.contentWindow || e.data?.type !== 'forge:engineer') return
      void receive(e.data.reference)
    }
    window.addEventListener('message', on)
    const query = new URLSearchParams(location.search)
    if (query.has('research')) void receive({ researchId: query.get('research'), bundleSha256: query.get('researchHash') })
    return () => { controller?.abort(); window.removeEventListener('message', on) }
  }, [])

  return (
    <>
    <iframe
      ref={iframe}
      title="FORGE research and engineering studio"
      src={new URLSearchParams(location.search).get('run') === 'sample' ? '/research/?run=sample' : '/research/'}
      className={mode === 'research' ? 'fixed inset-0 z-40 h-dvh w-full border-0 bg-[#050505]' : 'hidden'}
    />
    {(loading || handoffError) && <p role={handoffError ? 'alert' : 'status'} className="fixed bottom-16 right-4 z-50 max-w-md rounded-lg border border-white/20 bg-black p-3 text-sm text-white">
      {handoffError || 'Loading saved research evidence…'}
    </p>}
    {mode === 'engineer' && handoff && board.researchHandoff?.envelope.bundle_sha256 === handoff.envelope.bundle_sha256 && <details className="fixed bottom-16 left-4 z-40 max-w-sm rounded-lg border border-white/20 bg-black/90 p-3 text-xs text-white">
      <summary>Research handoff · {handoff.snapshot.kind === 'evidence_backed' ? 'source evidence attached' : 'unverified inputs'}</summary>
      <p className="my-2">{handoff.snapshot.scope}</p>
      <p>{handoff.snapshot.parts.length} selected parts · Research proofs: {handoff.snapshot.research_verification?.status ?? 'not run'}</p>
      <a className="mt-2 block underline" href={`/api/research/${handoff.snapshot.research_id}/engineering-handoff`} download>Download research bundle</a>
    </details>}
    {mode === 'research' && (
      <button
        type="button"
        onClick={() => setStudio({ mode: 'engineer' })}
        className="fixed bottom-4 right-4 z-50 rounded-lg border border-white/20 bg-black/80 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-white backdrop-blur-md hover:bg-white hover:text-black"
      >
        PCB Studio →
      </button>
    )}
    </>
  )
}
