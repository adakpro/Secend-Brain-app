# ADR-0005 — مرز اعتماد سرویس native-claude

وضعیت: پذیرفته‌شده (2026-10-06)

## تصمیم

- سرویس `native-claude` فقط با `--profile native` اجرا می‌شود و **هیچ secret محصول** ندارد: نه DB password، نه master key، نه internal token، نه API key. علت: کاربر در این سرویس یک CLI تعاملی با ابزار Bash اجرا می‌کند؛ هر فایلی که در کانتینر خواندنی باشد عملاً در اختیار آن نشست است. پس چیزی برای نشت وجود ندارد.
- شبکه‌ها: `native` (internal؛ اعضا فقط `api` و `native-claude`) و `native-egress` (برای رسیدن CLI به سرویس‌های Anthropic). به `db`، `agent` و `edge` وصل نیست؛ Docker socket، vault، sources و backups mount نمی‌شوند.
- volumeها: `native-home` (HOME و credential خود CLI) و `native-staging` (کپی کاری صفحات). api، worker و runner این volumeها را ندارند و پشتیبان عادی آن‌ها را شامل نمی‌شود.
- احراز هویت کاربر در `api` انجام می‌شود: نشست برنامه + نقش admin + step-up اخیر + ticket تک‌مصرف ۶۰ ثانیه‌ای مختص همان نشست + Origin برابر `APP_ORIGIN`. سرویس native به اتصال‌های شبکهٔ داخلی اعتماد می‌کند؛ تنها عضو دیگر آن شبکه api است.
- فرمان‌ها ثابت‌اند: `claude auth login`، `claude` (در `/workspace`)، `claude auth status`، `claude auth logout`. مرورگر فرمان نمی‌فرستد.
- وضعیت فقط از خروجی JSON `claude auth status` با allowlist فیلدها (`loggedIn`, `authMethod`, ایمیل/سازمان در صورت وجود) خوانده می‌شود؛ فایل credential خوانده یا parse نمی‌شود.
- هیچ متن PTY، کلیدفشاری یا کد ورود در لاگ‌ها نیست؛ nginx مسیر را بدون query string ثبت می‌کند (ticket در لاگ نمی‌ماند).
- staging → canonical فقط از مسیر importer مورداعتماد در api: اعتبارسنجی مسیر، frontmatter، مقایسه با snapshot پایهٔ ثبت‌شده در DB و revision فعلی، سپس ChangeSet با origin=`native_import` که کاربر بررسی و اعمال می‌کند. حذف در staging هرگز اعمال نمی‌شود.

## پیامد

نشست native می‌تواند به `api:3000` درخواست بفرستد (همان سطح دسترسی اینترنت عمومی به برنامه؛ نیازمند نشست). می‌تواند endpointهای خود سرویس native را صدا بزند (ورود/خروج حساب خود مالک) که در محدودهٔ همان مالک است.
