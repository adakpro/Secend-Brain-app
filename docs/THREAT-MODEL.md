# مدل تهدید (نسخهٔ ۱)

دامنه: نصب شخصی تک‌مالک با Docker Compose، دسترسی از localhost یا اینترنت پشت HTTPS.

| # | دارایی / مرز | تهدید | کنترل | آزمون |
|---|---|---|---|---|
| T1 | ورود برنامه | حدس گذرواژه، credential stuffing | Argon2id (m=19456KiB,t=2,p=1)، محدودیت تلاش per-IP و per-username در DB، پیام یکسان، TOTP | B01, B02 |
| T2 | نشست | سرقت/تثبیت نشست | شناسهٔ ۳۲ بایتی، فقط hash در DB، چرخش پس از ورود، HttpOnly + SameSite=Lax + Secure در production، انقضای idle/absolute، logout-all | B03 |
| T3 | تغییر حالت | CSRF | توکن CSRF مرتبط با نشست در header + بررسی Origin/Sec-Fetch-Site؛ CORS خاموش | B02 |
| T4 | نقش محدود / workspace دیگر | IDOR | همهٔ کوئری‌ها با `workspace_id` از membership نشست؛ نقش در سرور؛ citation/graph/search/SSE هم فیلتر | B05, B06 |
| T5 | عملیات حساس | سوءاستفاده از نشست باز | step-up (گذرواژه/TOTP، اعتبار ۱۰ دقیقه) برای credential، terminal، کاربران، restore | B07 |
| T6 | API key | نشت در log/UI/queue/backup | رمزنگاری GCM، پاسخ masked، redaction در logger، key هرگز در payload صف یا runner | B08, C01 |
| T7 | runner | prompt injection → خواندن secret، ارسال بیرونی، تغییر raw | runner بدون DB/master key/vault/اینترنت؛ فقط ابزارهای MCP با scope همان job؛ `tools: []`، `permissionMode: dontAsk`، `settingSources: []`؛ خروجی فقط ChangeSet که سرور با schema و قواعد مسیر (منع raw/, .claude/, مسیر مطلق) اعتبارسنجی می‌کند | F13, C08 |
| T8 | URL fetcher | SSRF، DNS rebinding، redirect | فقط http/https، resolve و بررسی IP (loopback/private/link-local/metadata/IPv6 داخلی) در لحظهٔ اتصال با lookup سفارشی، سقف redirect/اندازه/زمان، منع credential در URL | E02, security |
| T9 | آپلود | zip-slip، zip-bomb، MIME جعلی، path traversal | magic-byte check، سقف اندازه، نام تصادفی، VaultService با realpath و منع symlink، پارس PDF در worker thread با timeout | E08 |
| T10 | Markdown/HTML | XSS | DOMPurify با allowlist، بدون SVG/iframe/script/style؛ CSP سخت در nginx؛ پیوست‌ها با `Content-Disposition: attachment` و `nosniff` | G12 |
| T11 | `.claude/` و hook داخل vault | اجرای کد نامطمئن | قرنطینه: هرگز به runner داده نمی‌شود؛ فقط فهرست برای مدیر | F14 |
| T12 | native terminal | hijack WebSocket، دسترسی به داده | ticket یک‌بارمصرف ۶۰ ثانیه‌ای + نشست + Origin + step-up؛ فقط فرمان‌های allowlist؛ کانتینر جدا بدون DB/vault/secret؛ بدون ثبت PTY | D06–D08 |
| T13 | backup | افشای credential | آرشیو بدون master key؛ رمزنگاری اختیاری با passphrase جدا؛ native auth خارج از backup | H02 |
| T14 | زنجیرهٔ تأمین | dependency آلوده | lockfile، نسخهٔ pin‌شده، `pnpm audit` در گزارش | H07 |

خارج از دامنهٔ نسخهٔ ۱: مهاجم با دسترسی root به میزبان، حملات سخت‌افزاری، رمزنگاری دیسک (راهنمای LUKS در README آمده است؛ permission فایل رمزنگاری نیست).
