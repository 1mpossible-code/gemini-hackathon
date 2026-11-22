import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// A deliberately small DOM double: rejects innerHTML and captures events, so
// provider text and stale requests cannot silently become rendered markup.
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.style = {}; this.events = {}; this.text = ''; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(' '); }
  set innerHTML(value) { throw new Error('Untrusted markup must not use innerHTML'); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ''; this.children = nodes; }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(type, handler) { this.events[type] = handler; }
  querySelectorAll(tag) { return this.children.flatMap(c => [...(c.tagName === tag ? [c] : []), ...c.querySelectorAll(tag)]); }
  get dataset() { return this._dataset ||= {}; }
}
globalThis.document = { createElement: tag => new Node(tag) };
const source = await readFile(new URL('../forge_research/web/validation.js', import.meta.url), 'utf8');
const ui = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function audit() {
  return {
    status: 'needs_review', revision: 2, checked_at: '2026-11-22T00:00:00Z', mode: 'offline', validation_id: 'audit-1',
    sources: [], scope: 'Structured facts only.', confidence_note: 'No calibrated probability of correctness.',
    input_sha256: 'abc', proof_note: 'Proofs depend on source inputs.', reasons: ['Unverified source'],
    proof: { status: 'failed', verified_count: 0, obligations: [{ title: 'Supply', status: 'failed', summary: 'Overvoltage', lean_theorem: 'theorem refuted' }] },
    authorship: [{ subject: 'Report', scope: 'Generated prose', status: 'completed', prediction: 'Human',
      fraction_ai: 0, fraction_ai_assisted: 0, fraction_human: 1, version: 'test', characters_scanned: 1000,
      windows: [{ text: '<script>not executable</script>', label: 'Human', confidence: 'High', ai_assistance_score: .1, start_index: 0, end_index: 30 }] }],
    spread: [{ subject: 'Report', field: 'authorship index', unit: 'index', n: 1, mean: .1, sample_stddev: null, interpretation: 'Not truth confidence' }],
  };
}

test('authorship label never hides failed proof and provider text stays literal', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => audit() });
  const target = new Node('section'), button = new Node('button'); button.textContent = 'Validate';
  await ui.runValidation({ url: '/api/projects/p/validate', body: { base_revision: 2 }, target, button });
  assert.match(target.textContent, /Evidence needs review/);
  assert.match(target.textContent, /FAILED · Supply/);
  assert.match(target.textContent, /Insufficient data/);
  const segment = target.querySelectorAll('button').find(b => b.attrs['aria-label']?.startsWith('Segment'));
  segment.events.click();
  assert.match(target.textContent, /<script>not executable<\/script>/);
  assert.equal(button.disabled, false);
  assert.equal(target.querySelectorAll('a').filter(a => a.download === '').length, 2);
});

test('discarding an audit prevents a late response from marking the next revision checked', async () => {
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const target = new Node('section'), button = new Node('button'); button.textContent = 'Validate';
  const pending = ui.runValidation({ url: '/api/projects/p/validate', target, button });
  ui.clearValidation(target);
  release({ ok: true, json: async () => audit() });
  await pending;
  assert.equal(target.hidden, true);
  assert.equal(target.children.length, 0);
});

test('live source graphic reflects actual reading and exclusion events', () => {
  const target = new Node('section');
  ui.renderSourceProgress(target, { event: 'round', round: 1, policy: { exclude_at_ai_fraction: .5, include_ai_assisted: false } });
  ui.renderSourceProgress(target, { event: 'reading', round: 1, url: 'https://manufacturer.test/doc.pdf', title: 'Manual', part_id: 'part' });
  assert.match(target.textContent, /reading/);
  assert.doesNotMatch(target.textContent, /accepted/);
  ui.renderSourceProgress(target, { event: 'decision', source: { part_id: 'part', document: { url: 'https://manufacturer.test/doc.pdf', title: 'Manual' },
    decision: 'excluded', reason: 'At the 50% cutoff', round: 1, ai_fraction: .5, ai_assisted_fraction: 0, metric: 'Original text', scans: [] } });
  const tile = target.querySelectorAll('button')[0]; tile.events.click();
  assert.match(target.textContent, /EXCLUDED/);
  assert.match(target.textContent, /50\.0%/);
});
