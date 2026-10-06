# گزارش آزمون پذیرش

قالب هر ردیف مطابق ACCEPTANCE-CHECKLIST: شناسه، وضعیت (`passed` | `failed` | `blocked` | `not-run`)، روش، مدرک و محدودیت.

**محیط:** Ubuntu 22.04 (kernel 5.15)، Intel Xeon E3-1275 v6 ‏۸ هسته، ۳۱GiB RAM، Docker 29.0.4، Compose 5.5.1، Node 22.23.3، PostgreSQL 17.6. ماشین مشترک بود (load average ۲۸–۳۳ هنگام آزمون‌ها)؛ اعداد زمان‌سنجی تحت این بار گرفته شده‌اند.

**تعریف مدرک‌ها:**
- *unit*: `npx vitest run --project unit` — بدون شبکه/DB.
- *integration*: `npx vitest run --project integration` — PostgreSQL واقعی (کانتینر موقت `sb-test-pg`)، فایل‌سیستم واقعی، Fastify `inject`.
- *docker*: آزمون روی stack واقعی Compose؛ تست‌های مخرب فقط روی stack جدای `secondbrain-test` (پروفایل test، ارائه‌دهندهٔ **mock**).
- *e2e*: Playwright (Chromium headless) روی `secondbrain-test` از طریق nginx/web.
- **mock هرگز موفقیت اتصال واقعی نیست.** آزمون‌هایی که با mock اجرا شده‌اند فقط مسیر کد (SDK واقعی + runner + proxy + tools + ChangeSet) را نشان می‌دهند، نه کیفیت یا اتصال مدل واقعی.

## A — نصب و پایداری

| ID | وضعیت | روش و مدرک | محدودیت |
|---|---|---|---|
| A01 | passed | `docker compose config` بدون مقدار secret: `evidence/docker/A01.txt` | |
| A02 | passed | نصب تازه با `scripts/bootstrap.sh` بدون API key؛ همهٔ سرویس‌ها healthy و `/login` ‏200: `evidence/phase1/bootstrap.log` | |
| A03 | passed | create-admin دوم با exit 2 رد شد؛ bootstrap دوباره secretها را عوض نکرد (hash قبل/بعد): `evidence/docker/A03-*` | |
| A04 | passed | شمارش ۹ جدول و ۱۴ فایل قبل/بعد از `restart` و `up -d --force-recreate` یکسان: `evidence/docker/A04-persistence.txt` | روی stack آزمون |
| A05 | passed | بدون کلید: `/health/ready` ok، `capabilities.modelFeatures=false` با دلیل؛ جست‌وجو/ویرایش فعال: `evidence/docker/A05-C09.txt` | |
| A06 | passed | توقف PostgreSQL: ready=503، restart=0؛ پس از start، ready=ok و job استخراج جدید پردازش شد: `evidence/docker/A06-db-outage.txt` | قطع ~۳۰ ثانیه |
| A07 | passed | فقط `web` روی `127.0.0.1:8080`؛ postgres/worker/runner/native بدون پورت میزبان: `evidence/docker/A07.txt` | |
| A08 | not-run | پیکربندی Caddy/HTTPS در `compose.production.yaml` نوشته شده؛ آزمون واقعی HTTPS هنوز اجرا نشده | |
| A09 | passed | سه migrator هم‌زمان روی DB خالی، هر migration یک بار؛ اجرای دوباره no-op و داده حفظ: integration `migrations.test.ts` | |

## B — ورود، نقش و محرمانگی

| ID | وضعیت | روش و مدرک | محدودیت |
|---|---|---|---|
| B01 | passed | hash با پیشوند `$argon2id$`، کوکی HttpOnly+SameSite=Lax، چرخش نشست پس از ورود: integration `api.test.ts` | Secure فقط در HTTPS (A08 not-run) |
| B02 | passed | پیام یکسان برای کاربر ناموجود/گذرواژهٔ غلط؛ بعد از ۸ شکست حتی گذرواژهٔ درست ۴۲۹؛ CSRF و Origin جعلی ۴۰۳: integration + smoke (`curl`) | |
| B03 | passed | logout، logout-all، تغییر گذرواژه (نشست جاری حفظ، بقیه لغو) و نشست منقضی: integration | یک باگ واقعی پیدا و رفع شد (لغو نشست جاری) |
| B04 | passed | TOTP اجباری، replay همان کد رد، recovery code یک‌بارمصرف و فقط hash ذخیره: integration | |
| B05 | passed | viewer: ساخت منبع ۴۰۳؛ member: admin/credential/native/backup ۴۰۳: integration | |
| B06 | passed | دسترسی با header فضای دیگر ۴۰۳؛ شناسهٔ سند/run/SSE فضای دیگر ۴۰۴؛ search/graph/ask بدون نشت: integration | |
| B07 | passed | ثبت کلید با step-up قدیمی ۴۰۳ `step_up_required`؛ step-up اشتباه ۴۰۱: integration | |
| B08 | passed (جزئی) | کلید در پاسخ/DB متن‌باز نیست؛ logger با redaction؛ lint برای الگوی کلید: integration C01 + `scripts/lint.mjs` | اسکن خودکار لاگ‌های همهٔ سرویس‌ها پس از اجرای واقعی با کلید انجام نشده (C03 blocked) |

