import { z } from 'zod';
import { AGENT_WRITABLE_RE, type JobRequest, type RunnerEvent } from '@sb/contracts';

/** Apply the same scope and proposal rules as the API runner before accepting CLI output. */
export function codexOutput(job: JobRequest, raw: unknown): RunnerEvent[] {
  const proposal = z.object({ op: z.enum(['create', 'update']), path: z.string().min(1).max(300), content: z.string().min(1).max(150000), rationale: z.string().max(1000), sourceRefs: z.array(z.string()).max(50) });
  const output = z.object({ structured: z.fromJSONSchema(job.outputSchema), proposals: z.array(proposal).max(30), readChunks: z.array(z.string()) }).parse(raw);
  const keys = new Set(job.bundle.chunks.map(c => c.key));
  const docs = new Map(job.bundle.docs.map(d => [d.path, d]));
  const events: RunnerEvent[] = [];
  for (const op of output.proposals) {
    const existing = docs.get(op.path);
    const reason = !job.writable ? 'read-only run' : op.path.includes('..') || !AGENT_WRITABLE_RE.test(op.path) ? 'invalid proposal path' : op.op === 'update' && !existing ? 'page outside scope' : op.op === 'create' && existing ? 'page already exists' : op.sourceRefs.some(k => !keys.has(k)) ? 'unknown source reference' : null;
    if (reason) events.push({ type: 'proposal_rejected', path: op.path, reason });
    else events.push({ type: 'proposal', op: { ...op, baseRevisionId: existing?.revisionId ?? null } });
  }
  events.push({ type: 'coverage', readChunks: [...new Set(output.readChunks.filter(k => keys.has(k)))] });
  events.push({ type: 'result', structured: output.structured, text: '', usage: {}, costUsd: null, numTurns: 1, subtype: 'success' });
  return events;
}
