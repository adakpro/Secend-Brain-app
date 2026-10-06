# ADR-0004 — Vault، مدل داده و پروتکل apply

وضعیت: پذیرفته‌شده (2026-10-06)

## محل داده

- canonical vault: volume `vault-data` در `/data/vault/<workspace-slug>/` با ساختار upstream (`raw/`, `wiki/{sources,concepts,entities,synthesis}`, `wiki/index.md`, `wiki/log.md`, `projects/`, `output/`) به‌علاوهٔ `notes/` برای یادداشت دستی (نوع `note` مرجع HTML؛ افزونهٔ مستند محصول، نه نوع پنجم wiki).
- فایل‌های خام آپلود و artifactهای استخراج: volume `source-data` (`/data/sources/<workspace>/<sha256>/…`). فایل raw پس از ورود فقط‌خواندنی است؛ اصلاح متن یک SourceVersion جدید می‌سازد.
- PostgreSQL: حساب، نشست، صف، runها، ChangeSet، citation، revisionهای سند (متن کامل هر revision برای diff/rollback/citation)، تنظیمات و audit.
- بازسازی‌پذیر: جدول `search_chunks` (ایندکس) و `links`. **غیرقابل بازسازی از Markdown**: حساب‌ها، نشست‌ها، credentialها، تاریخچهٔ ChangeSet، citationها، audit، پروژه/task، چت‌ها.

## شناسهٔ پایدار

`documents.id` (UUID) شناسهٔ پایدار است. برای فایل‌های vault واردشده frontmatter بازنویسی نمی‌شود؛ نگاشت مسیر↔شناسه در جدول `documents` (sidecar در DB) است. تغییرنام بیرونی فقط وقتی همان سند تلقی می‌شود که hash محتوا دقیقاً برابر باشد و یک‌به‌یک باشد؛ در غیر این صورت «حذف + سند جدید» با هشدار ثبت می‌شود (E10).

## خواندن در برنامه

UI و runner محتوا را از `document_revisions` جاری (DB) می‌خوانند، نه از دیسک. بنابراین در طول apply خوانندگان برنامه حالت نیمه‌اعمال‌شده را نمی‌بینند؛ تعویض revision جاری در یک تراکنش DB انجام می‌شود. Obsidian یا ابزار بیرونی ممکن است در فاصلهٔ کوتاه بین rename فایل‌ها حالت میانی را ببیند (محدودیت مستند).

## پروتکل apply

1. `pg_advisory_xact_lock(workspace)` + کلید idempotency روی ChangeSet (`apply_key` یکتا).
2. بررسی permission و `base_hash` همهٔ فایل‌های درگیر در برابر revision جاری DB **و** hash دیسک؛ ناسازگاری ← `409 conflict` بدون هیچ نوشتن.
3. ثبت `apply_journal` (status=`prepared`) شامل محتوای قبل/بعد هر فایل در DB (commit جدا).
4. برای هر فایل: نوشتن `.<name>.sb-tmp` در همان پوشه، `fsync`، `rename` اتمی؛ ثبت گام در journal.
5. تراکنش نهایی: revisionهای جدید، `documents.current_revision`، ایندکس، وضعیت ChangeSet=`applied`، journal=`committed`.
6. بازیابی هنگام startup: journalهای `prepared` ← فایل‌هایی که hash دیسکشان برابر `after` است به `before` بازگردانده می‌شوند (roll back)، فایل‌های ایجادشده حذف، journal=`rolled_back` و ChangeSet به `approved` (قابل apply مجدد) برمی‌گردد. فایل موقت باقی‌مانده پاک می‌شود. (تست F07)

rollback یک ChangeSet = ChangeSet معکوس جدید که فقط وقتی خودکار قابل اعمال است که hash فعلی هر فایل برابر hash «بعد» همان بسته باشد؛ اگر کاربر بعداً همان فایل را ویرایش کرده باشد، inverse با diff سه‌طرفه روی همان بخش اعمال می‌شود و در صورت تداخل conflict برمی‌گرداند (F08). `git reset` استفاده نمی‌شود.
