# تصمیم اتصال Claude — دو مسیر مستقل

تاریخ بررسی اسناد: 2026-10-06. این سند مشاورهٔ حقوقی نیست؛ برداشت فنی از متن جاری اسناد رسمی است و پیش از هر انتشار باید دوباره بررسی شود.

## اسناد بررسی‌شده (نسخهٔ جاری همان روز)

- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/agent-sdk/typescript (Options)

## نقل‌قول‌های تعیین‌کننده

از Legal and compliance، بخش «Authentication and credential use»:

> Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> … Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above.

از همان سند، بخش «Can customers offer Claude Code in their products?»:

> The Claude Code binary must not be modified. … customers may not remove, disable, or restrict any authentication method built into it …
> Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential …

از Agent SDK overview:

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead.

از CLI reference: `claude auth status` «Show authentication status as JSON … Exits with code 0 if logged in, 1 if not … The JSON's `authMethod` field is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, or `third_party`». `claude auth login` و `claude auth logout` فرمان‌های رسمی ورود/خروج‌اند.

از Authentication: در container ممکن است مرورگر به callback محلی نرسد و کد ورود در خود ترمینال در `Paste code here if prompted` وارد شود. credential در لینوکس در `~/.claude/.credentials.json` (یا زیر `CLAUDE_CONFIG_DIR`) با mode `0600` نگهداری می‌شود.

## تصمیم

### مسیر ۱ — اتصال API (اتوماسیون محصول)

- تنها مسیر اجرای خودکار: ingest، query، studio، quiz، زمان‌بندی، worker و agent-runner.
- credential: API key خود مالک از Claude Console که در پنل مدیر ثبت و سمت سرور با AES-256-GCM رمز می‌شود (ADR-0003).
- مصرف به حساب API مالک صورتحساب می‌شود؛ محصول مصرف را واسطه‌گری یا بازفروش نمی‌کند.
- اشتراک Pro/Max هرگز اعتبار این مسیر فرض نمی‌شود.

### مسیر ۲ — محیط تعاملی رسمی (native-claude، profile اختیاری)

- مجاز تلقی شده **فقط** برای این حالت: خود مالک نصب، در ترمینال خصوصی وارد باینری **دست‌نخوردهٔ** Claude Code می‌شود و از آن مستقیم و تعاملی استفاده می‌کند. این دقیقاً حالتی است که سند با «an end user signing in to the unmodified Claude Code binary with their own Claude subscription» استثنا کرده است.
- پیش‌فرض: **غیرفعال** (Compose profile `native`). فعال‌کردن profile تصمیم مالک است و معادل مجوز Anthropic نیست.
- محصول هیچ فرم، iframe، cookie، OAuth جعلی یا client ID داخلی برای ورود ندارد. لینک و کد ورود فقط داخل PTY همان CLI ردوبدل می‌شود.
- وضعیت فقط با `claude auth status` (JSON) خوانده می‌شود؛ فقط `loggedIn`، `authMethod` و در صورت وجود ایمیل/سازمان نمایش داده می‌شود. فایل credential parse نمی‌شود.
- credential در volume اختصاصی `native-claude-home` می‌ماند؛ api/worker/agent-runner این volume را mount نمی‌کنند. در backup عادی نیست.
- این credential به صف خودکار، SDK، worker یا حساب دیگری وصل نمی‌شود (D10). موفقیت ورود native کارت API را «متصل» نشان نمی‌دهد (D03).

### موارد ردشده

- «Login with Claude» داخل محصول، proxy کردن توکن اشتراک، `claude setup-token` برای صف خودکار، کپی `~/.claude` میزبان: همه رد شده‌اند.
- adapter OAuth رسمی برای خود محصول: endpoint و scope رسمی برای محصول ثالث منتشر نشده؛ ساخته نمی‌شود و در UI دکمهٔ فعال ندارد.

## شرط ابهام

اگر استفاده از فراتر از «مالکِ خودمیزبان، استفادهٔ تعاملی خودش» برود (چند کاربر، ارائه به مشتری، اجرای خودکار با اشتراک)، profile `native` باید غیرفعال بماند تا مجوز رسمی جدا گرفته شود.

## بازنگری 2026-10-06 — تحلیل پس‌زمینه با اشتراک، به درخواست مالک

مالک API key ندارد و خواست تحلیل بدون نمایش ترمینال انجام شود. با بازخوانی اسناد رسمی: Authentication اجرای headless/اسکریپتی Claude Code با اشتراک خود کاربر را صریحاً پشتیبانی می‌کند (`claude -p`، و `claude setup-token` «برای CI و اسکریپت‌ها» با اشتراک). آنچه ممنوع است: ارائهٔ ورود claude.ai به کاربران یک محصول، هدایت درخواست‌های دیگران از طریق اشتراک، و جمع‌آوری/واسطه‌گری توکن.

پیاده‌سازی با این شروط:
- فقط با کلیک صریح مالک (Inbox/Source: «تحلیل با Claude»؛ Ask هنگام نبود API). بدون صف worker، بدون SDK، بدون زمان‌بندی و بدون تحلیل خودکار پس از آپلود.
- اجرا در کانتینر native با باینری رسمی دست‌نخورده: `claude -p` با login خود مالک؛ توکن هرگز خوانده یا از کانتینر خارج نمی‌شود.
- ابزارها: فقط Read/Edit/Write/Glob/Grep در staging؛ Bash و وب مسدود؛ `--permission-mode acceptEdits` (نه bypass).
- یک اجرا در هر لحظه؛ خروجی فقط از مسیر importer به ChangeSet و تأیید مالک.
- اگر استفاده فراتر از «مالک، برای خودش» برود (چند کاربر، مشتری، اجرای خودکار)، این مسیر باید خاموش شود و API key یا مجوز رسمی لازم است.

آزمون روی نصب اصلی: منبع مالک در ۷۱ ثانیه تحلیل شد؛ ۲۰ رویداد ابزار (Skill، Read، Glob، …) و ۶ پیشنهاد در مرکز بررسی؛ هیچ تغییری بدون تأیید اعمال نشد.