## C — اتصال API مدل

| ID | وضعیت | روش و مدرک | محدودیت |
|---|---|---|---|
| C01 | passed | پاسخ فقط last4/fingerprint؛ GET بعدی کلید را برنمی‌گرداند؛ ciphertext در DB: integration | |
| C02 | passed | کلید جعلی به **api.anthropic.com واقعی** فرستاده شد و خطای واقعی گرفت (نه سبز ساختگی): integration | |
| C03 | **blocked** | نیازمند API key واقعی مالک با سقف هزینه؛ در گفتگو درخواست نشد | مالک از پنل ثبت کند و «آزمون تولید متن» را بزند |
| C04 | passed (کد) | unit: رمزگشایی پس از rotation keyring؛ `rotateToActiveKey` در CLI `rotate-credentials` | چرخش کامل روی stack Docker اجرا نشده |
| C05 | passed (کد) | disconnect توکن‌های اجرا را باطل می‌کند و اجرای جدید `model_not_connected` می‌گیرد؛ سیاست لغو اجراهای فعال در UI | آزمون Docker جدا ندارد |
| C06 | not-run | نگاشت 401/403/429/529/5xx و retry محدود در کد هست؛ آزمون خطای تزریقی ندارد | |
| C07 | passed (طراحی+کد) | env هر job جدا (گزینهٔ `env` SDK جایگزین کامل)، توکن per-run با مدل/سقف؛ spike: `evidence/phase0/sdk-spike` | آزمون موازی صریح دو job نوشته نشده |
| C08 | passed | runner: فقط `internal_token`؛ بدون DB/API/اینترنت (EAI_AGAIN/ENETUNREACH)؛ rootfs فقط‌خواندنی؛ فقط worker:8790: `evidence/docker/C08-runner-isolation.txt` | پوشه‌های خالی `/data` از base image حذف شدند (build بعدی) |
| C09 | passed | production بدون کلید: `/ask` حالت «جست‌وجوی متنی» با برچسب؛ `analyze` ‏409؛ mock در production با خطای startup رد می‌شود (`loadConfig`) | |

## D — ورود واقعی حساب در محیط تعاملی رسمی

| ID | وضعیت | روش و مدرک | محدودیت |
|---|---|---|---|
| D01 | passed | `docs/CLAUDE-AUTH-DECISION.md` با نقل‌قول اسناد جاری | |
| D02 | passed | مالک خودش با جریان رسمی `claude auth login` در ترمینال خصوصی وارد شد؛ `claude auth status`: `loggedIn:true, authMethod:claude.ai` (نصب اصلی، 2026-10-06) | |
| D03 | passed (جزئی) | کارت API و native جدا؛ native هیچ secret/credential محصولی ندارد و به worker/runner راه ندارد: `evidence/phase5/native-isolation.txt` | پس از ورود واقعی دوباره بررسی شود |
| D04 | passed | پس از recreate کانتینر native (به‌روزرسانی image) وضعیت ورود حفظ شد؛ credential فقط در volume `native-home`، در DB کپی نمی‌شود | |
| D05 | blocked | نیازمند ورود واقعی؛ مسیرهای close و logout جدا پیاده شده‌اند | |
| D06 | passed (جزئی) | Origin نامعتبر ۴۴۰۳، بدون کوکی ۴۴۰۱، ticket تکراری/منقضی/نشست دیگر ۴۴۰۱: `evidence/phase5/D06-ws-authorization.json` | باز شدن ترمینال معتبر پس از build جدید دوباره آزموده شود |
| D07 | passed (طراحی) | nginx فقط `$uri` بدون query لاگ می‌کند؛ سرویس native و api محتوای PTY را لاگ نمی‌کنند | grep لاگ پس از نشست واقعی not-run |
| D08 | passed | native بدون `/data`، بدون secret، بدون docker.sock؛ postgres/runner/worker غیرقابل دسترس: `evidence/phase5/native-isolation.txt` | |
| D09 | passed (جزئی) | staging روی نصب اصلی آماده شد (صفحات، متن منبع در raw/، ۱۸ مهارت، ۲۱ فرمان)؛ import بدون ویرایش هیچ ChangeSetی نساخت؛ مسیر تغییر واقعی در importer با snapshot پایه | import یک ویرایش واقعی از ترمینال هنوز توسط مالک انجام نشده |
| D10 | passed (طراحی) | credential native فقط در volume `native-home`؛ هیچ سرویس دیگری آن را mount نمی‌کند | |
| D11 | passed | پروفایل خاموش/سرویس قطع: کارت «سرویس در دسترس نیست» و دکمهٔ موفق نمایشی ندارد | |

