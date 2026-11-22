import { createHash } from 'node:crypto'
import { isResearchReference, type ResearchContext, type ResearchEnvelope, type ResearchSnapshot } from '../src/ai/researchHandoff.ts'

/** Fetch only from the configured research service, never a browser-provided URL or bundle. */
export async function resolveResearchHandoff(reference: unknown, researchUrl: string, signal?: AbortSignal): Promise<ResearchContext> {
  if (!isResearchReference(reference)) throw new Error('Invalid research handoff reference')
  const response = await fetch(new URL(`/api/research/${reference.researchId}/engineering-handoff`, researchUrl), {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`Research handoff unavailable or blocked (${response.status}). Return to research.`)
  if (!response.body) throw new Error('Empty research handoff')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 4_000_000) throw new Error('Research handoff exceeds the supported size')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ResearchEnvelope
  if (envelope.schema_version !== 1 || typeof envelope.snapshot_json !== 'string'
    || envelope.bundle_sha256 !== reference.bundleSha256
    || createHash('sha256').update(envelope.snapshot_json).digest('hex') !== reference.bundleSha256) {
    throw new Error('Research handoff changed or is corrupt. Return to research.')
  }
  const snapshot = JSON.parse(envelope.snapshot_json) as ResearchSnapshot
  if (snapshot.research_id !== reference.researchId || typeof snapshot.brief !== 'string' || !snapshot.brief.trim()
    || !['evidence_backed', 'sample', 'exploratory'].includes(snapshot.kind) || !Array.isArray(snapshot.parts)
    || !Array.isArray(snapshot.evidence)) throw new Error('Invalid saved research snapshot')
  if (snapshot.kind === 'evidence_backed' && (!snapshot.device_spec || !snapshot.parts.length
    || snapshot.parts.some((p) => !snapshot.evidence.some((e) => e.part_id === p.id && e.design_ready)))) {
    throw new Error('Research snapshot lacks required component evidence')
  }
  if (['failed', 'error'].includes(snapshot.research_verification?.status ?? '')) throw new Error('Research proof obligations are blocked')
  return { envelope, snapshot }
}
