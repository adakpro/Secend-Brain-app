# وضعیت ادامهٔ کار (handoff)

آخرین به‌روزرسانی: 2026-10-06 (جلسهٔ اول). هیچ secret یا token در این فایل نیست.

## محل‌ها

- محصول: `/app/david/brain/second-brain-app` (git init شده؛ هنوز commit نشده — کاربر درخواست commit نکرده است).
- بستهٔ مشخصات: `/app/david/brain/second-brain-implementation-kit` (دست‌نخورده).
- کلون upstream برای بررسی: `/app/david/brain/second-brain-upstream` (commit `d6861cc`). نسخهٔ vendor‌شده: `vendor/second-brain-os/`.

## سرویس‌های در حال اجرا روی این ماشین

به درخواست کاربر (2026-10-06): **همهٔ محیط‌های آزمون خاموش شدند و کار فقط روی نصب اصلی ادامه دارد.**

| stack | وضعیت | نکته |
|---|---|---|
| `secondbrain` (اصلی، production profile) | در حال اجرا روی `127.0.0.1:8080` | مالک: `info@adakpro.com` (workspace «ADAK»). گذرواژه را کاربر در `.env` گذاشته؛ هرگز چاپ یا commit نشود و پیشنهاد شده پس از کار حذف شود. روی این stack آزمون مخرب اجرا نکن. |
| `secondbrain-test` | **متوقف** (`stop`؛ volumeها باقی) | راه‌اندازی دوباره فقط با اجازهٔ کاربر. |
| `sb-test-pg` | **متوقف/حذف** (`--rm`) | برای integration test دوباره با `scripts/test.sh` ساخته می‌شود. |
| smoke محلی و vite | **متوقف** | |

## فرمان‌های کلیدی و نتیجهٔ آخر

- `npx vitest run --project unit` → 55 passed.
- `npx vitest run --project integration` → 23 passed (DB واقعی).
- `npx playwright test` (BASE_URL=8081, E2E_EMAIL/E2E_PASSWORD) → در حال تکمیل؛ آخرین وضعیت در `docs/TEST-REPORT.md`.
- `node scripts/lint.mjs` → 0 problem.
- `docker compose build` ← کند (export لایه‌ها روی دیسک این ماشین ۱۵–۳۰ دقیقه).

## کارهای باقی‌مانده (به ترتیب)

1. پس از build سوم (`evidence/phase1/rebuild3.log`): `docker compose -p secondbrain-test -f compose.yaml -f compose.test.yaml --profile native up -d` و اجرای دوبارهٔ `e2e/native-ws.mjs` (D06) و Playwright کامل.
2. آزمون HTTPS محلی با `compose.production.yaml` (`DOMAIN=localhost TLS_ISSUER=internal`) روی project جدا و پورت‌های غیر 443 (A08).
3. اجرای `scripts/backup.sh` / `restore.sh` روی stack آزمون (H01 در سطح Docker؛ در سطح کد passed است).
4. benchmark (H06) و `pnpm audit` (H07).
5. موارد پیاده‌نشده: rename/merge/review/backfill/publish/changed-my-mind، import JSON نسخهٔ HTML (H04)، import ZIP vault، export ZIP قابل حمل، ترجمهٔ انگلیسی UI، OCR، PDF/DOCX export.

## موانع بیرونی

- C03 (درخواست زندهٔ موفق مدل): **blocked** — کلید API واقعی در اختیار نیست؛ مالک باید از پنل ثبت کند.
- D02/D04/D05 (ورود واقعی حساب در native): **blocked: requires owner sign-in** — ورود باید توسط خود مالک در ترمینال انجام شود.
