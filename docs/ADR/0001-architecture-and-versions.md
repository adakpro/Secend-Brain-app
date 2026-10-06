# ADR-0001 — معماری، سرویس‌ها و نسخه‌ها

وضعیت: پذیرفته‌شده (2026-10-06)

## تصمیم

monorepo با pnpm و TypeScript. سرویس‌های Docker:

| سرویس | نقش | شبکه‌ها | پورت میزبان |
|---|---|---|---|
| `web` | nginx: فایل‌های build فرانت + reverse proxy به `api` (همان origin) | `edge` | فقط `127.0.0.1:8080` (پیش‌فرض) |
| `api` | Fastify؛ احراز هویت، تنها writer canonical vault، SSE، WebSocket ترمینال | `edge`, `db`, `native` | ندارد |
| `worker` | pg-boss: صف، زمان‌بندی، inference proxy خصوصی | `db`, `agent`, `egress` | ندارد |
| `agent-runner` | Claude Agent SDK رسمی با ابزارهای محدود | فقط `agent` (internal) | ندارد |
| `postgres` | PostgreSQL 17 | `db` (internal) | ندارد |
| `migrate` | one-shot از image `api` با advisory lock | `db` | ندارد |
| `native-claude` | profile اختیاری `native`؛ باینری رسمی Claude Code در PTY | `native` (+ egress خودش) | ندارد |

شبکه‌های `db` و `agent` با `internal: true` ساخته می‌شوند؛ یعنی runner هیچ مسیر خروجی به اینترنت ندارد و فقط به worker (inference proxy) می‌رسد. این یک سیاست egress واقعی در سطح Docker است، نه firewall دامنه‌ای؛ worker برای رسیدن به `api.anthropic.com` شبکهٔ `egress` دارد و مقصد را در کد به allowlist ثابت محدود می‌کند.

## نسخه‌ها (pin‌شده؛ lockfile: `pnpm-lock.yaml`)

| جزء | نسخه | دلیل |
|---|---|---|
| Node.js | 22 (image `node:22.23-bookworm-slim`) | نیاز pg-boss 12 و react-router 8 (>=22.12/22.22) |
| pnpm | 10.18.3 (corepack) | |
| TypeScript | 7.0.2 | فقط typecheck؛ bundle با esbuild 0.28.2 |
| Fastify | 5.12.5 | |
| pg / pg-boss | 8.23.1 / 12.37.0 | صف پایدار روی همان PostgreSQL (بدون Redis) |
| PostgreSQL | `postgres:17.6-bookworm` | pg_trgm داخلی |
| `@anthropic-ai/claude-agent-sdk` | 0.3.291 | باینری Claude Code 2.1.291 همراه بستهٔ بهینهٔ `linux-x64` (manifest.json داخل بسته) |
| Claude Code (native profile) | 2.1.291 | از npm رسمی `@anthropic-ai/claude-code@2.1.291`؛ بدون patch |
| React / react-router / TanStack Query / Vite | 19.3.0 / 8.4.0 / 5.104.1 / 8.3.3 | |
| zod | 4.6.5 | peer مورد نیاز SDK |
| @node-rs/argon2 | 2.2.2 | Argon2id با باینری prebuilt (بدون toolchain) |
| فونت | `@fontsource/vazirmatn` 5.3.0 (OFL-1.1) | self-hosted؛ هیچ CDN بیرونی |

`latest` در هیچ Dockerfile یا package.json استفاده نشده است.

## پیامدها

- `depends_on` با `condition: service_healthy` و `service_completed_successfully` برای migrate؛ علاوه بر آن، api و worker اتصال DB را با backoff دوباره برقرار می‌کنند.
- نبود اتصال مدل روی `/health/ready` اثر ندارد؛ وضعیت provider مدل جدایی است (`/api/v1/system/status`).
