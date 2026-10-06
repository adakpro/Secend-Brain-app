# نگاشت قابلیت‌ها (Feature Map)

وضعیت‌ها: **فعال** = مسیر واقعی پیاده و آزموده؛ **قطعی** = بدون مدل، با کد قطعی؛ **نیازمند credential** = کد آماده، اجرای زنده بدون کلید/حساب واقعی آزموده نشده؛ **پیاده نشده** = در UI با برچسب صادقانه، بدون دکمهٔ موفق نمایشی.

## صفحات

| صفحه / مسیر | سرویس و API | داده | دسترسی | آزمون | وضعیت |
|---|---|---|---|---|---|
| ورود `/login` | `POST /api/v1/auth/login` | users, sessions, login_attempts | عمومی | B01–B04 (integration) | فعال |
| خانه `/home` | `GET /workspaces/current/overview` | شمارش‌های واقعی؛ پیشنهادها از کوئری‌های قابل توضیح | viewer+ | smoke | فعال |
| ورودی‌ها `/inbox`، `/inbox/:id` | `/sources/*`، صف `source-extract` | sources, source_versions, search_chunks | viewer خواندن، member نوشتن | E01–E05, E08 (unit/integration) | فعال (URL/PDF/متن/چت) |
| کتابخانه `/library`، `/library/:id` | `/documents/*`، `/search` | documents, document_revisions, links | viewer/member | changesets.test (save conflict) | فعال |
| پرسش `/ask`، `/ask/:id` | `POST /ask`، `/runs/:id/events` (SSE)، `/conversations/*`، `/citations/:id` | conversations, messages, citations | viewer+ | smoke با mock؛ F10 unit | فعال؛ پاسخ مدل واقعی: نیازمند credential |
| پروژه‌ها `/projects`، `/projects/:id` | `/projects/*` | projects, tasks | member نوشتن | دستی | فعال |
| بررسی `/review`، `/review/:id` | `/changesets/*` | changesets, changeset_items, apply_journal | member تصمیم | F02, F04–F08 (integration) | فعال |
| نقشه `/graph` | `GET /graph` | links (resolved)، tags | viewer+ | دستی | فعال؛ پیشنهاد معنایی: پیاده نشده |
| استودیو `/studio`، `/studio/:id` | `/outputs/*` | outputs, output_versions, citations | member | دستی | قالب قطعی و export MD/HTML فعال؛ تولید با مدل نیازمند credential؛ PDF/DOCX پیاده نشده (501) |
| یادگیری `/learn` | `/learning/*` | quiz_items, quiz_attempts | viewer پاسخ، member تولید | دستی | تولید سؤال نیازمند credential (یا mock در test) |
| فعالیت `/activity` | `/activity`، `/health/knowledge`، `/schedules`، `/skills` | agent_runs, audit_events, schedules | viewer؛ زمان‌بندی admin | دستی | فعال |
| تنظیمات `/settings/:section` | `/me/*`، `/auth/*`، `/workspaces` | user_preferences, sessions, users | owner/admin برای بخش‌های مدیریتی | B03/B04 | فعال؛ ترجمهٔ انگلیسی رابط پیاده نشده (فقط جهت layout) |
| اتصال Claude `/settings/integrations/claude` | `/admin/integrations/claude/api/*`، `/admin/native-claude/*` | provider_credentials, native_tickets, native_staging | admin + step-up | C01, C02, B07 | API: فعال (آزمون زنده نیازمند کلید)؛ native: نیازمند ورود مالک |
| کاربران `/admin/users`، ممیزی `/admin/audit` | `/admin/users`، `/admin/audit` | users, memberships, audit_events | admin | B05 | فعال |
| پشتیبان `/admin/backups` | `/admin/backups/*` + CLI | backup_manifests, فایل‌ها | admin + step-up | H01 (integration) | فعال؛ restore فقط CLI |

## مهارت‌ها و فرمان‌ها (registry: `packages/core/src/agents/registry.ts`)

