import { z } from 'zod';

// ---- Error envelope -------------------------------------------------------
export interface ApiError { code: string; message: string; requestId: string; retryable: boolean; details?: unknown }

// ---- Enums ----------------------------------------------------------------
export const Sensitivity = z.enum(['public', 'private_model', 'no_external']);
export const Role = z.enum(['owner', 'admin', 'member', 'viewer']);
export const SourceStatus = z.enum(['uploaded', 'queued', 'extracting', 'ready_for_analysis', 'analyzing', 'awaiting_review', 'applied', 'extraction_failed', 'needs_ocr', 'analysis_failed', 'canceled']);
export const RunStatus = z.enum(['queued', 'running', 'waiting_for_review', 'succeeded', 'failed', 'cancel_requested', 'canceled', 'interrupted']);

// ---- Auth -----------------------------------------------------------------
export const LoginBody = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(256),
  totp: z.string().regex(/^\d{6}$/).optional(),
  recoveryCode: z.string().max(40).optional(),
});
export const StepUpBody = z.object({ password: z.string().min(1).max(256), totp: z.string().regex(/^\d{6}$/).optional() });
export const ChangePasswordBody = z.object({ current: z.string().min(1).max(256), next: z.string().min(12).max(256) });
export const TotpConfirmBody = z.object({ code: z.string().regex(/^\d{6}$/) });
export const PreferencesBody = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  locale: z.enum(['fa', 'en']).optional(),
  timezone: z.string().min(1).max(64).optional(),
  calendar: z.enum(['persian', 'gregorian']).optional(),
  digits: z.enum(['fa', 'latn']).optional(),
  displayName: z.string().min(1).max(100).optional(),
});

// ---- Workspaces & users ---------------------------------------------------
export const CreateWorkspaceBody = z.object({ name: z.string().min(1).max(100), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/) });
export const CreateUserBody = z.object({ email: z.string().email().max(320), displayName: z.string().min(1).max(100), password: z.string().min(12).max(256), role: z.enum(['admin', 'member', 'viewer']) });

// ---- Sources ---------------------------------------------------------------
export const CreateTextSourceBody = z.object({
  kind: z.enum(['text', 'markdown', 'transcript']),
  title: z.string().min(1).max(200),
  text: z.string().min(1).max(2_000_000),
  projectId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().min(1).max(60)).max(20).default([]),
  sensitivity: Sensitivity.default('private_model'),
  idempotencyKey: z.string().min(8).max(100).optional(),
  autoAnalyze: z.boolean().default(false),
});
export const CreateUrlSourceBody = z.object({
  url: z.string().url().max(2000),
  title: z.string().max(200).optional(),
  projectId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().min(1).max(60)).max(20).default([]),
  sensitivity: Sensitivity.default('private_model'),
  idempotencyKey: z.string().min(8).max(100).optional(),
  autoAnalyze: z.boolean().default(false),
});
export const UpdateSourceBody = z.object({
  title: z.string().min(1).max(200).optional(),
  tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  sensitivity: Sensitivity.optional(),
  projectId: z.string().uuid().nullable().optional(),
});
export const ReplacementTextBody = z.object({ text: z.string().min(1).max(2_000_000), note: z.string().max(300).optional() });

// ---- Documents --------------------------------------------------------------
export const SaveDocumentBody = z.object({ content: z.string().max(1_000_000), baseRevisionId: z.string().uuid() });
export const CreateNoteBody = z.object({ title: z.string().min(1).max(200), content: z.string().max(1_000_000).default(''), tags: z.array(z.string().max(60)).max(20).default([]), folder: z.enum(['notes', 'projects', 'output']).default('notes') });
export const UpdateDocumentMetaBody = z.object({ sensitivity: Sensitivity });

// ---- ChangeSets ---------------------------------------------------------------
export const ApplyChangeSetBody = z.object({ accepted: z.union([z.literal('all'), z.array(z.number().int().positive()).max(200)]), applyKey: z.string().min(8).max(100) });
export const EditItemBody = z.object({ content: z.string().max(200_000) });

// ---- Ask ------------------------------------------------------------------------
export const AskScope = z.object({
  type: z.enum(['workspace', 'project', 'documents', 'sources', 'tag']),
  projectId: z.string().uuid().optional(),
  documentIds: z.array(z.string().uuid()).max(100).optional(),
  sourceIds: z.array(z.string().uuid()).max(100).optional(),
  tag: z.string().max(60).optional(),
});
export const AskBody = z.object({ question: z.string().min(2).max(2000), conversationId: z.string().uuid().optional(), scope: AskScope.default({ type: 'workspace' }), idempotencyKey: z.string().min(8).max(100).optional() });

// ---- Projects -----------------------------------------------------------------------
export const ProjectBody = z.object({ title: z.string().min(1).max(200), goal: z.string().max(1000).default(''), description: z.string().max(2000).default(''), status: z.enum(['active', 'paused', 'done', 'archived']).default('active'), color: z.enum(['blue', 'purple', 'teal', 'green', 'orange']).default('blue') });
export const TaskBody = z.object({ text: z.string().min(1).max(300), section: z.enum(['inputs', 'process', 'outputs', 'feedback']).default('process'), done: z.boolean().default(false) });

// ---- Studio --------------------------------------------------------------------------
export const OutputBriefBody = z.object({
  title: z.string().min(1).max(200), template: z.enum(['report', 'decision', 'article']),
  goal: z.string().max(1000).default(''), audience: z.string().max(200).default(''), language: z.enum(['fa', 'en']).default('fa'),
  length: z.enum(['short', 'medium', 'long']).default('medium'), documentIds: z.array(z.string().uuid()).min(1).max(40), projectId: z.string().uuid().nullable().optional(),
});
export const OutputVersionBody = z.object({ content: z.string().max(500_000), outline: z.array(z.string().max(300)).max(50).optional() });

// ---- Admin: Claude API -------------------------------------------------------------
export const StoreApiKeyBody = z.object({ label: z.string().max(100).default('Anthropic API'), apiKey: z.string().min(20).max(400) });
export const ApiSettingsBody = z.object({
  model: z.string().min(1).max(100).optional(),
  allowedModels: z.array(z.string().max(100)).max(20).optional(),
  perRunBudgetUsd: z.number().min(0.01).max(50).optional(),
  dailyBudgetUsd: z.number().min(0.01).max(500).optional(),
  timeoutS: z.number().int().min(30).max(3600).optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
  maxOutputTokens: z.number().int().min(256).max(64000).optional(),
  activeRunPolicy: z.enum(['let_finish', 'cancel']).optional(),
});
export const DisconnectBody = z.object({ cancelActiveRuns: z.boolean() });

// ---- Schedules ------------------------------------------------------------------------
export const ScheduleBody = z.object({
  name: z.string().min(1).max(100), skillId: z.enum(['lint', 'metrics', 'graph', 'ingest']), cron: z.string().min(9).max(100),
  timezone: z.string().min(1).max(64), enabled: z.boolean().default(true), missedPolicy: z.enum(['skip', 'run_once']).default('skip'),
  budgetUsd: z.number().min(0).max(50).nullable().optional(),
});
