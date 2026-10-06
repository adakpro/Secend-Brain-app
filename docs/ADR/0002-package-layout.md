# ADR-0002 — ادغام بسته‌های سرور در `packages/core`

وضعیت: پذیرفته‌شده (2026-10-06)

ساختار پیشنهادی سند، بسته‌های جدای `auth`، `database`، `vault`، `search`، `agents`، `ui` و `test-fixtures` را پیشنهاد می‌کرد. برای کاهش هزینهٔ build و وابستگی‌های چرخه‌ای در نسخهٔ اول:

- `packages/contracts`: schemaهای zod و DTOهای مشترک فرانت/سرور (قرارداد API).
- `packages/core/src/{auth,database,vault,search,agents,ingest,crypto,net,changesets,...}`: همان مرزها به‌صورت پوشه‌های مستقل با `index.ts` جدا. وابستگی مجاز: `vault` ← `markdown`؛ `changesets` ← `vault`,`database`؛ هیچ ماژولی به `api` یا `worker` وابسته نیست.
- مؤلفه‌های UI داخل `apps/web/src/components` هستند (یک مصرف‌کننده).
- fixtureها در `packages/core/test/fixtures` و `e2e/fixtures`.

هر app با esbuild به یک فایل bundle می‌شود؛ ماژول‌های native (`@node-rs/argon2`، `pg`، `pg-boss`، `pdfjs-dist`) external و از lockfile نصب می‌شوند. `apps/native-claude` عمداً خارج از workspace است (lockfile جدا، build فقط داخل image خودش با toolchain برای `node-pty`) تا هیچ وابستگی‌ای با سرویس‌های اصلی مشترک نداشته باشد.
