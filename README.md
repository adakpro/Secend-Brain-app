# Second Brain OS — نسخهٔ خودمیزبان (Docker)

فضای دانش شخصی فارسی و راست‌چین که منابع را به صفحات ویکی مرتبط تبدیل می‌کند، هر تغییر هوشمند را پیش از اعمال به تأیید تو می‌رساند و از دانش خودت با ارجاع نسخه‌دار پاسخ می‌دهد. منطق از مخزن [second-brain-os](https://github.com/undefined-ui/second-brain-os) (commit `d6861cc`, MIT) و ظاهر از HTML مرجع همین بسته گرفته شده است.

> این برنامه محصول Anthropic نیست. «Claude» و «Claude Code» نام‌های Anthropic هستند.

## پیش‌نیازها

- لینوکس x86-64 با Docker Engine ‏۲۴ به بالا و Docker Compose v2.20+ (آزموده‌شده: Docker 29.0.4، Compose 5.5.1).
- اینترنت برای build (npm، Docker Hub) و برای اتصال به Anthropic یا OpenAI.
- حدود ۶ گیگابایت فضای دیسک برای imageها (اندازه‌های واقعی: api ‏545MB، worker ‏519MB، agent-runner ‏796MB، web ‏83MB، native-claude اختیاری 1.16GB). حافظه و CPU در `docs/TEST-REPORT.md` (بخش H06) گزارش شده‌اند؛ عدد تضمینی وجود ندارد.
- معماری arm64 build/test **نشده** است.

## نصب تازه (local)

```bash
cd second-brain-app
./scripts/bootstrap.sh        # بررسی Docker، ساخت secretها فقط اگر نباشند، build و اجرا
./scripts/create-admin.sh     # ساخت مالک به‌صورت تعاملی (گذرواژه در TTY و بدون نمایش)
```

سپس `http://127.0.0.1:8080` را باز کن و با همان ایمیل و گذرواژه وارد شو. هیچ حساب پیش‌فرضی وجود ندارد؛ ثبت‌نام عمومی هم وجود ندارد.

`bootstrap.sh` فایل‌های `secrets/db_password`، `secrets/master_key` و `secrets/internal_token` را **فقط اگر وجود نداشته باشند** می‌سازد و `.env` را از `.env.example` کپی می‌کند. هیچ فایل موجودی را بازنویسی نمی‌کند.

**مهم:** همان لحظه از `secrets/master_key` یک نسخه بیرون از این سرور نگه دار. بدون آن، کلید API ذخیره‌شده و رمز TOTP پس از بازیابی قابل رمزگشایی نیستند.

## سرویس‌ها

| سرویس | نقش | پورت میزبان |
|---|---|---|
| `web` | nginx: فایل‌های فرانت + reverse proxy به api (همان origin) | `127.0.0.1:8080` |
| `api` | منطق محصول، احراز هویت، تنها نویسندهٔ vault | — |
| `worker` | صف (pg-boss)، استخراج، زمان‌بندی، inference proxy خصوصی | — |
| `agent-runner` | اجرای Claude Agent SDK یا عامل OpenAI Responses با ابزارهای محدود؛ فقط روی شبکهٔ داخلی بدون اینترنت | — |
| `postgres` | PostgreSQL 17 | — |
| `migrate` | one-shot: migration و schema صف | — |
| `native-claude` | اختیاری (`--profile native`): باینری رسمی Claude Code یا Codex (انتخاب با NATIVE_CLI_MODE) | — |

## اتصال API مدل (پس از ورود)

برنامه بدون کلید هم کامل بالا می‌آید: ورود، کتابخانه، ویرایش دستی، جست‌وجوی متنی، پروژه‌ها، خروجی Markdown/HTML و پشتیبان کار می‌کنند. قابلیت‌های مدل (تحلیل منبع، پاسخ مستند، تولید پیش‌نویس، آزمون) تا اتصال API غیرفعال‌اند و این را صریح نشان می‌دهند.

1. در Claude Console (`platform.claude.com` › API Keys) یک کلید بساز.
2. در برنامه: **تنظیمات › اتصال‌ها › اتصال Claude** (`/settings/integrations/claude`)، کارت «اتصال API».
3. کلید را در فرم وارد کن (تأیید دوبارهٔ هویت لازم است). کلید فقط به سرور همین نصب می‌رود، با AES-256-GCM رمز می‌شود و دیگر نمایش داده نمی‌شود.
4. «آزمون اعتبار و مدل‌ها (بدون هزینه)» را بزن؛ فهرست مدل‌ها از خود Anthropic خوانده می‌شود. یکی را انتخاب و سقف‌های مصرف را تنظیم کن.
5. «آزمون تولید متن» هزینه‌دار است و فقط با تأیید صریح اجرا می‌شود.

قطع اتصال در برنامه فقط نسخهٔ محلی را پاک می‌کند؛ برای ابطال واقعی، کلید را در Claude Console غیرفعال/حذف کن.

## اتصال OpenAI و Codex

دو مسیر مستقل پشتیبانی می‌شوند: **OpenAI API** برای تحلیل منبع، پاسخ مستند، استودیو، آزمون و زمان‌بندی؛ و **Codex CLI** برای کار مالک در staging. انتخاب ارائه‌دهنده در سطح نصب است؛ تغییر آن کلید ارائه‌دهندهٔ قبلی را حذف نمی‌کند.

برای API، در `.env` مقدار زیر را تنظیم کن و سرویس‌ها را بازسازی کن:

```dotenv
MODEL_PROVIDER_MODE=openai
```

```bash
docker compose up -d --build
```

سپس **تنظیمات › اتصال‌ها › اتصال API OpenAI / Claude** (`/settings/integrations/model`) را باز کن. کلید را از [OpenAI API Keys](https://platform.openai.com/api-keys) بگیر، ذخیره و اعتبارسنجی کن، مدل را انتخاب کن و نرخ توکن ورودی/خروجی آن را به USD برای یک میلیون توکن از [قیمت رسمی](https://developers.openai.com/api/docs/pricing) وارد کن. نرخ‌ها را با تغییر مدل به‌روز کن. فهرست مدل‌ها فقط دسترسی کلید را نشان می‌دهد؛ مدل باید از Responses API و function calling پشتیبانی کند. «آزمون تولید متن» یک درخواست هزینه‌دار با سقف ۲۵۶ توکن است؛ کامل‌نشدن خروجی موفقیت محسوب نمی‌شود.

کلید OpenAI با همان AES-256-GCM ذخیره می‌شود و فقط API/worker آن را رمزگشایی می‌کنند. runner تنها توکن کوتاه‌عمر هر اجرا را می‌گیرد. درخواست‌ها با `store:false` به [Responses API رسمی](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create) فرستاده می‌شوند. ابزارها همان ابزارهای محدود دانش و پیشنهاد تغییر هستند؛ تأیید انسانی پیش از اعمال حفظ شده است. هزینه بر اساس نرخ‌های واردشده، بدون تخفیف کش، تخمین زده می‌شود؛ پیش از درخواست رزرو محافظه‌کارانه انجام می‌شود. اگر پاسخ شبکه از دست برود، رزرو هزینه حفظ می‌شود. صورتحساب قطعی را در OpenAI بررسی کن.

برای Codex در `.env`:

```dotenv
NATIVE_CLI_MODE=codex
CODEX_VERSION=0.162.1
```

```bash
docker compose --profile native up -d --build api native-claude
```

نام سرویس و endpointهای `native-claude` برای سازگاری حفظ شده‌اند؛ در این حالت باینری رسمی `@openai/codex` اجرا می‌شود. در کارت محیط رسمی، «بازکردن محیط رسمی ورود» دستور `codex login --device-auth` را باز می‌کند؛ لینک و کد را خود CLI نمایش می‌دهد. سپس staging را آماده و Codex را باز کن. راهنمای workspace در `AGENTS.md` و مهارت‌ها در `.agents/skills/` قرار می‌گیرند. تغییرات از «آماده‌سازی تغییرات برای بررسی» وارد مرکز بررسی می‌شوند. وظیفه‌های شروع‌شده با کلیک مالک از `codex exec --json` استفاده می‌کنند؛ صف خودکار همچنان به API نیاز دارد. [راهنمای رسمی دستورها](https://developers.openai.com/codex/cli/reference)، [اجرای غیرتعاملی](https://developers.openai.com/codex/noninteractive).

Codex با sandbox `workspace-write`، جست‌وجوی وب غیرفعال و شبکهٔ دستورهای عامل غیرفعال اجرا می‌شود. credential و staging آن volumeهای جدا از Claude دارند؛ credential CLI در پشتیبان عادی نیست. اشتراک ChatGPT یا ورود Codex، اتصال و اعتبار API را فعال نمی‌کند. برای بازگشت به Claude، `NATIVE_CLI_MODE=claude` را تنظیم و سرویس native را بازسازی کن. مسیر قدیمی `/settings/integrations/claude` همچنان کار می‌کند.

## محیط تعاملی رسمی Claude Code (اختیاری)

این قابلیت با کارت API فرق دارد: خودت در یک ترمینال خصوصی وارد باینری رسمی و دست‌نخوردهٔ Claude Code می‌شوی و مستقیم از آن استفاده می‌کنی. ورود اشتراک (Pro/Max) به صف خودکار برنامه وصل نمی‌شود و کارت API را «متصل» نشان نمی‌دهد. مبنای تصمیم: `docs/CLAUDE-AUTH-DECISION.md`.

```bash
docker compose --profile native up -d native-claude
```

سپس در همان صفحه، کارت «محیط تعاملی رسمی»: «بازکردن محیط رسمی ورود» → تأیید هویت → ترمینال `claude auth login` باز می‌شود. لینک ورود را خود CLI چاپ می‌کند؛ اگر کد خواست، همان‌جا در ترمینال وارد کن. برنامه هیچ گذرواژه، کوکی یا کدی جمع نمی‌کند.

- کار دستی روی دانش در **staging** است: «آماده‌سازی staging» نسخه‌ای از صفحات را کپی می‌کند؛ پس از بستن ترمینال، «آماده‌سازی تغییرات برای بررسی» تغییرات را به بستهٔ پیشنهادی در مرکز بررسی تبدیل می‌کند. vault اصلی مستقیم تغییر نمی‌کند.
- «بستن ترمینال» نشست PTY را می‌بندد؛ «خروج از حساب Claude» دستور رسمی `claude auth logout` را اجرا می‌کند.
- credential این محیط فقط در volume `native-home` می‌ماند، در پشتیبان عادی نیست و پس از بازیابی باید دوباره وارد شوی.
- برای رمزنگاری at-rest این volume، دیسک میزبان را رمز کن (مثلاً LUKS برای `/var/lib/docker`). permission فایل رمزنگاری نیست.

## اولین منبع

1. «افزودن» در نوار بالا: متن یا Markdown فارسی، نشانی وب عمومی، PDF متن‌دار، یا JSON خروجی گفتگو (قالب‌های `chat_messages`، `mapping`، `messages`).
2. منبع استخراج و نمایه می‌شود (`/inbox`). با اتصال API، «تحلیل و ساخت پیشنهاد» را بزن.
3. در «بررسی تغییرات» (`/review`) تفاوت‌ها را ببین، در صورت نیاز متن را ویرایش یا بخشی را انتخاب کن و «اعمال» را بزن. index و log را خود برنامه به‌روز می‌کند.
4. در «پرسش از دانش» (`/ask`) بپرس؛ هر ادعا به بخش مشخصی از یک صفحه ارجاع دارد.

PDF اسکن‌شده وضعیت `needs_ocr` می‌گیرد (OCR فعال نیست)؛ می‌توانی «متن جایگزین» وارد کنی.

## HTTPS و سرور اینترنتی

```bash
# در .env:
APP_ORIGIN=https://brain.example.com
DOMAIN=brain.example.com
ACME_EMAIL=you@example.com
SB_PRODUCTION=1 ./scripts/bootstrap.sh     # از compose.production.yaml (Caddy + Let's Encrypt) استفاده می‌کند
```

در این حالت کوکی‌ها `Secure` و `__Host-` هستند و فقط Caddy پورت‌های 80/443 را منتشر می‌کند؛ `web` دیگر روی میزبان منتشر نمی‌شود. اگر TLS را بیرون (load balancer) قطع می‌کنی، `APP_ORIGIN` را با https تنظیم کن، `APP_BIND=127.0.0.1` را نگه دار و `TRUST_PROXY` را فقط به IP پراکسی خودت محدود کن. پروفایل production بدون HTTPS روی origin غیر-localhost بالا نمی‌آید.

## لاگ و عیب‌یابی

```bash
./scripts/doctor.sh                       # بررسی فقط-خواندنی: secretها، سلامت، پورت‌ها، شبکهٔ runner
docker compose logs -f api worker         # لاگ JSON بدون متن منبع/گفتگو و بدون secret
docker compose ps
```

دستورهای مخرب مثل `docker compose down -v` را در عیب‌یابی اجرا نکن؛ volumeها (پایگاه داده، vault، منابع، پشتیبان‌ها) را حذف می‌کنند.

## پشتیبان و بازیابی

```bash
./scripts/backup.sh               # پشتیبان سازگار → backups/sb-backup-<زمان>.zip
./scripts/backup.sh --encrypt     # با گذرواژهٔ جدا (scrypt + AES-256-GCM)
./scripts/restore.sh backups/sb-backup-<زمان>.zip
```

- پشتیبان شامل پایگاه داده (در یک snapshot)، vault و فایل‌های خام منابع است، با manifest و checksum. نشست‌ها، توکن‌های اجرا و کلید اصلی در آن نیستند.
- `restore.sh` ابتدا اعتبارسنجی (dry-run) می‌کند، سپس نام فایل را برای تأیید می‌خواهد. دادهٔ فعلی پاک نمی‌شود؛ به `.pre-restore-*` منتقل می‌شود. پس از بازیابی همهٔ نشست‌ها تمام می‌شوند، زمان‌بندی‌ها متوقف می‌مانند و اجراهای ناتمام دوباره ارسال نمی‌شوند.
- برای بازیابی روی سرور جدید، `secrets/master_key` قبلی را پیش از `bootstrap.sh` در `secrets/` بگذار.
- پشتیبان روی همان دیسک یا Git، پشتیبان واقعی نیست؛ فایل را به مقصد دیگری منتقل کن.

«خروجی قابل حمل» (export) چیز دیگری است: Markdown صفحات و خروجی‌ها، بدون credential و نشست.

## به‌روزرسانی

```bash
git pull   # یا جایگزینی فایل‌های نسخهٔ جدید
./scripts/update.sh    # پشتیبان → build → migrate → اجرا → doctor
```

migrationها رو به جلو هستند. بازگشت به نسخهٔ قدیمی = checkout نسخهٔ قبلی + `restore.sh` با پشتیبانی که `update.sh` گرفته است.

## آزمون‌ها

```bash
./scripts/test.sh            # lint/typecheck، unit، integration (PostgreSQL موقت)، build
./scripts/test.sh e2e        # Playwright روی stack آزمایشی (compose.test.yaml، ارائه‌دهندهٔ mock)
```

نتیجهٔ واقعی آخرین اجرا: `docs/TEST-REPORT.md`. حالت mock فقط در پروفایل test/development مجاز است و خروجی‌اش همه‌جا «آزمایشی» برچسب می‌خورد.

## اسناد

`docs/UPSTREAM-AUDIT.md`، `docs/FEATURE-MAP.md`، `docs/ADR/`، `docs/CLAUDE-AUTH-DECISION.md`، `docs/THREAT-MODEL.md`، `docs/IMPLEMENTATION-STATUS.md`، `docs/TEST-REPORT.md`، `docs/CONTINUATION.md`.

### اجرای تحلیل‌ها با Codex

با `NATIVE_CLI_MODE=codex`، پروفایل `native` و `MODEL_EXECUTION=codex`، تحلیل منابع، پاسخ مستند، تولید متن و آزمون از حساب واردشدهٔ ChatGPT در Codex استفاده می‌کنند و کلید API لازم نیست. مدیر می‌تواند در «تنظیمات › اتصال مدل › مدل اجرای تحلیل‌ها» مسیر Codex یا API را انتخاب کند؛ اتصال API اختیاری است و خودکار جایگزین Codex نمی‌شود.

اجرای خودکار فقط بستهٔ دادهٔ مجاز همان اجرا را به Codex می‌دهد؛ داده‌های `no_external` کنار گذاشته می‌شوند. خروجی ساختاریافته، مسیر پیشنهادها و نقل‌قول‌ها پیش از ثبت اعتبارسنجی می‌شوند و تغییرات ویکی همچنان نیاز به بررسی انسانی دارند. محدودیت مصرف حساب ChatGPT اعمال می‌شود؛ هزینهٔ API برای این اجراها محاسبه نمی‌شود.
