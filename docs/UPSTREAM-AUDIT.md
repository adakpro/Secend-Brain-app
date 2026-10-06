# بررسی مخزن مبنا (Upstream Audit)

- مخزن: `https://github.com/undefined-ui/second-brain-os`
- commit مبنا: `d6861ccde4c483afa8c4805373ee447f1e87b33c` (2026-09-29, «State the course/handbook contract and split the duplicated ground»)
- تاریخ بررسی: 2026-10-06
- مجوز: MIT (`vendor/second-brain-os/LICENSE`) — متن مجوز همراه هر بخش واردشده حفظ شده است.
- مدرک: `evidence/phase0/upstream-commit.txt`، checksum فایل‌های واردشده: `vendor/second-brain-os/SHA256SUMS` (۱۲۸ فایل).

## ماهیت مخزن

مخزن یک «کتاب‌راهنما + قالب vault + مهارت‌ها/فرمان‌ها/عامل‌های Claude Code» است. backend، API، احراز هویت یا وب‌اپ ندارد. منطق محصول در قالب متن Markdown (SKILL.md و commands/*.md) و چند اسکریپت Python آمده است. بنابراین این پروژه منطق را **بازپیاده‌سازی** کرده، نه اینکه کد اجرایی آماده‌ای را کانتینری کند.

## شمارش از همین commit (نه از حافظه)

| بخش | تعداد | فرمان شمارش |
|---|---|---|
| مهارت‌ها `skills/*/SKILL.md` | ۱۸ | `ls skills \| grep -v README \| wc -l` |
| فرمان‌ها `commands/*.md` (بدون README) | ۷۲ | `ls commands \| grep -v README \| wc -l` |
| عامل‌ها `agents/*.md` (بدون README) | ۶ | `ls agents \| grep -v README \| wc -l` |
| اسکریپت‌ها `scripts/*.py` | ۶ | — |

افزونهٔ `plugins/agents-course` (۵ مهارت آموزشی) ابزار مغز دوم نیست و وارد نشده است.

## فایل‌های واردشده به `vendor/second-brain-os/`

`LICENSE`، `README.md`، `vault-template/` (CLAUDE.md، templates، wiki/index.md، wiki/log.md، projects/example-project)، `skills/`، `commands/`، `agents/`، `scripts/`. پوشه‌های `docs/`، `resources/`، `tools/` و HTMLهای سایت وارد نشده‌اند (محتوای آموزشی، نه منطق محصول).

## نحوهٔ استفاده در محصول

| منبع upstream | استفاده در محصول |
|---|---|
| `vault-template/CLAUDE.md` | قرارداد صفحات (frontmatter، چهار نوع wiki، قواعد لینک، log/index) در `packages/core/src/vault/contract.ts` و prompt سیستم runner. |
| `vault-template/templates/*.md` | قالب صفحات جدید در ingest (source/concept/entity/synthesis). |
| `skills/second-brain-ingest` | prompt و schema خروجی ingest؛ خروجی به‌جای نوشتن مستقیم، `ChangeSet` است. |
| `skills/second-brain-query` | prompt query؛ شروع از index scope‌دار و پیمایش لینک با بودجه؛ «Read / Not covered». |
| `skills/second-brain-{report,write,quiz,lint,graph,review,project,rename,merge,privacy,backfill,chat-import,transcript,metrics,publish,changed-my-mind}` | registry مهارت (`packages/core/src/agents/registry.ts`) با mode، ابزار مجاز و وضعیت پیاده‌سازی واقعی. |
| `agents/*.md` (ingestor, linker, researcher, reviewer, curator, graph-analyst) | نگاشت به mode اجرا: read-only یا propose-only. ابزارهای `Write/Edit/Bash` upstream به ابزار `propose_change` محدود شده‌اند. |
| `scripts/chat_export_to_md.py` | منطق در TypeScript بازنویسی شد (`packages/core/src/ingest/chat-import.ts`) با پشتیبانی واقعی از `mapping` (درخت ChatGPT) که اسکریپت اصلی نداشت. |
| `scripts/link_check.py`, `graph_export.py`, `vault_stats.py` | منطق در `vault/links.ts` و `graph.ts` بازنویسی شد؛ resolve مسیردار و نام‌های تکراری که اسکریپت اصلی نداشت اضافه و تست شد. Python در runtime اجرا نمی‌شود. |

## محدودیت‌ها و تفاوت‌های ثبت‌شده

1. upstream فرض می‌کند عامل مستقیم روی فایل‌ها می‌نویسد (`Write/Edit`). در محصول هیچ اجرای عامل canonical را تغییر نمی‌دهد؛ خروجی فقط پیشنهاد است (MASTER-PROMPT §11).
2. `chat_export_to_md.py` قالب `mapping` را فقط با `content.parts` تخت می‌کند و ترتیب/شاخه را مدیریت نمی‌کند. parser محصول شاخهٔ فعال (`current_node`) را دنبال و شاخه‌های دیگر را گزارش می‌کند.
3. `link_check.py` لینک `[[folder/name]]` و دو فایل هم‌نام را ابهام‌زدایی نمی‌کند؛ resolver محصول برای ابهام وضعیت `ambiguous` برمی‌گرداند.
4. نوع `note` در HTML مرجع وجود دارد ولی در قرارداد wiki نیست؛ نگاشت: پوشهٔ `notes/` به‌عنوان افزونهٔ مستند محصول (ADR-0004).
5. upstream دربارهٔ `.claude/` داخل vault فرض اعتماد دارد؛ محصول آن را قرنطینه می‌کند (فقط نمایش به مدیر، بدون بارگذاری در runner: `settingSources: []`).
