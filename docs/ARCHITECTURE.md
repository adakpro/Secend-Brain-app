# معماری Second Brain OS

نسخهٔ سند: ۱٫۰ — به‌روز تا commit فعلی شاخهٔ `main` (2026-10-07)
دامنهٔ استقرار: `https://brain.adakpro.com` (پشت ArvanCloud CDN)

این سند معماری کامل محصول را توضیح می‌دهد: اجزا، مرزهای اعتماد، جریان داده، مدل داده، پروتکل‌های حساس (apply، rollback، backup)، دو مسیر اتصال Claude، امنیت، استقرار و آزمون. نمودارها با Mermaid نوشته شده‌اند و GitHub آن‌ها را مستقیم رسم می‌کند.

---

## فهرست

1. [هدف و اصول طراحی](#۱-هدف-و-اصول-طراحی)
2. [نمای کلان سیستم](#۲-نمای-کلان-سیستم)
3. [سرویس‌ها، شبکه‌ها و volumeها](#۳-سرویسها-شبکهها-و-volumeها)
4. [ساختار کد (monorepo)](#۴-ساختار-کد-monorepo)
5. [احراز هویت و نشست](#۵-احراز-هویت-و-نشست)
6. [مدل داده](#۶-مدل-داده)
7. [Vault و فایل‌های Markdown](#۷-vault-و-فایلهای-markdown)
8. [ورود منبع و استخراج](#۸-ورود-منبع-و-استخراج)
9. [موتور عامل و اجرای مدل](#۹-موتور-عامل-و-اجرای-مدل)
10. [ChangeSet: پیشنهاد، اعمال، بازگردانی](#۱۰-changeset-پیشنهاد-اعمال-بازگردانی)
11. [پرسش مستند، ارجاع و SSE](#۱۱-پرسش-مستند-ارجاع-و-sse)
12. [جست‌وجوی فارسی](#۱۲-جستوجوی-فارسی)
13. [دو مسیر اتصال Claude](#۱۳-دو-مسیر-اتصال-claude)
14. [امنیت و مرزهای اعتماد](#۱۴-امنیت-و-مرزهای-اعتماد)
15. [پشتیبان، بازیابی و انتقال داده](#۱۵-پشتیبان-بازیابی-و-انتقال-داده)
16. [صف، زمان‌بندی و مشاهده‌پذیری](#۱۶-صف-زمانبندی-و-مشاهدهپذیری)
17. [فرانت‌اند](#۱۷-فرانتاند)
18. [استقرار، دامنه و عملیات](#۱۸-استقرار-دامنه-و-عملیات)
19. [فناوری‌ها و نسخه‌ها](#۱۹-فناوریها-و-نسخهها)
20. [راهبرد آزمون](#۲۰-راهبرد-آزمون)
21. [محدودیت‌ها و مسیر آینده](#۲۱-محدودیتها-و-مسیر-آینده)

---

## ۱. هدف و اصول طراحی

Second Brain OS یک سامانهٔ شخصیِ خودمیزبان مدیریت دانش است: مالک منبع وارد می‌کند (متن، Markdown، URL، PDF، خروجی گفتگو)، Claude آن را به صفحات ویکیِ به‌هم‌پیوسته تبدیل می‌کند، مالک تغییرات را بررسی و تأیید می‌کند و بعد از دانش خودش با ارجاع پاسخ می‌گیرد. منطق محتوایی از مخزن [`undefined-ui/second-brain-os`](https://github.com/undefined-ui/second-brain-os) (commit `d6861cc`، MIT) و ظاهر از HTML مرجع بستهٔ پیاده‌سازی گرفته شده است.

| اصل | پیامد معماری |
|---|---|
| **هیچ تغییر هوشمندی بی‌اجازه وارد دانش نمی‌شود** | عامل فقط `ChangeSet` می‌سازد؛ تنها `api` در vault می‌نویسد و فقط پس از تأیید. |
| **Markdown قابل حمل است** | vault همان ساختار upstream را دارد؛ PostgreSQL دادهٔ عملیاتی و نسخه‌ها را نگه می‌دارد. |
| **بدون کلید مدل هم کار کند** | ورود، کتابخانه، ویرایش، جست‌وجو، پروژه و خروجی مستقل از مدل‌اند؛ readiness به مدل وابسته نیست. |
| **کمترین دسترسی** | runner بدون DB، بدون vault، بدون اینترنت و بدون کلید دائمی؛ native بدون هیچ secret محصول. |
| **دو مسیر Claude جدا** | کارت API برای اتوماسیون؛ Claude Code رسمی با اشتراک فقط برای استفادهٔ خود مالک. |
| **ادعای صادقانه** | mock همیشه برچسب دارد؛ قابلیت پیاده‌نشده دکمهٔ موفق نمایشی ندارد. |

---

## ۲. نمای کلان سیستم

```mermaid
flowchart LR
    owner(["👤 مالک<br/>Browser / Mobile"])
    cdn["☁️ ArvanCloud CDN<br/>TLS: brain.adakpro.com"]
    subgraph host["🖥️ Server 65.21.30.154 — Docker Compose"]
        caddy["Caddy<br/>:80 / :443<br/>CDN-only allowlist"]
        web["web<br/>nginx + React SPA"]
        api["api<br/>Fastify"]
        worker["worker<br/>pg-boss + inference proxy"]
        runner["agent-runner<br/>Claude Agent SDK"]
        pg[("PostgreSQL 17")]
        native["native-claude<br/>official Claude Code CLI"]
        vault[("vault<br/>Markdown files")]
    end
    anthropic["Anthropic API<br/>api.anthropic.com"]
    claudeai["claude.ai<br/>owner sign-in"]

    owner -->|HTTPS| cdn -->|HTTP origin| caddy --> web -->|same origin /api| api
    api --- pg
    api --- vault
    api -->|jobs| pg
    worker --- pg
    worker -->|NDJSON job| runner
    runner -->|"per-run token"| worker
    worker -->|real API key| anthropic
    api -->|"PTY / headless jobs"| native
    native -->|"owner's own login"| claudeai
```

**نکتهٔ کلیدی:** مرورگر فقط با یک origin کار می‌کند (`https://brain.adakpro.com`). همهٔ فراخوانی‌ها، SSE و WebSocket ترمینال از همین origin عبور می‌کنند.

---

## ۳. سرویس‌ها، شبکه‌ها و volumeها

### ۳٫۱ سرویس‌ها

| سرویس | image | نقش | پورت داخلی | پورت میزبان |
|---|---|---|---|---|
| `caddy` | `caddy:2.10.2-alpine` | ورودی عمومی پشت CDN؛ فقط IPهای ArvanCloud | 80, 443 | `0.0.0.0:80/443` (فقط در overlay تولید) |
| `web` | `secondbrain/web` (nginx-unprivileged 1.29.3) | فایل‌های SPA، reverse proxy، CSP | 8080 | فقط در حالت local: `127.0.0.1:8080` |
| `api` | `secondbrain/api` | منطق محصول، auth، تنها نویسندهٔ vault، SSE، WS ترمینال | 3000 | — |
| `worker` | `secondbrain/worker` | صف pg-boss، استخراج، اجرای run، inference proxy | 8790 | — |
| `agent-runner` | `secondbrain/agent-runner` | اجرای Agent SDK با ابزارهای محدود | 8791 | — |
| `postgres` | `postgres:17.6-bookworm` | دادهٔ عملیاتی و صف | 5432 | — |
| `migrate` | همان image `api` | one-shot: migration + schema صف | — | — |
| `native-claude` | `secondbrain/native-claude` (profile `native`) | باینری رسمی Claude Code 2.1.291 | 8792 | — |

### ۳٫۲ شبکه‌ها و دسترسی

```mermaid
flowchart TB
    subgraph edge["edge"]
        caddy[caddy]
        web[web]
    end
    subgraph db["db 🔒 internal"]
        pg[(postgres)]
        migrate[migrate]
    end
    subgraph agent["agent 🔒 internal — no internet"]
        runner[agent-runner]
    end
    subgraph nativeNet["native 🔒 internal"]
        native[native-claude]
    end
    api[api]
    worker[worker]
    internet((Internet))

    caddy --> web --> api
    api --- pg
    migrate --- pg
    worker --- pg
    worker <-->|"jobs / proxy"| runner
    api <-->|"status, PTY, jobs"| native
    api -.->|egress| internet
    worker -.->|"egress: api.anthropic.com, URL fetch"| internet
    native -.->|native-egress| internet

    classDef locked fill:#fff3e7,stroke:#ff8818,color:#152033
    classDef core fill:#eaf2ff,stroke:#2168ff,color:#152033
    class runner,native locked
    class api,worker core
```

| شبکه | `internal` | اعضا | هدف |
|---|---|---|---|
| `edge` | خیر | caddy، web، api | مسیر درخواست کاربر |
| `db` | **بله** | postgres، migrate، api، worker | DB بدون خروجی اینترنت |
| `agent` | **بله** | worker، agent-runner | runner فقط به proxy worker می‌رسد |
| `native` | **بله** | api، native-claude | ترمینال و jobهای اشتراک |
| `egress` | خیر | api، worker | Anthropic API، دریافت URL، آزمون کلید |
| `native-egress` | خیر | native-claude | ورود و درخواست‌های خود Claude Code |

### ۳٫۳ secretها و volumeها

| secret (Docker file secret) | دریافت‌کنندگان | **ندارند** |
|---|---|---|
| `db_password` | postgres، migrate، api، worker | runner، web، native |
| `master_key` | migrate، api، worker | runner، web، postgres، native |
| `internal_token` | migrate، api، worker، agent-runner | web، postgres، native |

| volume | mount | محتوا | در backup عادی |
|---|---|---|---|
| `pg-data` | postgres | پایگاه داده | ✔ (snapshot منطقی) |
| `vault-data` | api | `vault/<workspace>/…` | ✔ |
| `source-data` | api، worker | فایل‌های خام منابع (content-addressed) | ✔ |
| `backup-data` | api | آرشیوهای پشتیبان | — |
| `native-home` | native-claude | HOME و credential خود CLI | ✘ (عمداً) |
| `native-staging` | native-claude | کپی کاری vault برای Claude Code | ✘ |
| `caddy-data/config` | caddy | گواهی internal | ✘ |

همهٔ سرویس‌های اپ: کاربر غیرroot، `read_only` rootfs، `cap_drop: ALL`، `no-new-privileges`، tmpfs محدود، سقف حافظه/CPU و rotation لاگ.

---

## ۴. ساختار کد (monorepo)

```mermaid
flowchart LR
    subgraph packages
        contracts["@sb/contracts<br/>zod DTOs · runner protocol · normalize"]
        core["@sb/core<br/>auth · crypto · database · vault · changesets<br/>search · ingest · runs · providers · backup · queue"]
    end
    subgraph apps
        apiApp["apps/api<br/>routes · app · cli"]
        workerApp["apps/worker<br/>executor · proxy · mock"]
        runnerApp["apps/agent-runner<br/>SDK query · MCP tools"]
        webApp["apps/web<br/>React pages · components"]
        nativeApp["apps/native-claude<br/>PTY · headless jobs<br/>(separate lockfile)"]
    end
    vendor["vendor/second-brain-os<br/>skills · commands · vault-template"]

    contracts --> core
    contracts --> webApp
    contracts --> runnerApp
    core --> apiApp
    core --> workerApp
    vendor --> core
    vendor --> apiApp
```

```text
apps/
  api/            Fastify: routes/{auth,workspaces,sources,documents,changesets,runs,ask,projects,
                  studio,knowledge,admin,native,backups,transfer,system}.ts, app.ts, cli.ts
  worker/         main.ts (queues, schedules), executor.ts, proxy.ts, mock-anthropic.ts
  agent-runner/   main.ts (SDK query), tools.ts (MCP tools)
  web/            pages/*, components/{shell,ui,content,add-source,command-palette,claude-task}
  native-claude/  src/main.mjs (PTY + headless jobs), own package-lock.json
packages/
  contracts/      api.ts, runner.ts, normalize.ts
  core/           auth, crypto, database (migrations), vault, markdown, changesets, search,
                  ingest, net (safe-fetch), providers, agents (registry, prompts), runs,
                  health, schedules, queue, archive (zip), backup
vendor/second-brain-os/   نسخهٔ pin‌شدهٔ upstream (MIT) + SHA256SUMS
infra/docker/     node.Dockerfile, native.Dockerfile, nginx.conf, Caddyfile*, 
scripts/          bootstrap, create-admin, doctor, backup, restore, update, test, lint
compose.yaml · compose.production.yaml · compose.test.yaml
```

هر app با esbuild به یک فایل bundle می‌شود؛ ماژول‌های native (`@node-rs/argon2`، `pg`، `pg-boss`، `pdfjs-dist`، `linkedom`، Agent SDK) external هستند و با `pnpm deploy --prod` از lockfile نصب می‌شوند.

---

## ۵. احراز هویت و نشست

ورود به برنامه کاملاً مستقل از حساب Claude است. مالک اول فقط با CLI ساخته می‌شود (`scripts/create-admin.sh`)؛ حساب پیش‌فرض و ثبت‌نام عمومی وجود ندارد.

```mermaid
sequenceDiagram
    autonumber
    actor U as مالک
    participant B as Browser
    participant A as api
    participant D as PostgreSQL
    U->>B: email + password (+ TOTP)
    B->>A: POST /api/v1/auth/login (Origin check)
    A->>D: throttle check (8/account, 30/IP per 15 min)
    A->>A: Argon2id verify (m=19MiB, t=2, p=1)
    alt TOTP enabled
        A->>A: verify step > last_step (replay guard)
    end
    A->>D: INSERT session (sha256(token), csrf, expiry)
    A-->>B: Set-Cookie __Host-sb_session (HttpOnly, Secure, SameSite=Lax) + csrfToken
    B->>A: POST /api/... + X-CSRF-Token + X-Workspace-Id
    A->>D: resolve session + membership + role
    A-->>B: 200 / 403 (role) / 403 csrf_failed
```

| کنترل | جزئیات |
|---|---|
| نشست | توکن ۳۲ بایتی، فقط hash در DB؛ انقضای مطلق ۷ روز، idle ۱۲ ساعت؛ چرخش هنگام ورود؛ logout و logout-all واقعی |
| CSRF | توکن مرتبط با نشست در header برای همهٔ درخواست‌های تغییردهنده + بررسی `Origin`؛ CORS خاموش |
| نقش | owner / admin / member / viewer در سرور؛ هر کوئری با `workspace_id` عضویت فیلتر می‌شود |
| step-up | تأیید دوبارهٔ گذرواژه (و TOTP) با اعتبار ۱۰ دقیقه برای: کلید API، ترمینال/jobهای native، کاربران، backup |
| TOTP | secret با AES-GCM رمز می‌شود؛ ۱۰ recovery code یک‌بارمصرف، فقط hash |
| پیام خطا | برای کاربر ناموجود و گذرواژهٔ غلط یکسان؛ زمان‌بندی با hash ساختگی هم‌تراز |

---

## ۶. مدل داده

PostgreSQL محل دادهٔ عملیاتی است؛ متن صفحات در هر revision ذخیره می‌شود تا diff، rollback و ارجاع نسخه‌دار ممکن باشد. ایندکس جست‌وجو و لینک‌ها از محتوا بازسازی‌پذیرند.

```mermaid
erDiagram
    USERS ||--o{ SESSIONS : has
    USERS ||--o{ MEMBERSHIPS : has
    WORKSPACES ||--o{ MEMBERSHIPS : has
    WORKSPACES ||--o{ SOURCES : contains
    SOURCES ||--o{ SOURCE_VERSIONS : versions
    WORKSPACES ||--o{ DOCUMENTS : contains
    DOCUMENTS ||--o{ DOCUMENT_REVISIONS : revisions
    DOCUMENTS ||--o{ LINKS : "links from"
    DOCUMENTS ||--o{ SEARCH_CHUNKS : indexed
    SOURCE_VERSIONS ||--o{ SEARCH_CHUNKS : indexed
    WORKSPACES ||--o{ AGENT_RUNS : runs
    AGENT_RUNS ||--o{ RUN_EVENTS : streams
    AGENT_RUNS ||--o| CHANGESETS : proposes
    CHANGESETS ||--o{ CHANGESET_ITEMS : items
    CHANGESETS ||--o{ APPLY_JOURNAL : journal
    WORKSPACES ||--o{ CONVERSATIONS : has
    CONVERSATIONS ||--o{ MESSAGES : has
    MESSAGES ||--o{ CITATIONS : cites
    WORKSPACES ||--o{ PROJECTS : has
    PROJECTS ||--o{ TASKS : has
    WORKSPACES ||--o{ OUTPUTS : has
    OUTPUTS ||--o{ OUTPUT_VERSIONS : versions
    WORKSPACES ||--o{ QUIZ_ITEMS : has
    QUIZ_ITEMS ||--o{ QUIZ_ATTEMPTS : attempts

    SOURCES {
        uuid id PK
        text kind
        text status
        text sensitivity
        uuid current_version_id
    }
    SOURCE_VERSIONS {
        uuid id PK
        text sha256
        text quality
        text extracted_text
        jsonb coverage
    }
    DOCUMENTS {
        uuid id PK
        text path
        text kind
        uuid current_revision_id
        text sensitivity
    }
    DOCUMENT_REVISIONS {
        uuid id PK
        int revision
        text content
        text sha256
        text author_kind
    }
    CHANGESETS {
        uuid id PK
        text origin
        text status
        text apply_key UK
        uuid rollback_of
    }
    CHANGESET_ITEMS {
        int seq
        text op
        text path
        text base_sha256
        int_array depends_on
    }
    CITATIONS {
        text citation_key
        uuid revision_id
        int start_offset
        int end_offset
        text excerpt
        jsonb validation
    }
```

جدول‌های دیگر: `recovery_codes`، `login_attempts`، `user_preferences`، `run_tokens` (توکن کوتاه‌عمر proxy)، `provider_credentials` (کلید رمزشده)، `schedules`، `audit_events`، `backup_manifests`، `native_tickets` (ticket تک‌مصرف ترمینال، با `prefill`)، `native_staging` (snapshot پایهٔ staging)، `app_meta`. migrationها append-only و با قفل advisory اجرا می‌شوند (نسخهٔ فعلی schema: ۳).

---

## ۷. Vault و فایل‌های Markdown

```text
vault/<workspace-slug>/
  CLAUDE.md                 قرارداد upstream (قرنطینه؛ هرگز به runner داده نمی‌شود)
  raw/                      آرشیو خام مالک (فقط‌خواندنی)
  wiki/
    sources/ concepts/ entities/ synthesis/
    index.md  log.md        فقط کد مورداعتماد هنگام apply می‌سازد
  notes/                    یادداشت دستی (افزونهٔ محصول برای نوع note)
  projects/  output/  templates/
```

**VaultService** تنها مسیر نوشتن است و این تضمین‌ها را دارد:

- مسیر نسبی معتبر: منع `..`، مسیر مطلق، backslash، نام رزرو، کاراکتر کنترلی؛ `realpath` روی نزدیک‌ترین والد موجود و رد هر symlink.
- نوشتن اتمی: فایل موقت در همان پوشه ← `fsync` ← `rename` ← `fsync` پوشه.
- optimistic concurrency: ذخیرهٔ دستی با `baseRevisionId`؛ ناسازگاری با revision DB یا hash دیسک ⇒ `409 conflict`.
- reconcile دوره‌ای (هر ۶۰ ثانیه) مبتنی بر hash: فایل جدید ← import، تغییر بیرونی ← revision `external`، تغییرنام فقط وقتی hash یکسان و یک‌به‌یک است، فایل گمشده ← حذف نرم با audit.
- frontmatter با schema هستهٔ YAML 1.2 (بدون tag سفارشی)؛ ویرایش خط‌به‌خط تا کلیدهای ناشناخته و comment حفظ شوند.
- resolve لینک: `[[name#heading|alias]]`، مسیردار، alias؛ دو فایل هم‌نام ⇒ `ambiguous` (هرگز ادغام خاموش).

خوانندگان برنامه همیشه از revision جاری DB می‌خوانند؛ بنابراین در میانهٔ apply حالت نیمه‌اعمال‌شده دیده نمی‌شود.

---

## ۸. ورود منبع و استخراج

```mermaid
stateDiagram-v2
    [*] --> queued: create (text / url / upload)
    queued --> extracting: worker source-extract
    extracting --> ready_for_analysis: text extracted + indexed
    extracting --> needs_ocr: PDF without text layer
    extracting --> extraction_failed: login wall / HTTP error / bad type
    needs_ocr --> ready_for_analysis: replacement text (new derived version)
    extraction_failed --> queued: retry
    ready_for_analysis --> queued: analyze (API run)
    queued --> analyzing
    ready_for_analysis --> analyzing: analyze with Claude (subscription)
    analyzing --> awaiting_review: ChangeSet proposed
    analyzing --> analysis_failed
    analyzing --> canceled
    awaiting_review --> applied: owner approves
    applied --> [*]
```

| نوع ورودی | استخراج‌کننده | جزئیات |
|---|---|---|
| متن / Markdown / transcript | UTF-8 (fatal decoder) | بایت‌به‌بایت حفظ؛ hash ثبت |
| URL عمومی | `safeFetch` + Readability (linkedom، بدون اجرای JS) | SSRF guard، تشخیص login wall/paywall، ذخیرهٔ پاسخ خام با checksum |
| PDF | pdfjs-dist | جداکنندهٔ صفحه `\f` ⇒ ارجاع شماره صفحه؛ کم‌متن ⇒ `needs_ocr` |
| JSON گفتگو | parser قطعی | قالب‌های `chat_messages`، `mapping` (شاخهٔ فعال + گزارش شاخه‌ها)، `messages`؛ ناشناخته ⇒ خطا |

**فایل خام هرگز تغییر نمی‌کند:** ذخیره‌سازی content-addressed (`sources/<ws>/<sha[0:2]>/<sha>.<ext>`، mode 0440). اصلاح متن = نسخهٔ مشتق جدید. تکراری قطعی با hash یا URL کانونی تشخیص داده می‌شود و فقط علامت می‌خورد.

---

## ۹. موتور عامل و اجرای مدل

### ۹٫۱ registry مهارت‌ها

همهٔ دکمه‌ها، فرمان‌های palette و زمان‌بندی‌ها به یک registry نسخه‌دار می‌رسند (`packages/core/src/agents/registry.ts`):

| mode | مهارت‌ها | ابزارها |
|---|---|---|
| **propose** | ingest | `read_source`، `list_index`، `search_wiki`، `read_note`، `get_backlinks`، `propose_change` |
| **read** | query، report، write، quiz | `list_index`، `search_wiki`، `read_note`، `get_backlinks` |
| **deterministic** | lint، graph، metrics، chat-import، transcript، project، privacy | کد قطعی، بدون مدل |
| پیاده‌نشده | rename، merge، review، backfill، publish، changed-my-mind | با برچسب صادقانه در UI |

### ۹٫۲ مسیر اجرای API (اتوماسیون)

```mermaid
sequenceDiagram
    autonumber
    participant UI as Browser
    participant A as api
    participant Q as pg-boss (PostgreSQL)
    participant W as worker / executor
    participant R as agent-runner
    participant P as worker inference proxy
    participant X as Anthropic API
    UI->>A: POST /sources/:id/analyze
    A->>Q: agent_run(queued) + job run-execute
    Q->>W: job
    W->>W: build scope-filtered bundle (no_external excluded)
    W->>W: issue per-run token (sb_…, model, max tokens, 60 req, TTL)
    W->>R: POST /jobs (bundle + prompt + proxy URL + token)
    R->>R: query() tools=[], MCP vault tools, dontAsk, settingSources=[]
    loop agent turns
        R->>P: POST /inference/v1/messages (x-api-key = run token)
        P->>P: validate token, model, clamp max_tokens
        P->>X: same request with REAL key (decrypted here only)
        X-->>P: SSE stream
        P-->>R: SSE stream (usage counted, text not stored)
        R-->>W: NDJSON events (tool, text_delta, proposal)
        W->>Q: run_events + pg_notify
    end
    R-->>W: result (structured output)
    W->>W: validateAgentOps + ChangeSetEngine.propose
    W->>Q: run waiting_for_review, source awaiting_review
```

**تنظیمات Agent SDK در runner:** `tools: []` (هیچ ابزار داخلی Bash/Read/Write/Web)، فقط MCP درون‌فرایندی `vault`، `allowedTools` دقیق، `disallowedTools` پشتیبان، `permissionMode: 'dontAsk'`، `settingSources: []` (هیچ CLAUDE.md/hook/تنظیمات فایل‌سیستم)، `strictMcpConfig`، `persistSession: false`، `outputFormat: json_schema`، `maxTurns`، `maxBudgetUsd`، HOME خالی و یکتا برای هر job، و `env` کاملاً جایگزین‌شده (کلید واقعی هرگز وارد runner نمی‌شود).

### ۹٫۳ وضعیت‌های run

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> running
    queued --> canceled: cancel
    running --> waiting_for_review: ingest proposal
    running --> succeeded: query / studio / quiz
    running --> failed
    running --> cancel_requested: cancel
    running --> interrupted: worker lost (stale heartbeat)
    running --> queued: transient error (bounded retry)
    cancel_requested --> canceled
    waiting_for_review --> succeeded: applied or rejected
    failed --> queued: manual retry
    interrupted --> queued: manual retry
```

اجرای قطع‌شده هرگز خودکار تکرار نمی‌شود (جلوگیری از هزینهٔ تکراری). خطای credential یا ورودی تکرار نمی‌شود؛ خطای موقت حداکثر ۳ تلاش با backoff.

### ۹٫۴ ارائه‌دهندهٔ mock

فقط در پروفایل `test`/`development` (`MODEL_PROVIDER_MODE=mock`) پذیرفته می‌شود و در `production` باعث خطای startup است. proxy به‌جای Anthropic یک Messages API قطعی را صدا می‌زند تا SDK واقعی، runner، ابزارها و ChangeSet در CI بدون کلید آزموده شوند. هر خروجی آن «آزمایشی» برچسب می‌خورد.

---

## ۱۰. ChangeSet: پیشنهاد، اعمال، بازگردانی

ChangeSet مرز اصلی اعتماد است: خروجی عامل، import vault، یادداشت از پاسخ و تغییرات Claude Code همه به ChangeSet تبدیل می‌شوند.

### ۱۰٫۱ اعتبارسنجی سمت سرور

- مسیر عامل فقط `wiki/{sources,concepts,entities,synthesis}/*.md`؛ `raw/`، `index.md`، `log.md` و پیکربندی هرگز.
- frontmatter بدون خطا و نوع منطبق با پوشه؛ سقف ۴۰ عملیات و ۲۰۰KB برای هر فایل.
- وابستگی: موردی که به صفحهٔ ساخته‌شده در همان بسته لینک می‌دهد به آن وابسته است؛ پذیرش جزئیِ شکنندهٔ وابستگی رد می‌شود.

### ۱۰٫۲ پروتکل apply با journal

```mermaid
flowchart TD
    start([POST /changesets/:id/apply + applyKey]) --> idem{apply_key<br/>already used?}
    idem -- yes --> same([return previous result — idempotent])
    idem -- no --> lock[pg_advisory_xact_lock workspace<br/>SELECT … FOR NO KEY UPDATE]
    lock --> deps{dependencies<br/>satisfied?}
    deps -- no --> rej([422 partial accept breaks dependencies])
    deps -- yes --> check{base sha == DB revision<br/>and == disk hash?}
    check -- no --> conflict([status=conflict · 409 · nothing written])
    check -- yes --> maint[build index.md + log.md<br/>from accepted items only]
    maint --> journal[(apply_journal: prepared<br/>before/after content)]
    journal --> write[for each file:<br/>temp → fsync → rename]
    write --> commit[one DB transaction:<br/>revisions · current_revision · index · links<br/>changeset applied · journal committed]
    commit --> done([applied / partially_applied])
    write -. crash .-> recover[[startup recoverJournals:<br/>restore 'before' where disk == 'after'<br/>remove created files · status → proposed]]
```

### ۱۰٫۳ بازگردانی بدون پاک‌کردن ویرایش‌های بعدی

rollback یک ChangeSet جدید است: برای هر فایل، وصلهٔ معکوس (after→before) روی **متن فعلی** اعمال می‌شود. اگر کاربر بعداً بخش دیگری را ویرایش کرده باشد، آن ویرایش حفظ می‌شود؛ اگر روی همان خطوط باشد، تعارض گزارش می‌شود. صفحه‌ای که همان بسته ساخته بود فقط وقتی حذف می‌شود که دست‌نخورده باشد. `git reset` هرگز استفاده نمی‌شود.

---

## ۱۱. پرسش مستند، ارجاع و SSE

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser (Ask)
    participant A as api
    participant W as worker + runner
    participant D as PostgreSQL
    B->>A: POST /ask {question, scope}
    alt model available
        A->>D: conversation + message + agent_run
        A-->>B: {runId}
        B->>A: GET /runs/:id/events (EventSource)
        W->>D: run_events (tool, text_delta) + NOTIFY
        A-->>B: SSE events (id = event id)
        W->>W: validateCitations(answer, citations, bundle)
        W->>D: message + citations (key, revision, offsets, excerpt, validity)
        A-->>B: event end
    else no API, Claude subscription signed in
        A->>A: native headless job (see §13)
    else no model at all
        A->>D: text-search result labelled "not a model answer"
        A-->>B: mode = text_search
    end
```

- **کلید ارجاع:** هر بخش bundle یک کلید (`C12` برای صفحه، `S3` برای منبع) دارد. مدل فقط باید کلیدهای همان run را به‌کار ببرد و نقل‌قول دقیق بدهد.
- **اعتبارسنجی:** کلید ساختگی، نقل‌قول نامنطبق با بخش، و نشانهٔ `[Cn]` بدون مدخل citation جدا گزارش می‌شوند. اعتبار ساختاری به معنای درستی معنایی نیست و این در UI گفته می‌شود.
- **نسخه:** citation به `revision_id` و بازهٔ offset متن اصلی متصل است؛ اگر صفحه بعداً تغییر کند، «تغییر کرده» نمایش داده می‌شود.
- **SSE:** فقط با نشست و عضویت همان workspace؛ resume با `Last-Event-ID` فقط رویدادهای بعدی همان run را برمی‌گرداند؛ یک اتصال `LISTEN` در هر فرایند api رویدادها را پخش می‌کند.

---

## ۱۲. جست‌وجوی فارسی

```mermaid
flowchart LR
    text["متن اصلی<br/>(دست‌نخورده)"] --> chunk["chunkText<br/>offset به متن اصلی<br/>heading · page"]
    chunk --> norm["normalizeForSearch<br/>ي→ی ك→ک · حذف اعراب/کشیده<br/>ارقام ←→ لاتین · ZWNJ→space"]
    norm --> tsv[("tsvector 'simple'<br/>GIN")]
    norm --> compact["compact form<br/>(بدون فاصله)"] --> trgm[("pg_trgm<br/>GIN")]
    q["query"] --> norm2["همان normalization"] --> match{"tsv @@ prefix query<br/>OR compact LIKE"}
    tsv --> match
    trgm --> match
    match --> rank["ts_rank + compact bonus + title bonus"] --> filter["workspace + sensitivity filter"]
```

«می‌شود»، «می شود» و «میشود» یکسان پیدا می‌شوند؛ «كتاب علي» با «کتاب علی» برابر است؛ ولی متن ذخیره‌شده و offsetهای ارجاع هرگز تغییر نمی‌کنند. embedding در نسخهٔ ۱ وجود ندارد و ادعا هم نمی‌شود.

---

## ۱۳. دو مسیر اتصال Claude

```mermaid
flowchart TB
    subgraph apiPath["کارت ۱ — اتصال API (اتوماسیون سامانه)"]
        key["API key مالک<br/>AES-256-GCM با master key"] --> proxy["worker inference proxy"]
        proxy --> anth["api.anthropic.com"]
        queue["queue · schedules · ingest · ask · studio · quiz"] --> proxy
    end
    subgraph nativePath["کارت ۲ — Claude Code رسمی با اشتراک مالک"]
        login["ورود خود مالک<br/>claude auth login در ترمینال خصوصی"] --> home[("native-home<br/>credential فقط در CLI")]
        click["کلیک مالک:<br/>«تحلیل با Claude» / پرسش"] --> job["claude -p (headless)<br/>Read/Edit/Write/Glob/Grep در staging"]
        term["ترمینال تعاملی"] --> cli["claude"]
        home --> job
        home --> cli
        job --> staging[("native-staging")]
        cli --> staging
    end
    staging --> importer["importer مورداعتماد در api"] --> cs["ChangeSet → بررسی → تأیید"]
    apiPath -.-x|"هرگز به هم وصل نمی‌شوند"| nativePath
```

| | کارت API | کارت native (اشتراک) |
|---|---|---|
| credential | API key مالک، رمزشده در DB | login رسمی CLI در volume جدا؛ برنامه آن را نمی‌خواند |
| آغازکننده | صف، دکمه، زمان‌بندی | فقط کلیک مالک یا ترمینال تعاملی |
| اجرا | Agent SDK در runner ایزوله | باینری دست‌نخوردهٔ Claude Code 2.1.291 در کانتینر native |
| ابزار | MCP محدود به bundle | Read/Edit/Write/Glob/Grep فقط در staging؛ Bash و وب مسدود |
| خروجی | ChangeSet، پاسخ با citation اعتبارسنجی‌شده | ChangeSet از importer؛ پاسخ با پیوند `[[صفحه]]` |
| هم‌زمانی | قابل تنظیم (پیش‌فرض ۲) | یک اجرا در هر لحظه |

### ۱۳٫۱ تحلیل پس‌زمینه با اشتراک

```mermaid
sequenceDiagram
    autonumber
    actor O as مالک
    participant UI as Source page
    participant A as api
    participant N as native-claude
    participant C as claude -p (official CLI)
    participant D as PostgreSQL
    O->>UI: «تحلیل با Claude»
    UI->>A: POST /admin/native-claude/jobs {ingest, sourceId} (step-up)
    A->>A: checks: admin · signed in · not busy · not no_external
    A->>N: POST /staging/load (pages, raw/source, CLAUDE.md, skills, commands)
    A->>D: native_staging (base snapshot) + agent_run(running)
    A->>N: POST /jobs {prompt}
    N->>C: spawn in /workspace/vault (acceptEdits, allowed tools only)
    loop every 1.5 s
        A->>N: GET /jobs/:id?after=n
        N-->>A: events (tool + path, text)
        A->>D: run_events → SSE to UI (live progress)
    end
    C-->>N: result
    A->>N: GET /staging/export
    A->>A: importer: path rules · frontmatter · base revision checks
    A->>D: ChangeSet (origin native_import) · run waiting_for_review
    UI-->>O: «منتظر بررسی» → diff → تأیید
```

شرایط این مسیر در `docs/CLAUDE-AUTH-DECISION.md` ثبت شده است: فقط استفادهٔ خود مالک، با کلیک خودش، بدون صف و زمان‌بندی، با باینری رسمی و login خود او.

### ۱۳٫۲ ترمینال تعاملی

WebSocket `/api/v1/admin/native-claude/terminal` فقط وقتی باز می‌شود که: `Origin == APP_ORIGIN`، کوکی نشست معتبر است، ticket تک‌مصرف ۶۰ ثانیه‌ای برای **همین نشست و همین کاربر** صادر شده، نقش admin است و step-up اخیر وجود دارد. فرمان‌ها ثابت‌اند (`claude auth login`، `claude`)؛ متن ترمینال ذخیره یا لاگ نمی‌شود؛ idle timeout ۱۵ دقیقه؛ لغو نشست برنامه ترمینال را می‌بندد. «بستن ترمینال» با «خروج از حساب Claude» (`claude auth logout`) فرق دارد.

---

## ۱۴. امنیت و مرزهای اعتماد

```mermaid
flowchart LR
    subgraph untrusted["غیرقابل‌اعتماد"]
        internet(("Internet / CDN"))
        srcText["متن منابع و صفحات<br/>(prompt injection)"]
        vaultCfg[".claude/ · hooks · MCP<br/>داخل vault واردشده"]
    end
    subgraph trusted["مورداعتماد — api / worker"]
        auth["auth · CSRF · roles · step-up"]
        validate["validateAgentOps · importer · citation validator"]
        vaultSvc["VaultService (only writer)"]
        crypto["master key · credential decrypt"]
    end
    subgraph sandboxed["محدودشده"]
        runner["agent-runner<br/>no DB · no vault · no internet"]
        native["native-claude<br/>no product secrets"]
    end
    internet -->|"Caddy allowlist → nginx CSP"| auth
    srcText -->|"data only, via MCP tools"| runner
    runner -->|"proposals only"| validate --> vaultSvc
    native -->|"staging export"| validate
    vaultCfg -.->|quarantined| blocked["⛔ never loaded into any run"]
    crypto -->|"per-run token, not the key"| runner
```

| تهدید | کنترل |
|---|---|
| SSRF در URL fetcher | فقط http/https، پورت‌های مجاز، resolve و بررسی IP (loopback/private/link-local/metadata/IPv6 داخلی) و **اتصال به همان IP بررسی‌شده** (ضد DNS rebinding)، بررسی دوبارهٔ هر redirect، سقف اندازه پس از decompress |
| آرشیو مخرب | پیش از استخراج: zip-slip، symlink، تعداد، اندازهٔ کل و نسبت فشرده‌سازی (zip-bomb)؛ CRC و اندازهٔ واقعی |
| XSS | DOMPurify با allowlist (بدون SVG/iframe/script/style/img)؛ CSP بدون inline script؛ export HTML با escape کامل |
| فایل نامطمئن | دانلود با `Content-Disposition: attachment`، `nosniff` و `CSP: sandbox` |
| prompt injection | قواعد محصول در system prompt + مرز واقعی در ابزار/سرور: runner هیچ secret یا شبکه‌ای ندارد و نوشتن فقط پیشنهاد است |
| IDOR | همهٔ کوئری‌ها با workspace عضویت؛ شناسهٔ حدس‌زده‌شده ⇒ 404 |
| نشت secret | redaction در logger، پاسخ masked، lint برای الگوی کلید، secretها خارج از image و Git |
| دسترسی مستقیم به origin | Caddy فقط IPهای ArvanCloud را می‌پذیرد؛ بقیه 403 |

مدل تهدید کامل: `docs/THREAT-MODEL.md`.

---

## ۱۵. پشتیبان، بازیابی و انتقال داده

```mermaid
flowchart TD
    subgraph backup["./scripts/backup.sh [--encrypt]"]
        b1[REPEATABLE READ READ ONLY snapshot] --> b2[advisory lock per workspace<br/>blocks apply/save]
        b2 --> b3[db/*.jsonl per table<br/>sessions, tokens excluded]
        b3 --> b4[vault + sources files<br/>hash before/after copy]
        b4 --> b5[manifest.json<br/>versions · checksums · active runs]
        b5 --> b6{passphrase?}
        b6 -- yes --> b7[scrypt + AES-256-GCM → .zip.enc]
        b6 -- no --> b8[.zip, mode 0600]
    end
    subgraph restore["./scripts/restore.sh file"]
        r1[verify: checksums · schema · paths · disk] --> r2[dry-run summary]
        r2 --> r3{type file name<br/>to confirm}
        r3 --> r4[stop web/worker/api]
        r4 --> r5[TRUNCATE + reload in one transaction]
        r5 --> r6[current files → .pre-restore-*]
        r6 --> r7[sessions gone · schedules paused<br/>unfinished runs interrupted · queue cleared]
    end
    b7 --> r1
    b8 --> r1
```

- master key **داخل پشتیبان نیست**؛ باید جدا و بیرون از سرور نگه داشته شود.
- credential ورود native در پشتیبان عادی نیست؛ پس از بازیابی دوباره وارد می‌شوید.
- **export قابل حمل** (`/transfer`): ZIP از Markdown صفحات، خروجی‌ها و فایل‌های خام، بدون حساب/نشست/کلید.
- **import نسخهٔ HTML**: preview، جداسازی دادهٔ نمونه (فقط در فضای demo)، یادداشت‌ها به‌صورت ChangeSet.
- **import vault ZIP**: اسکن فقط‌خواندنی، قرنطینهٔ `.claude/`، صفحات به‌صورت ChangeSet.

---

## ۱۶. صف، زمان‌بندی و مشاهده‌پذیری

| صف (pg-boss) | سیاست | کار |
|---|---|---|
| `source-extract` | ۳ retry با backoff | استخراج و ایندکس منبع |
| `run-execute` | ۳ retry فقط برای خطای موقت | اجرای run مدل |
| `schedule-tick` | singleton، هر دقیقه | ارزیابی زمان‌بندی‌ها و یافتن runهای معطل |

**زمان‌بندی:** هر slot با compare-and-set روی `last_slot` فقط یک بار claim می‌شود؛ slotهای ازدست‌رفته طبق `skip` یا `run_once` (هرگز یک بار برای هر slot)؛ اجرای قبلی فعال ⇒ رد بدون هم‌پوشانی؛ ingest زمان‌بندی‌شده فقط **پیشنهاد** می‌سازد.

**سلامت:** `/health/live`، `/health/ready` (DB + schema؛ مستقل از مدل)، و `/api/v1/system/status` با سه مدل جدا: readiness سرویس، وضعیت providerها (API و native)، و capabilityهای قابل استفاده برای کاربر.

**لاگ:** JSON ساختاریافته با `requestId`/`runId`/`workspaceId`، بدون متن منبع یا گفتگو، با redaction؛ nginx و Caddy بدون query string؛ rotation در Docker. **audit** برای ورود، کلید، ترمینال، apply، backup و import.

---

## ۱۷. فرانت‌اند

React 19 + react-router 8 + TanStack Query 5، با CSS مرجع (`styles/reference.css`) و افزوده‌های محدود (`styles/app.css`)؛ فونت Vazirmatn به‌صورت self-hosted.

```mermaid
flowchart TB
    main["main.tsx<br/>router + QueryClient"] --> login["/login"]
    main --> session["RequireSession<br/>/me → csrf, workspace, prefs"]
    session --> shell["AppShell<br/>Sidebar · Topbar · ContextRail · MobileBottom"]
    shell --> pages
    subgraph pages["routes"]
        home["/home"]
        inbox["/inbox · /inbox/:id"]
        library["/library · /library/:id"]
        ask["/ask · /ask/:id"]
        projects["/projects · /projects/:id"]
        review["/review · /review/:id"]
        graphPage["/graph"]
        studio["/studio · /studio/:id"]
        learn["/learn"]
        activity["/activity"]
        settings["/settings/:section<br/>/settings/integrations/claude"]
        admin["/admin/users · /admin/audit · /admin/backups · /transfer"]
    end
    shell --> palette["CommandPalette (⌘K)<br/>search + commands (navigate only)"]
    shell --> add["AddSourceDialog"]
    pages --> comps["ui.tsx · content.tsx (Markdown, DiffViewer, StepUp)<br/>claude-task.tsx · run-stream.ts (SSE)"]
```

- مسیرهای واقعی با deep-link و refresh؛ هیچ داده‌ای در localStorage جز ترجیح ظاهر.
- RTL کامل؛ کد، مسیر و URL به‌صورت LTR؛ تاریخ شمسی و ارقام فارسی با timezone کاربر.
- dialog بومی (focus trap، Escape)، label فرم‌ها، focus-visible، reduced motion.
- ویرایشگر Markdown: پیش‌نمایش زنده، autosave با debounce، dirty state، تعارض بدون بازنویسی خاموش، هشدار خروج.
- گراف: Cytoscape با سه نوع رابطه (لینک واقعی، رابطهٔ پذیرفته، برچسب مشترک خط‌چین) و نمای فهرستی جایگزین.

---

## ۱۸. استقرار، دامنه و عملیات

```mermaid
flowchart LR
    user(["Browser"]) -->|"https://brain.adakpro.com"| arvan["ArvanCloud edge<br/>public TLS · HTTP→HTTPS"]
    arvan -->|"HTTP :80 or HTTPS :443<br/>to 65.21.30.154"| caddy["caddy<br/>allow ArvanCloud ranges only<br/>client IP from X-Forwarded-For"]
    caddy --> nginx["web (nginx)<br/>CSP · static · SSE no-buffer · WS upgrade"]
    nginx --> api["api<br/>APP_ORIGIN=https://brain.adakpro.com<br/>__Host- Secure cookies"]
```

| فایل | کاربرد |
|---|---|
| `compose.yaml` | پایه؛ در حالت local فقط `127.0.0.1:8080` |
| `compose.production.yaml` | افزودن Caddy روی 80/443، حذف پورت web، کوکی Secure؛ `CADDYFILE` قابل انتخاب |
| `infra/docker/Caddyfile` | دامنهٔ مستقیم با Let's Encrypt |
| `infra/docker/Caddyfile.behind-cdn` | پشت ArvanCloud: allowlist، `trusted_proxies`، گواهی internal برای :443 |
| `compose.test.yaml` | پروفایل test با mock روی 8081 و volumeهای جدا |

| اسکریپت | کار |
|---|---|
| `bootstrap.sh` | بررسی Docker/Compose، ساخت secret **فقط اگر نباشد**، build و اجرا |
| `create-admin.sh` | ساخت مالک تعاملی (گذرواژه بدون echo)؛ `--reset-password` |
| `doctor.sh` | بررسی فقط‌خواندنی secretها، سلامت، پورت‌ها و ایزولاسیون runner |
| `backup.sh` / `restore.sh` | بخش ۱۵ |
| `update.sh` | backup → build → migrate → اجرا → doctor (بدون حذف volume) |
| `test.sh` | lint، typecheck، unit، integration، build، compose config، audit |

تنظیم لازم در ArvanCloud: رکورد A برای `brain` با مقدار IP سرور و پروکسی فعال؛ پروتکل origin ترجیحاً HTTP؛ عدم cache برای `/api/*` و `/health/*`؛ فعال‌بودن WebSocket.

---

## ۱۹. فناوری‌ها و نسخه‌ها

| لایه | فناوری | نسخه |
|---|---|---|
| Runtime | Node.js (image) | 22.23.3-bookworm-slim |
| مدیریت بسته | pnpm (corepack) | 10.18.3 |
| زبان | TypeScript (typecheck) + esbuild (bundle) | 7.0.2 / 0.28.2 |
| API | Fastify، cookie، multipart، websocket | 5.12.5 |
| DB / صف | PostgreSQL، pg، pg-boss | 17.6 / 8.23.1 / 12.37.0 |
| مدل | `@anthropic-ai/claude-agent-sdk` (CLI bundled) | 0.3.291 (Claude Code 2.1.291) |
| native | `@anthropic-ai/claude-code` رسمی، node-pty، ws | 2.1.291 / 1.1.0 / 8.22.0 |
| امنیت | @node-rs/argon2، otpauth، DOMPurify | 2.2.2 / 9.5.2 / 3.4.16 |
| محتوا | yaml، marked، diff، pdfjs-dist، Readability + linkedom | 2.9.1 / 18.1.0 / 9.0.0 / 6.4.299 / 0.6.0 |
| UI | React، react-router، TanStack Query، Vite، Cytoscape، xterm | 19.3.0 / 8.4.0 / 5.104.1 / 8.3.3 / 3.34.3 / 6.0.0 |
| edge | nginx-unprivileged، Caddy | 1.29.3-alpine / 2.10.2-alpine |

lockfileها: `pnpm-lock.yaml` و `apps/native-claude/package-lock.json`. هیچ `latest` در Dockerfile یا package.json نیست.

---

## ۲۰. راهبرد آزمون

```mermaid
flowchart LR
    unit["Unit · 55<br/>normalize · markdown · links · chunks<br/>paths · crypto · TOTP · zip · SSRF<br/>chat import · citations"] --> integ["Integration · 31<br/>real PostgreSQL + filesystem<br/>auth · roles · IDOR · ChangeSet<br/>crash recovery · rollback · backup/restore<br/>migrations · imports · production profile"]
    integ --> docker["Docker checks<br/>restart/recreate · DB outage<br/>runner & native isolation · ports<br/>WS ticket rules"]
    docker --> e2e["E2E (Playwright)<br/>login · ingest → review → apply<br/>cited answer · mobile 390px"]
    e2e --> live["Live on owner instance<br/>native sign-in · background<br/>subscription analysis"]
```

- mock هرگز به‌عنوان موفقیت اتصال واقعی گزارش نمی‌شود؛ آزمون زندهٔ API (C03) تا ثبت کلید مالک `blocked` است.
- نتیجهٔ هر شناسهٔ چک‌لیست پذیرش با وضعیت `passed`/`failed`/`blocked`/`not-run` و مسیر مدرک: `docs/TEST-REPORT.md`.
- benchmark روی ۱۰۰۰ صفحهٔ فارسی/انگلیسی: `evidence/tests/H06-benchmark.json`.

---

## ۲۱. محدودیت‌ها و مسیر آینده

| موضوع | وضعیت |
|---|---|
| مهارت‌های rename، merge، review، backfill، publish، changed-my-mind | پیاده نشده (در UI مشخص) |
| OCR، تبدیل صوت، خروجی PDF/DOCX | در دسترس نیست (501 / پیام صریح) |
| جست‌وجوی معنایی و پیشنهاد ارتباط معنایی | پیاده نشده؛ جست‌وجوی متنی فارسی فعال |
| ترجمهٔ انگلیسی رابط | فقط جهت layout تغییر می‌کند |
| پاسخ ارجاع‌دار بخش‌به‌بخش با اشتراک | فقط پیوند `[[صفحه]]`؛ citation اعتبارسنجی‌شده در مسیر API |
| آزمون HTTPS انتهابه‌انتها، backup/restore در Docker | ثبت‌شده به‌عنوان not-run در گزارش آزمون |
| arm64 | build/test نشده |

اسناد مرتبط: `docs/UPSTREAM-AUDIT.md`، `docs/FEATURE-MAP.md`، `docs/ADR/0001–0005`، `docs/CLAUDE-AUTH-DECISION.md`، `docs/THREAT-MODEL.md`، `docs/IMPLEMENTATION-STATUS.md`، `docs/TEST-REPORT.md`، `docs/CONTINUATION.md`.
