# ADR-0003 — نگهداری API key و inference proxy خصوصی

وضعیت: پذیرفته‌شده؛ spike در `evidence/phase0/sdk-spike/` (2026-10-06)

## نگهداری

- envelope: `AES-256-GCM`، nonce تصادفی ۹۶ بیتی برای هر رمزنگاری، AAD = `provider_credentials.id|workspace-scope|v<keyVersion>`.
- keyring از فایل Docker secret `master_key` (JSON: `{"active":"k2","keys":{"k1":"base64","k2":"base64"}}` یا یک کلید base64 تکی که `k1` تلقی می‌شود). در هر restart تولید نمی‌شود؛ `scripts/bootstrap.sh` فقط اگر وجود نداشته باشد می‌سازد.
- چرخش: `create-admin.sh` نه؛ `scripts/rotate-master-key.sh` کلید جدید را active می‌کند و فرمان `cli rotate-credentials` همهٔ رکوردها را با کلید فعال دوباره رمز می‌کند (تست C04).
- API فقط `id`، `label`، `last4`، `fingerprint` (SHA-256 کوتاه‌شده)، وضعیت و تاریخ تست را برمی‌گرداند.
- master key فقط در `api` و `worker` mount می‌شود؛ نه در web، runner، postgres یا native.

## inference proxy

یافته‌های spike (SDK 0.3.291 / CLI 2.1.291) با `ANTHROPIC_BASE_URL` به یک سرور ثبت‌کننده:

1. CLI فقط `POST /v1/messages?beta=true` می‌فرستد؛ credential در header `x-api-key`.
2. با `tools: []` و MCP درون‌فرایندی، تنها ابزارهای مدل همان `mcp__vault__*` هستند (پیام `system/init`: `"tools":["mcp__vault__read_note"]`).
3. `outputFormat: json_schema` به یک ابزار `StructuredOutput` در درخواست تبدیل می‌شود.
4. `CLAUDE_CODE_MAX_RETRIES` تعداد retry را کم می‌کند (پیش‌فرض ۱۰ تلاش با backoff).
5. env زیرفرایند با گزینهٔ `env` کاملاً جایگزین می‌شود؛ بنابراین هر job محیط مستقل دارد و global env تغییر نمی‌کند.

طراحی:

- worker برای هر run یک **job token** تصادفی ۳۲ بایتی می‌سازد (فقط hash در DB، با `run_id`، مدل مجاز، سقف خروجی، سقف تعداد درخواست و انقضا).
- runner با `ANTHROPIC_BASE_URL=http://worker:8790/inference` و `ANTHROPIC_API_KEY=<job token>` اجرا می‌شود. کلید واقعی هرگز وارد runner نمی‌شود.
- proxy: فقط `POST /inference/v1/messages`؛ token معتبر و منقضی‌نشده؛ مدل باید با مدل مجاز run برابر باشد؛ `max_tokens` به سقف clamp می‌شود؛ اندازهٔ body محدود؛ headerها allowlist؛ کلید واقعی از DB رمزگشایی و فقط به `https://api.anthropic.com` فرستاده می‌شود؛ پاسخ stream بدون ذخیرهٔ متن عبور می‌کند و usage از رویداد `message_delta` برای حسابداری استخراج می‌شود.
- لغو run یا قطع اتصال API، token را فوراً باطل می‌کند.
- runner روی شبکهٔ `internal` است و هیچ مقصد دیگری ندارد.

## mock

حالت `MODEL_PROVIDER_MODE=mock` فقط وقتی `APP_PROFILE` برابر `test` یا `development` باشد پذیرفته می‌شود. در این حالت proxy به‌جای Anthropic یک «Messages API آزمایشی قطعی» را صدا می‌زند که SSE استاندارد تولید می‌کند و ابزارهای واقعی runner را فرامی‌خواند. خروجی آن با `provider: "mock"` برچسب می‌خورد و هرگز «اتصال واقعی» نامیده نمی‌شود. در `production` با نبود credential خطای `model_not_connected` برمی‌گردد (C09).
