// Ordered, append-only migrations. Never edit an applied migration; add a new one.
export interface Migration { version: number; name: string; sql: string }

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: /* sql */ `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE app_meta (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  is_installation_owner boolean NOT NULL DEFAULT false,
  totp_secret_enc bytea,
  totp_key_version text,
  totp_enabled boolean NOT NULL DEFAULT false,
  totp_last_step bigint,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lower CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_uq ON users(email);
CREATE UNIQUE INDEX users_single_owner ON users(is_installation_owner) WHERE is_installation_owner;

CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  idle_timeout_s integer NOT NULL,
  step_up_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  ip text,
  user_agent text
);
CREATE INDEX sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY,
  bucket text NOT NULL,
  success boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_bucket_at ON login_attempts(bucket, at DESC);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name text NOT NULL,
  is_demo boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
  locale text NOT NULL DEFAULT 'fa' CHECK (locale IN ('fa','en')),
  timezone text NOT NULL DEFAULT 'Asia/Tehran',
  calendar text NOT NULL DEFAULT 'persian' CHECK (calendar IN ('persian','gregorian')),
  digits text NOT NULL DEFAULT 'fa' CHECK (digits IN ('fa','latn')),
  active_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  recent_document_ids uuid[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  goal text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','archived')),
  color text NOT NULL DEFAULT 'blue' CHECK (color IN ('blue','purple','teal','green','orange')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 300),
  section text NOT NULL DEFAULT 'process' CHECK (section IN ('inputs','process','outputs','feedback')),
  done boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('text','markdown','file','url','pdf','chat','transcript')),
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('uploaded','queued','extracting','ready_for_analysis','analyzing','awaiting_review','applied','extraction_failed','needs_ocr','analysis_failed','canceled')),
  status_detail text,
  sensitivity text NOT NULL DEFAULT 'private_model' CHECK (sensitivity IN ('public','private_model','no_external')),
  project_id uuid,
  tags text[] NOT NULL DEFAULT '{}',
  origin_url text,
  canonical_url text,
  idempotency_key text,
  current_version_id uuid,
  duplicate_of uuid REFERENCES sources(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE SET NULL (project_id)
);
CREATE UNIQUE INDEX sources_idem ON sources(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX sources_ws_status ON sources(workspace_id, status) WHERE deleted_at IS NULL;
CREATE INDEX sources_canonical ON sources(workspace_id, canonical_url) WHERE canonical_url IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE source_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  version integer NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime text NOT NULL,
  byte_size bigint NOT NULL,
  original_name text,
  storage_path text NOT NULL,
  extractor text,
  extractor_version text,
  quality text NOT NULL DEFAULT 'pending' CHECK (quality IN ('pending','ok','partial','needs_ocr','failed')),
  extracted_text text,
  extracted_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  derived_from uuid REFERENCES source_versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX source_versions_sha ON source_versions(workspace_id, sha256);
ALTER TABLE sources ADD CONSTRAINT sources_current_version_fk FOREIGN KEY (current_version_id) REFERENCES source_versions(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path text NOT NULL CHECK (path !~ '(^/|\\.\\.|\\\\)'),
  kind text NOT NULL CHECK (kind IN ('source','concept','entity','synthesis','note','index','log','project','output','claude_md','other')),
  title text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  current_revision_id uuid,
  disk_sha256 text,
  sensitivity text NOT NULL DEFAULT 'private_model' CHECK (sensitivity IN ('public','private_model','no_external')),
  source_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX documents_path_live ON documents(workspace_id, path) WHERE deleted_at IS NULL;
CREATE INDEX documents_tags ON documents USING gin(tags);

CREATE TABLE document_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision integer NOT NULL,
  content text NOT NULL,
  sha256 text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('user','agent','external','import','system','rollback','native_import')),
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  changeset_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE documents ADD CONSTRAINT documents_current_rev_fk FOREIGN KEY (current_revision_id) REFERENCES document_revisions(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE links (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  from_document_id uuid NOT NULL,
  target_raw text NOT NULL,
  to_document_id uuid,
  status text NOT NULL CHECK (status IN ('resolved','missing','ambiguous')),
  link_kind text NOT NULL CHECK (link_kind IN ('wikilink','path','accepted_relation')),
  FOREIGN KEY (workspace_id, from_document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX links_from ON links(workspace_id, from_document_id);
CREATE INDEX links_to ON links(workspace_id, to_document_id);

CREATE TABLE search_chunks (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id uuid,
  revision_id uuid,
  source_version_id uuid,
  chunk_index integer NOT NULL,
  heading text,
  start_offset integer NOT NULL,
  end_offset integer NOT NULL,
  page integer,
  body text NOT NULL,
  norm text NOT NULL,
  norm_compact text NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', norm)) STORED,
  CHECK ((document_id IS NOT NULL) <> (source_version_id IS NOT NULL))
);
CREATE INDEX search_chunks_tsv ON search_chunks USING gin(tsv);
CREATE INDEX search_chunks_trgm ON search_chunks USING gin(norm_compact gin_trgm_ops);
CREATE INDEX search_chunks_doc ON search_chunks(workspace_id, document_id);
CREATE INDEX search_chunks_sv ON search_chunks(workspace_id, source_version_id);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  skill_id text NOT NULL,
  skill_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','waiting_for_review','succeeded','failed','cancel_requested','canceled','interrupted')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  provider text CHECK (provider IN ('anthropic','mock')),
  model text,
  attempt integer NOT NULL DEFAULT 0,
  attempt_id uuid,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_message text,
  retryable boolean,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_estimate_usd numeric(12,6),
  idempotency_key text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  source_id uuid,
  conversation_id uuid,
  schedule_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX agent_runs_idem ON agent_runs(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX agent_runs_ws_created ON agent_runs(workspace_id, created_at DESC);
CREATE INDEX agent_runs_status ON agent_runs(status);

CREATE TABLE run_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  seq integer NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq),
  FOREIGN KEY (workspace_id, run_id) REFERENCES agent_runs(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE run_tokens (
  token_hash bytea PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  credential_id uuid,
  model text NOT NULL,
  max_output_tokens integer NOT NULL,
  max_requests integer NOT NULL,
  used_requests integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE changesets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid,
  origin text NOT NULL CHECK (origin IN ('agent','native_import','rollback','manual','vault_import')),
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('proposed','applying','applied','partially_applied','rejected','conflict','rolled_back','superseded')),
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  apply_key text UNIQUE,
  rollback_of uuid REFERENCES changesets(id),
  rolled_back_by uuid REFERENCES changesets(id),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE INDEX changesets_ws_status ON changesets(workspace_id, status);

CREATE TABLE changeset_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  changeset_id uuid NOT NULL,
  seq integer NOT NULL,
  op text NOT NULL CHECK (op IN ('create','update','rename','delete','merge')),
  path text NOT NULL,
  new_path text,
  document_id uuid,
  base_sha256 text,
  base_revision_id uuid,
  before_content text,
  after_content text,
  after_sha256 text,
  diff text NOT NULL DEFAULT '',
  depends_on integer[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','applied','conflict','rolled_back')),
  rationale text NOT NULL DEFAULT '',
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  edited_by_user boolean NOT NULL DEFAULT false,
  UNIQUE (changeset_id, seq),
  FOREIGN KEY (workspace_id, changeset_id) REFERENCES changesets(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE apply_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  changeset_id uuid NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('prepared','committed','rolled_back')),
  entries jsonb NOT NULL,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  scope jsonb NOT NULL DEFAULT '{"type":"workspace"}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (workspace_id, id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  mode text NOT NULL CHECK (mode IN ('question','model_answer','text_search','error')),
  content text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  citation_key text NOT NULL,
  message_id uuid,
  output_version_id uuid,
  document_id uuid,
  revision_id uuid,
  source_version_id uuid,
  title text NOT NULL,
  heading text,
  start_offset integer NOT NULL,
  end_offset integer NOT NULL,
  page integer,
  excerpt text NOT NULL,
  excerpt_sha256 text NOT NULL,
  used boolean NOT NULL DEFAULT false,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, citation_key)
);

CREATE TABLE outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  template text NOT NULL CHECK (template IN ('report','decision','article')),
  brief jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_version integer NOT NULL DEFAULT 0,
  project_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (workspace_id, id)
);

CREATE TABLE output_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  output_id uuid NOT NULL,
  version integer NOT NULL,
  outline jsonb NOT NULL DEFAULT '[]'::jsonb,
  content text NOT NULL,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  author_kind text NOT NULL CHECK (author_kind IN ('user','agent','template')),
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (output_id, version),
  FOREIGN KEY (workspace_id, output_id) REFERENCES outputs(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE quiz_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid,
  question text NOT NULL,
  choices jsonb NOT NULL,
  answer_index integer NOT NULL,
  explanation text NOT NULL,
  document_id uuid,
  revision_id uuid,
  excerpt text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  quiz_item_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chosen integer NOT NULL,
  correct boolean NOT NULL,
  next_review_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, quiz_item_id) REFERENCES quiz_items(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE provider_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider = 'anthropic'),
  label text NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  key_version text NOT NULL,
  last4 text NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'untested' CHECK (status IN ('untested','valid','invalid','disconnected')),
  last_tested_at timestamptz,
  last_test_kind text,
  last_error_code text,
  last_error_message text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  available_models jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz
);
CREATE UNIQUE INDEX provider_credentials_active ON provider_credentials(provider) WHERE disconnected_at IS NULL;

CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  skill_id text NOT NULL,
  cron text NOT NULL,
  timezone text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  paused_reason text,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  budget_usd numeric(10,4),
  missed_policy text NOT NULL DEFAULT 'skip' CHECK (missed_policy IN ('skip','run_once')),
  last_slot timestamptz,
  last_run_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid,
  actor_user_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  result text NOT NULL CHECK (result IN ('success','failure','denied')),
  ip text,
  request_id text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created ON audit_events(created_at DESC);

CREATE TABLE backup_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL,
  manifest jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('created','verified','restored','failed')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE native_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ticket_hash bytea NOT NULL UNIQUE,
  action text NOT NULL CHECK (action IN ('login','shell')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    version: 2,
    name: 'native_staging',
    sql: /* sql */ `
CREATE TABLE native_staging (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base jsonb NOT NULL,
  status text NOT NULL DEFAULT 'loaded' CHECK (status IN ('loaded','imported','discarded')),
  changeset_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    version: 3,
    name: 'native_ticket_prefill',
    sql: /* sql */ `
-- Text the app pre-types into the owner's interactive Claude Code prompt (never submitted automatically).
ALTER TABLE native_tickets ADD COLUMN prefill text CHECK (prefill IS NULL OR length(prefill) <= 600);
`,
  },
];
