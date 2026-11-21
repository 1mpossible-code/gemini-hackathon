import { Component, Suspense, type ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { Bounds, Center, OrbitControls, useGLTF } from '@react-three/drei'
import { setStudio } from '@/state/studio'

type Result = { id?: string; error?: string; status?: string; progress?: number; modelUrl?: string; configured?: boolean }
async function api(path: string, options?: RequestInit): Promise<Result> {
  const res = await fetch(`/api/concept${path}`, options)
  const data = await res.json() as Result
  if (!res.ok) throw new Error(data.error || 'The request failed.')
  return data
}
let runId = 0
export async function generateConcept(prompt: string) {
  const run = ++runId
  const update = (patch: Parameters<typeof setStudio>[0]) => { if (run === runId) setStudio(patch) }
  update({ conceptUrl: null, conceptStatus: 'Checking 3D generation…', conceptError: null })
  const waitFor = async (id: string, label: string) => {
    for (let i = 0; i < 240; i++) {
      if (run !== runId) throw new Error('Superseded')
      const data = await api(`/${id}`)
      if (data.status === 'SUCCEEDED' && data.modelUrl) return data.modelUrl
      if (data.status === 'FAILED' || data.status === 'CANCELED' || data.status === 'EXPIRED') throw new Error(data.error || `Generation ${data.status.toLowerCase()}.`)
      update({ conceptStatus: `${label} · ${Math.max(0, Math.min(100, data.progress ?? 0))}%` })
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
    throw new Error('Generation timed out. Try again later.')
  }
  try {
    const status = await api('/status')
    if (!status.configured) throw new Error('Set MESHY_API_KEY in pcb-studio/.env.local and restart FORGE to generate the whole-object 3D concept.')
    const created = await api('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: prompt.slice(0, 700) }) })
    if (!created.id) throw new Error('The provider did not return a task ID.')
    const preview = await waitFor(created.id, 'Building 3D shape')
    update({ conceptUrl: preview, conceptStatus: 'Shape ready · adding textures' })
    try {
      const refined = await api(`/${created.id}/refine`, { method: 'POST' })
      if (!refined.id) throw new Error('The provider did not return a texture task ID.')
      const result = await waitFor(refined.id, 'Adding textures')
      update({ conceptUrl: result, conceptStatus: '3D concept ready' })
    } catch (error) {
      update({ conceptStatus: 'Shape preview ready', conceptError: `Texturing failed. ${error instanceof Error ? error.message : ''}` })
    }
  } catch (error) { update({ conceptStatus: '', conceptError: error instanceof Error ? error.message : '3D generation failed.' }) }
}
function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url)
  return <Bounds fit clip observe margin={1.25}><Center><primitive object={scene} /></Center></Bounds>
}
class ViewerError extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <div className="p-8 text-sm text-red-300">Could not display this model. You can still download the GLB.</div> : this.props.children }
}
export function ConceptScene({ url }: { url: string }) {
  return <ViewerError key={url}><Canvas camera={{ position: [4, 3, 5], fov: 40 }} dpr={[1, 2]}><color attach="background" args={['#0c0d0f']} /><ambientLight intensity={1.4} /><directionalLight position={[5, 8, 5]} intensity={3} /><directionalLight position={[-4, 2, -3]} intensity={1.2} /><Suspense fallback={null}><Model url={url}/></Suspense><OrbitControls makeDefault /></Canvas></ViewerError>
}
