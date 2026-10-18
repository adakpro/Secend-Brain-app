import { describe, it, expect } from 'vitest';
import type { JobRequest } from '@sb/contracts';
import { codexOutput } from '../../src/codex-output';
const job = {
  outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, writable: true,
  bundle: { index: [], chunks: [{ key: 'C1', text: 'source' }], docs: [{ path: 'wiki/concepts/existing.md', revisionId: 'revision-1' }] },
} as unknown as JobRequest;
const op = { op: 'update', path: 'wiki/concepts/existing.md', content: 'body', rationale: 'why', sourceRefs: ['C1'] };
const output = (proposals: unknown[] = [op]) => ({ structured: { answer: 'answer [C1]' }, proposals, readChunks: ['C1', 'invented', 'C1'] });
describe('Codex output trust boundary', () => {
  it('uses the trusted revision and filters coverage to the supplied passages', () => {
    const events = codexOutput(job, output());
    expect(events[0]).toMatchObject({ type: 'proposal', op: { baseRevisionId: 'revision-1' } });
    expect(events[1]).toEqual({ type: 'coverage', readChunks: ['C1'] });
  });
  it.each([
    { ...op, path: '../../config' }, { ...op, path: 'wiki/concepts/outside.md' }, { ...op, sourceRefs: ['invented'] }, { ...op, op: 'create' },
  ])('rejects unauthorized proposals: %j', bad => {
    expect(codexOutput(job, output([bad]))[0].type).toBe('proposal_rejected');
  });
  it('rejects proposals from a read-only task', () => {
    expect(codexOutput({ ...job, writable: false }, output())[0]).toMatchObject({ type: 'proposal_rejected', reason: 'read-only run' });
  });
  it('rejects malformed reports instead of recording success', () => {
    expect(() => codexOutput(job, { ...output(), structured: { answer: 42 } })).toThrow();
    expect(() => codexOutput(job, { ...output(), proposals: [ { ...op, content: '' } ] })).toThrow();
  });
});