| مهارت upstream | mode | ابزارهای مجاز | وضعیت محصول |
|---|---|---|---|
| second-brain-ingest | propose | read_source, list_index, search_wiki, read_note, get_backlinks, propose_change | فعال (ChangeSet) |
| second-brain-query | read | list_index, search_wiki, read_note, get_backlinks | فعال (ارجاع اعتبارسنجی‌شده) |
| second-brain-report / write | read | همان | فعال در استودیو (نیازمند credential) |
| second-brain-quiz | read | همان | فعال (سؤال بدون نقل‌قول معتبر حذف می‌شود) |
| second-brain-chat-import | deterministic | — | parser قطعی سه قالب |
| second-brain-transcript | deterministic | — | فقط transcript متنی آماده؛ تبدیل صوت ندارد |
| second-brain-lint / graph / metrics | deterministic | — | گزارش قطعی؛ رفع خودکار ندارد |
| second-brain-project | deterministic | — | پروژه در DB با چهار بخش |
| second-brain-privacy | deterministic | — | برچسب حساسیت سمت سرور + حذف آگاهانه |
| second-brain-rename | — | — | **پیاده نشده** (registry: deterministic اما مسیر rename در apply ندارد؛ اصلاح در نسخهٔ بعد) |
| review, merge, backfill, publish, changed-my-mind | — | — | **پیاده نشده** (با برچسب در `/activity?tab=skills`) |

فرمان‌های slash در Command Palette (`Ctrl/⌘+K`، حالت «>») فقط مسیریابی یا باز کردن فرم‌اند؛ هیچ فرمان نوشتنی مستقیم از palette اجرا نمی‌شود. ۷۲ فایل `commands/*.md` upstream به‌صورت تک‌تک صفحه ندارند؛ فرمان‌های پرکاربرد به registry بالا نگاشت شده‌اند و بقیه در این نسخه پشتیبانی نمی‌شوند.

## تطبیق‌های لازم با SDK

- خروجی‌ها با `outputFormat: json_schema` (ابزار داخلی `StructuredOutput`) گرفته می‌شوند؛ در prompt از مدل خواسته شده متن پاسخ را پیش از آن بنویسد تا stream شود.
- دستورالعمل SKILL.md upstream بدون ابزارهای `Read/Write/Edit/Bash` اجرا می‌شود؛ معادل‌ها: `read_note`، `search_wiki`، `propose_change`. نسخهٔ هر مهارت در `agent_runs.skill_version` ثبت می‌شود.
- index.md و log.md توسط کد مورداعتماد هنگام apply ساخته می‌شوند، نه متن عامل.

## تحلیل و پرسش با اشتراک Claude (بدون API key)

| ورودی | مسیر | وضعیت |
|---|---|---|
| دکمهٔ «تحلیل با Claude» در `/inbox` و `/inbox/:id` (وقتی API وصل نیست و مالک در native وارد شده) | `POST /admin/native-claude/task {kind:'ingest'}` → staging کامل (صفحات، متن منابع در `raw/`، `CLAUDE.md`، ۱۸ مهارت، ۲۱ فرمان) → ترمینال Claude Code با فرمان `/ingest raw/<منبع>.md` **تایپ‌شده ولی ارسال‌نشده** → مالک Enter می‌زند → «پایان و ارسال برای بررسی» → importer → ChangeSet در `/review` | فعال؛ روی نصب اصلی تا مرحلهٔ پیش‌تایپ آزموده شد (ارسال به Claude توسط مالک) |
| دکمهٔ «پرسش با Claude Code» در `/ask` | `POST /admin/native-claude/task {kind:'ask'}` → `/ask <پرسش>` پیش‌تایپ | فعال؛ پاسخ فقط در ترمینال، در گفتگوهای برنامه ذخیره نمی‌شود |

هیچ اجرای خودکار، صف یا زمان‌بندی از اشتراک استفاده نمی‌کند؛ هر درخواست را خود مالک در ترمینال ارسال می‌کند.