## E — منبع، فایل و سازگاری

| ID | وضعیت | روش و مدرک | محدودیت |
|---|---|---|---|
| E01 | passed | متن فارسی byte-exact؛ hash ذخیره و فایل خام 0440؛ e2e ورود منبع فارسی | |
| E02 | passed (جزئی) | تشخیص login wall و 401/403؛ SSRF و redirect: unit | استخراج URL عمومی واقعی در Docker اجرا نشده |
| E03 | passed (کد) | PDF با pdfjs و صفحه‌بندی `\f`؛ کم‌متن → `needs_ocr` | fixture PDF واقعی اسکن‌شده در test نیست |
| E04 | passed | fixture و test برای `chat_messages`، `mapping` (شاخه فعال + گزارش شاخه)، `messages`، و قالب ناشناخته: unit | |
| E05 | passed | idempotency key منبع/run و تشخیص تکراری hash/URL کانونی؛ apply تکراری یک اثر: smoke + integration | |
| E06 | passed (کد) | پوشش استخراج و پوشش خواندن منبع در run؛ «پوشش ناقص» برچسب می‌خورد | آزمون فایل خیلی بزرگ not-run |
| E07 | passed (کد) | `no_external` از bundle، search مدل‌محور و export حذف می‌شود؛ analyze ‏409 | |
| E08 | passed | path traversal/absolute/symlink (unit)، zip-slip/symlink/zip-bomb (unit)، MIME ناسازگار ۴۱۵، قرنطینهٔ `.claude/` در import ZIP (integration) | |
| E09 | passed | round-trip frontmatter با کلید ناشناخته و comment؛ wikilink/alias/heading: unit | |
| E10 | passed | دو فایل هم‌نام → `ambiguous`؛ rename بیرونی فقط با hash یکسان یک‌به‌یک: unit + integration | |
| E11 | passed | ک/ك، ی/ي، نیم‌فاصله در جست‌وجو؛ متن اصلی ثابت: unit + backup restore search | |
| E12 | passed | ویرایش بیرونی کشف و save/apply قدیمی conflict: integration | |

## F — عامل، تغییرات و پاسخ مستند

| ID | وضعیت | روش و مدرک | محدودیت |
|---|---|---|---|
| F01 | passed (mock) / blocked (live) | مسیر کامل با SDK واقعی در کانتینر و ارائه‌دهندهٔ mock: e2e | کیفیت با مدل واقعی نیازمند C03 |
| F02 | passed | قبل از تأیید هیچ فایل canonical تغییر نکرد: integration | |
| F03 | passed | diff، منبع، revision پایه و stale در UI/API: e2e + integration | |
| F04 | passed | partial accept شکنندهٔ وابستگی رد؛ index/log از موارد پذیرفته: integration + smoke | |
| F05 | passed | سه apply هم‌زمان → یک اثر؛ apply تکراری idempotent: integration + smoke | |
| F06 | passed | ویرایش هم‌زمان کاربر → conflict بدون نوشتن: integration | |
| F07 | passed | crash پس از فایل اول و قبل از commit؛ بازیابی journal و apply دوباره: integration | |
| F08 | passed | rollback با وصلهٔ معکوس، ویرایش مستقل بعدی حفظ شد: integration | |
| F09 | passed (mock) | پاسخ با ارجاع کلیک‌پذیر، excerpt و revision: e2e | live blocked (C03) |
| F10 | passed | کلید ساختگی، نقل‌قول نامنطبق و نشانهٔ بدون ارجاع شناسایی: unit | |
| F11 | passed (mock) | «not covered» بدون منبع اختراعی در مسیر mock؛ prompt سورس | رفتار مدل واقعی not-run |
| F12 | not-run | ساختار `conflicts` در خروجی و UI هست؛ آزمون اختصاصی ندارد | |
| F13 | passed (مرز ابزار) | runner بدون secret/شبکه؛ ابزار نوشتن فقط مسیرهای wiki؛ سرور دوباره اعتبارسنجی می‌کند: C08 + unit validateAgentOps | آزمون injection با مدل واقعی not-run |
| F14 | passed | `settingSources: []`، `tools: []`، `.claude/` قرنطینه در reconcile و import ZIP: integration | |
| F15 | passed (جزئی) | لغو run و توکن باطل؛ اجرای قطع‌شده `interrupted` و خودکار تکرار نمی‌شود | آزمون بستن مرورگر در میانهٔ run not-run |
| F16 | passed | SSE فقط رویدادهای همان run/workspace و resume با Last-Event-ID؛ باگ `end` در کلاینت پیدا و رفع شد: integration (IDOR) + e2e | |

