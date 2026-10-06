// Worker <-> agent-runner protocol. The runner receives only this bundle: no DB, no vault
// mount, no long-lived secrets. proxy.token is a short-lived per-run token.
export interface BundleChunk {
  key: string;
  kind: 'source' | 'document';
  documentId?: string; revisionId?: string; sourceVersionId?: string;
  path?: string; title: string; heading: string | null; start: number; end: number; page: number | null; text: string;
}
export interface BundleDoc { path: string; title: string; kind: string; documentId: string; revisionId: string; aliases: string[]; chunkKeys: string[]; links: string[] }
export interface JobBundle {
  index: { path: string; title: string; kind: string }[];
  docs: BundleDoc[];
  chunks: BundleChunk[];
  source?: { title: string; chunkKeys: string[]; totalChars: number };
}
export interface JobRequest {
  jobId: string;
  attemptId: string;
  skillId: string;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutS: number;
  maxOutputTokens: number;
  outputSchema: Record<string, unknown>;
  writable: boolean;
  proxy: { baseUrl: string; token: string };
  bundle: JobBundle;
}
export type RunnerEvent =
  | { type: 'started'; tools: string[]; model: string }
  | { type: 'progress'; message: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'text_delta'; text: string }
  | { type: 'proposal'; op: { op: 'create' | 'update'; path: string; content: string; rationale: string; sourceRefs: string[]; baseRevisionId?: string | null } }
  | { type: 'proposal_rejected'; path: string; reason: string }
  | { type: 'coverage'; readChunks: string[] }
  | { type: 'result'; structured: unknown; text: string; usage: Record<string, number>; costUsd: number | null; numTurns: number; subtype: string }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export const AGENT_WRITABLE_RE = /^wiki\/(sources|concepts|entities|synthesis)\/[^/]+\.md$/;
