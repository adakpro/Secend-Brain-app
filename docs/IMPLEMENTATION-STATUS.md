# وضعیت پیاده‌سازی

تاریخ: 2026-10-06. جزئیات آزمون‌ها: `TEST-REPORT.md`. نگاشت قابلیت‌ها: `FEATURE-MAP.md`.

## فازها

| فاز | وضعیت | خلاصه |
|---|---|---|
| ۰ — بررسی و spike | انجام شد | upstream `d6861cc` (۱۸ مهارت، ۷۲ فرمان، ۶ عامل)؛ spike واقعی SDK 0.3.291 / CLI 2.1.291 با سرور ثبت‌کننده؛ تصمیم auth با نقل‌قول اسناد جاری؛ threat model؛ ADR 0001–0005. |
| ۱ — Compose، DB، auth، AppShell | انجام شد | ۷ سرویس، شبکه‌های internal، secrets، migration one-shot با قفل، Argon2id، نشست سروری، CSRF/Origin، TOTP/recovery، step-up، CLI ساخت مدیر، AppShell منطبق با مرجع. |
| ۲ — Vault، منابع، کتابخانه، جست‌وجو | انجام شد | VaultService امن (realpath/symlink/traversal)، revision و optimistic concurrency، reconcile مبتنی بر hash، تغییرنام بیرونی محافظه‌کار، منابع متن/URL/PDF/چت، جست‌وجوی فارسی. |
| ۳ — API مدل، worker، runner، ingest/query، ChangeSet | انجام شد (live blocked) | کارت API رمزشده، proxy خصوصی با توکن per-run، runner ایزوله با SDK رسمی، ingest به ChangeSet، apply با journal و بازیابی crash، rollback، query با ارجاع اعتبارسنجی‌شده و SSE. اجرای زنده با کلید واقعی: blocked. |
| ۴ — پروژه، استودیو، نقشه، یادگیری، سلامت، زمان‌بندی | انجام شد (با استثنا) | پروژه با چهار بخش، استودیو (قالب قطعی + تولید با مدل + export MD/HTML)، گراف Cytoscape با انواع رابطه، آزمون مستند، lint/graph قطعی، زمان‌بندی با claim اتمی. |
| ۵ — native Claude Code | پیاده‌سازی شد؛ ورود واقعی blocked | سرویس ایزولهٔ بدون secret، باینری رسمی 2.1.291، ترمینال با ticket تک‌مصرف، status/logout رسمی، staging و importer. ورود واقعی نیازمند مالک. |
| ۶ — hardening، backup، مهاجرت، مستندات | عمدتاً انجام شد | backup سازگار (snapshot + قفل)، رمزنگاری اختیاری، restore فقط CLI با dry-run، import نسخهٔ HTML و vault ZIP، export قابل حمل، README فارسی، گزارش آزمون. HTTPS واقعی (A08) هنوز اجرا نشده. |

## پیاده‌نشده یا محدود (صریح)

- مهارت‌های rename، merge، review، backfill، publish، changed-my-mind (در UI با برچسب «پیاده نشده»).
- OCR، تبدیل صوت، خروجی PDF/DOCX (قابلیت «در دسترس نیست» با 501).
- جست‌وجوی معنایی/embedding و پیشنهاد ارتباط معنایی در گراف.
- ترجمهٔ انگلیسی رابط (گزینهٔ زبان فقط جهت layout را عوض می‌کند).
- ویرایش cron/سیاست زمان‌بندی موجود (فقط روشن/خاموش/حذف/ساخت).
- لینک مستقیم صفحهٔ کتابخانه به پروژه (فقط منابع و خروجی‌ها).
- ممیزی خودکار accessibility/کنتراست و مقایسهٔ پیکسلی screenshot.
- آزمون روی arm64.

## موانع بیرونی

- **C03 / F01 live / F09 live / G10 live:** نیازمند API key واقعی که مالک باید از پنل ثبت کند (در گفتگو درخواست نشد).
- **D02 / D04 / D05:** ورود واقعی حساب در native نیازمند تعامل خود مالک در ترمینال است.

## نسخه‌ها

| جزء | نسخه |
|---|---|
| Node.js (image) | 22.23.3-bookworm-slim |
| pnpm | 10.18.3 |
| TypeScript | 7.0.2 |
| Fastify | 5.12.5 |
| pg / pg-boss | 8.23.1 / 12.37.0 |
| PostgreSQL | 17.6-bookworm |
| @anthropic-ai/claude-agent-sdk | 0.3.291 (Claude Code 2.1.291 bundled) |
| @anthropic-ai/claude-code (native) | 2.1.291 |
| React / react-router / TanStack Query / Vite | 19.3.0 / 8.4.0 / 5.104.1 / 8.3.3 |
| nginx-unprivileged / Caddy | 1.29.3-alpine / 2.10.2-alpine |
| zod / yaml / marked / DOMPurify / cytoscape / xterm | 4.6.5 / 2.9.1 / 18.1.0 / 3.4.16 / 3.34.3 / 6.0.0 |

lockfileها: `pnpm-lock.yaml` و `apps/native-claude/package-lock.json`.

## باگ‌های واقعی که آزمون‌ها پیدا کردند و رفع شدند

1. deadlock بین `FOR UPDATE` روی ChangeSet و FK journal روی اتصال دوم → `FOR NO KEY UPDATE`.
2. abort فوری SDK چون رویداد `close` درخواست پس از خواندن body رخ می‌دهد → `close` پاسخ.
3. تغییر گذرواژه نشست جاری را هم لغو می‌کرد.
4. restore بی‌صدا rollback می‌شد چون خطای داخل تراکنش با `.catch` بلعیده شده بود.
5. وارد کردن ستون generated در restore.
6. import چرخشی `NAV` که در bundle تولیدی کل برنامه را از کار می‌انداخت.
7. حذف رویداد `end` در SSE کلاینت (dedupe با lastEventId).
8. timeout وضعیت native چون هر فراخوانی CLI ۴–۸ ثانیه طول می‌کشد → cache کوتاه‌مدت.
9. فایل‌های بازنویسی index/link تک‌سطری (کارایی) → درج و به‌روزرسانی دسته‌ای.