## G — رابط و قابلیت‌ها

| ID | وضعیت | روش و مدرک | محدودیت |
|---|---|---|---|
| G01 | passed | ۱۱ بخش + login/admin با route واقعی و deep-link؛ کاوش Playwright بدون خطای console: `evidence/screens/` | |
| G02 | passed (بازبینی دستی) | screenshot دسکتاپ 1536×1051 با `reference/previews/desktop.png` مقایسه شد | مقایسهٔ پیکسلی خودکار انجام نشد |
| G03 | passed | 390px و دسکتاپ، روشن/تاریک بدون overflow افقی: کاوش + e2e `@mobile` | عرض تبلت جدا آزموده نشد |
| G04 | passed (جزئی) | dialog بومی (focus trap، Escape)، label فرم‌ها، focus-visible، reduced motion | ممیزی screen reader و کنتراست با ابزار not-run |
| G05 | passed (جزئی) | تاریخ شمسی و ارقام فارسی با timezone کاربر؛ کد/مسیر LTR | ترجمهٔ انگلیسی UI پیاده نشده (فقط جهت layout) |
| G06 | passed | loading/empty/error/disconnected در همهٔ صفحات | |
| G07 | passed | پروژه/کار/پیشرفت پس از reload: e2e | |
| G08 | passed (جزئی) | قالب مستند و export Markdown/HTML: e2e | تولید با مدل واقعی blocked؛ PDF/DOCX پیاده نشده (501) |
| G09 | passed | لینک واقعی، برچسب مشترک (خط‌چین) و رابطهٔ پذیرفته جدا؛ پیشنهاد معنایی «در دسترس نیست» | |
| G10 | passed (کد) | آزمون فقط از run مدل با نقل‌قول معتبر؛ سؤال ثابت demo وجود ندارد | تولید واقعی blocked (C03) |
| G11 | passed | نصب تولیدی بدون seed؛ همهٔ آمارها از کوئری واقعی | |
| G12 | passed | DOMPurify با allowlist؛ CSP بدون inline script؛ پیوست با attachment + nosniff + sandbox | |

## H — بازیابی و تحویل

| ID | وضعیت | روش و مدرک | محدودیت |
|---|---|---|---|
| H01 | passed (کد) | backup رمزشده → restore روی نصب خالی؛ شمارش جدول‌ها و فایل‌ها برابر؛ دستکاری شناسایی شد: integration `backup.test.ts` | اجرای `scripts/backup.sh`/`restore.sh` روی Docker not-run |
| H02 | passed | master key، sessions و run tokens در آرشیو نیستند؛ native volume در backup نیست | |
| H03 | passed | پس از restore: sessions صفر، schedule متوقف، run صف‌شده `interrupted`: integration | |
| H04 | passed | fixture از `seedState()` خود مرجع + دادهٔ کاربر؛ preview شمارش و جداسازی demo؛ ورود demo به فضای واقعی ۴۰۹؛ یادداشت‌ها به‌صورت پیشنهاد: integration | |
| H05 | passed (کد) | claim اتمی slot، سیاست skip/run_once، بدون هم‌پوشانی | آزمون تغییر ساعت/restart worker not-run |
| H06 | passed (ثبت) | ۱۰۰۰ صفحه (۳۰۱۴ chunk): ایندکس ~۰٫۲۲ ثانیه/صفحه، reconcile ‏۱۱٫۵ ثانیه، جست‌وجو p50 ‏۳۲۴ms / p95 ‏۹۷۷ms تحت load ~۳۰: `evidence/tests/H06-benchmark.json` | ماشین مشترک و پربار؛ عدد تضمینی نیست |
| H07 | passed (جزئی) | lint سفارشی، typecheck، unit، integration، build و e2e با مدرک | ESLint عمومی نیست؛ `pnpm audit` در گزارش جدا |
| H08 | passed (جزئی) | README فارسی با دستورهای واقعی | دنبال‌کردن کامل README روی ماشین تازه توسط شخص دیگر not-run |
| H09 | passed | همین گزارش و `IMPLEMENTATION-STATUS.md` | |
