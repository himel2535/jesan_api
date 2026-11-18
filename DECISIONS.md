# DECISIONS.md

সিদ্ধান্ত ও ভার্সনের খাতা। নতুন সিদ্ধান্ত নিচে যোগ হবে, তারিখসহ।

## ২০২৬-১১-১৬: শুরুর কাঠামো

### Node.js: 22 LTS (প্রপোজালের 26 LTS নয়)

- প্রপোজাল (সেকশন ৪) Node 26 LTS চেয়েছিল। কিন্তু ডেভেলপারের Mac macOS 12.7.6-এ আটকে আছে (ওই Mac-এর শেষ সংস্করণ, আপডেট করা যায় না), তাই **Node 22 LTS** নেওয়া হয়েছে। লোকাল: v22.23.5, ক্লাউড: v22.23.4, npm 10.9.9।
- `.nvmrc` = `22`, `package.json` engines = `node >=22.12` (Vitest 5 চায় `^22.12.0`, ESLint 10 চায় `^22.13.0`)।
- Mac বদলালে বা সার্ভারে deploy-এর সময় Node 24/26-এ যাওয়া হবে। `@types/node` সেজন্য 22.x-এ রাখা, তখন একসাথে বাড়বে।

### TypeScript: 6.0.3 (সর্বশেষ 7.0.2 নয়)

- `typescript-eslint@8.72.2`-এর peer `typescript >=4.8.4 <6.1.0`, আর `@nestjs/cli@12.0.13` নিজে `typescript ~6.0.2` ব্যবহার করে। TS 7 নিলে `--force` লাগত, যা নীতিতে নিষেধ।
- typescript-eslint ও Nest CLI TS 7 সাপোর্ট দিলে আপগ্রেড।

### Prisma (এখন install হয়নি, শুধু নোট)

- npm-এ `prisma`-র `latest` ট্যাগ = `8.0.0-rc.33` (**RC, নেওয়া যাবে না**)। Stable = **7.10.1** (`prisma`-র `prev` ট্যাগ; `@prisma/client`-এর `latest` = 7.10.1)।
- install-এর সময়: `npm install prisma@7 @prisma/client@7`। Prisma 8 GA হলে তবেই আপগ্রেড।

### টেস্ট: Vitest 5 + SWC (Jest/ts-jest নয়)

- প্রপোজাল অনুযায়ী। NestJS-এর DI-র জন্য decorator metadata লাগে, Vitest-এর ডিফল্ট transformer তা দেয় না, তাই `unplugin-swc` + `@swc/core`।

### অন্যান্য

- Env ভ্যালিডেশন `@nestjs/config`-এর `validate` + class-validator দিয়ে (DTO-র একই লাইব্রেরি, বাড়তি dependency নয়)। ভুল মানে অ্যাপ চালু হয় না।
- API path: global prefix `api` + URI versioning, ডিফল্ট `v1` → `/api/v1/...`।
- `CORS_ORIGIN` কমা দিয়ে একাধিক origin নিতে পারে।
- Health endpoint `src/core/health`-এ (ব্যবসা-নিরপেক্ষ), কোনো I/O করে না।
- `package.json`-এ ভার্সন exact pin (caret ছাড়া), যাতে লোকাল ও ক্লাউড হুবহু এক থাকে। আপগ্রেড হবে সচেতনভাবে, `npm outdated` দেখে।
- Build: `nest build` (tsc)। `module`/`moduleResolution` = `nodenext` (TS 6-এ পুরনো `node` resolution deprecated)।

### ভার্সন তালিকা (npm registry-র `latest` ট্যাগ থেকে যাচাই, কোনো RC/beta নেই)

| প্যাকেজ | ভার্সন | নোট |
|---|---|---|
| @nestjs/core, common, platform-express, testing | 12.5.0 | |
| @nestjs/config | 12.1.1 | |
| @nestjs/cli, @nestjs/schematics | 12.0.13 | |
| typescript | 6.0.3 | latest 7.0.2, উপরের কারণ |
| class-validator / class-transformer | 0.15.1 / 0.5.1 | |
| reflect-metadata / rxjs | 0.2.2 / 7.8.2 | |
| vitest | 5.1.0 | |
| unplugin-swc / @swc/core | 2.0.0 / 1.16.22 | |
| supertest / @types/supertest | 7.3.2 / 7.2.1 | |
| eslint / @eslint/js / typescript-eslint | 10.15.0 / 10.0.1 / 8.72.2 | |
| eslint-config-prettier / prettier / globals | 10.1.8 / 3.10.1 / 17.14.0 | |
| @types/node / @types/express | 22.20.5 / 5.0.6 | @types/node latest 26.6.6, Node 22-এর সাথে মেলানো |

### macOS 12.7.6-এ নেটিভ বাইনারি: যাচাই সম্পন্ন (২০২৬-১১-১৬)

নিচের প্যাকেজগুলো আগে থেকে compile করা নেটিভ বাইনারি আনে (শুধু dev/test tool, production runtime-এ নয়)। ডেভেলপারের Mac-এ (macOS 12.7.6, Node v22.23.5, npm 10.9.9) যাচাই হয়েছে: `npm install` সফল, `npm test`-এ ১১টা টেস্ট পাস, `npm run start:dev` চালু এবং watch mode কাজ করছে।

| প্যাকেজ | কোন কমান্ডে লাগে | অবস্থা |
|---|---|---|
| `@swc/core` 1.16.22 | `npm test` | macOS 12.7.6-এ যাচাই সম্পন্ন |
| `rolldown` (Vite 8 → Vitest-এর ভেতরে) | `npm test` | macOS 12.7.6-এ যাচাই সম্পন্ন |
| `fsevents` (macOS-only, optional) | `npm run start:dev`, `vitest` watch | macOS 12.7.6-এ যাচাই সম্পন্ন |

`lightningcss` Vite 8-এর dependency হিসেবে install হয় (Mac-এ install সফল), কিন্তু এই repository-তে CSS প্রসেসিং নেই বলে কখনো চলে না। এর আসল যাচাই হবে frontend (`jesan-web`)-এ।

### জানা সমস্যা

- `npm audit`: ৭টা moderate, সবই dev-only (`typescript-eslint` → `minimatch`)। সর্বশেষ typescript-eslint-এও ঠিক হয়নি; প্রস্তাবিত "fix" হলো পুরনো ভার্সনে নামা, তাই করা হয়নি। `npm audit --omit=dev` = ০। পরের রিলিজে আবার দেখা হবে।

## ২০২৬-১১-১৬: CI ও কাজের ধরন

- GitHub Actions (`.github/workflows/ci.yml`): প্রতিটা PR ও `main`-এ push-এ lint, type-check, test, build। Node ভার্সন `.nvmrc` থেকে পড়া হয়, যাতে লোকাল, ক্লাউড ও CI এক থাকে। `actions/checkout@v7`, `actions/setup-node@v7` (সর্বশেষ major)। Workflow-এর অনুমতি শুধু `contents: read`।
- Merge পদ্ধতি: চেক সবুজ হলে `main`-এ squash merge, তারপর branch মুছে ফেলা (মালিকের নির্দেশ, `CLAUDE.md`-র "কাজের ধরন")।

## ২০২৬-১১-১৬: Git branch নিয়ম

- প্রতিটা কাজে `main` থেকে নতুন নামের branch (`claude/<কাজের-নাম>`); পুরনো branch পুনরায় ব্যবহার নয়, force push নয়, `main`-এ সরাসরি push নয়। কারণ: squash merge-এর পর পুরনো branch-এর ইতিহাস `main`-এর সাথে মেলে না, তাই পুনরায় ব্যবহার করতে গেলে force push বা অগোছালো merge লাগে; নতুন branch-এ সেই ঝুঁকি নেই এবং প্রতিটা PR ছোট ও পরিষ্কার থাকে।
- ক্লাউড সেশনের অনুমতিতে remote branch মোছা আটকাতে পারে (প্রথম PR-এ 403 এসেছিল), তাই মোছা না গেলে রিপোর্টে জানানো হবে।

## ২০২৬-১১-১৬: ডাটাবেস ও core টেবিল (Step 2)

### ভার্সন (exact pin, কোনো RC নয়)

| প্যাকেজ | ভার্সন | নোট |
|---|---|---|
| prisma | 7.10.1 | `latest` ট্যাগ = `8.0.0-rc.34` (RC), তাই `prev` ট্যাগের stable |
| @prisma/client / @prisma/adapter-pg | 7.10.1 / 7.10.1 | |
| pg / @types/pg | 8.23.1 / 8.23.1 | |
| PostgreSQL | 18 (CI ও Neon) | 19-এর GA ১৯ নভেম্বর ২০২৬; GA ও Neon সাপোর্ট এলে বিবেচনা। ক্লাউড ডেভ কন্টেইনারে 16.15, migration-এ ভার্সন-নির্দিষ্ট কিছু নেই |

### Prisma 7-এর সাজানো (নিজে চালিয়ে যাচাই করা)

- Connection URL `schema.prisma`-তে নয়, `prisma.config.ts`-এ। এতে `directUrl` নেই, তাই ভাগটা এমন: CLI/migration পড়ে `DIRECT_URL` (না থাকলে `DATABASE_URL`), আর অ্যাপ runtime-এ `PrismaPg` driver adapter পড়ে `DATABASE_URL` (pooled)।
- Generator `prisma-client`, `moduleFormat = "cjs"`, আউটপুট `src/generated/prisma` (gitignore; `postinstall`-এ `prisma generate`, কারণ Prisma 7-এ `migrate dev` আর নিজে generate করে না)।
- `.env` লোড হয় Node-এর নিজস্ব `process.loadEnvFile` দিয়ে; `dotenv` dependency যোগ করা হয়নি।
- Pool: সর্বোচ্চ ১০ connection, connection timeout ৫ সেকেন্ড। Neon-এর সীমা দেখে deploy ধাপে ঠিক করা হবে।

### টেবিলের সিদ্ধান্ত (মালিকের অনুমোদিত)

- এখন ৪টা টেবিল: `businesses`, `users`, `roles`, `user_business_access`। `permissions`, `settings`, `audit_logs`, `document_counters` নিজ নিজ ধাপে, কারণ ব্যবহার ছাড়া কাঠামো আন্দাজ করতে হতো।
- ID: UUID v7 (অনুমান করা যায় না, সময়ক্রমে সাজানো বলে index-এ দ্রুত)। Prisma অ্যাপে তৈরি করে, তাই PostgreSQL 16-এও চলে।
- `users`: `email` ও `phone` দুটোই nullable ও unique; CHECK `users_email_or_phone_check` অন্তত একটা বাধ্য করে। লগইন পরে দুটোর যেকোনোটা দিয়ে।
- `users_email_lowercase_check`: email ছোট হাতের অক্ষরে রাখতে বাধ্য করে, যাতে `A@x.com` ও `a@x.com` দুটো আলাদা অ্যাকাউন্ট না হয় (নিজের ছোট সিদ্ধান্ত)। লগইন/ইউজার তৈরির কোডে email lowercase করে পাঠাতে হবে।
- CHECK constraint Prisma schema-তে লেখা যায় না, তাই migration SQL-এ হাতে যোগ করা। `db:check` এগুলো তুলনা করে না; টেস্ট এগুলো আসল ডাটাবেসে যাচাই করে।
- রোলের সংজ্ঞা সব ব্যবসায় এক; একজনের প্রতি ব্যবসায় একটাই রোল (`unique(user_id, business_id)`), ব্যবসাভেদে আলাদা হতে পারে।
- `organizations` টেবিল নেই: প্ল্যাটফর্ম শুধু Jesan Enterprise-এর। প্রতিষ্ঠানের নাম পরে Settings-এ।
- `businesses.type` varchar (enum নয়), যাতে নতুন template-এ migration না লাগে; মান module manifest-এর সাথে মিলিয়ে অ্যাপে যাচাই হবে।
- সব foreign key `ON DELETE RESTRICT`: কোনো cascade delete নেই। নিষ্ক্রিয় করতে `is_active`।
- সময়: `timestamptz(3)`। নাম: টেবিল ও কলাম snake_case, কোডে camelCase।
- `Decimal(14,3)`: এই চার টেবিলে পরিমাণ বা টাকার কলাম নেই। প্রথম পরিমাণের কলামে (Product/Stock) প্রয়োগ হবে; টাকায় Decimal, float নয়।

### businessId দিয়ে ডেটা আলাদা রাখার নকশা (পরের ধাপে বাস্তবায়ন)

- এই চারটা প্ল্যাটফর্ম-স্তরের টেবিল। পরের প্রতিটা ব্যবসা-ডেটার টেবিলে `business_id` not null FK, এবং প্রতিটা composite index `business_id` দিয়ে শুরু।
- Prisma Client extension প্রতিটা query-তে `businessId` বসাবে ও যাচাই করবে, না থাকলে error। `businessId` আসবে `BusinessAccessGuard` থেকে request context-এ।
- extension ও guard এখন বানানো হয়নি, কারণ এখনো ব্যবসা-ডেটার টেবিল বা লগইন নেই।

### Health

- `GET /api/v1/health`: liveness, কোনো I/O নয়, সবসময় 200, যাতে হোস্টিং ডাটাবেসের সমস্যায় অ্যাপ রিস্টার্ট না করে।
- `GET /api/v1/health/ready`: ডাটাবেস `up` → 200, `down` → 503, URL না থাকলে `not_configured` → 200। চেক: ২ সেকেন্ড timeout-সহ `SELECT 1`।
- `NODE_ENV=production`-এ `DATABASE_URL` বাধ্যতামূলক; ডেভ ও টেস্টে ঐচ্ছিক।

### Seed ও টেস্ট

- Seed `prisma/seed.mjs`: খাঁটি JavaScript + `pg` (`ON CONFLICT DO NOTHING`), যাতে TypeScript runner বা বাড়তি নেটিভ বাইনারি না লাগে। `src/core`-এ নয়, কারণ core-এ ব্যবসার নাম নিষেধ। `businesses.config`-এর গঠন (একক, প্রিন্সিপাল সাপ্লায়ার) সাময়িক; dealership module বানানোর সময় চূড়ান্ত হবে।
- ডাটাবেস-টেস্ট `DATABASE_URL` থাকলে চলে; না থাকলে লোকালে বাদ পড়ে, কিন্তু CI-তে (`CI` সেট) ব্যর্থ হয়, যাতে চুপচাপ বাদ পড়ে সবুজ না হয়।
- CI: `postgres:18` service; `db:deploy` (খালি ডাটাবেসে) → `db:check` → lint → type-check → test → build।

### macOS 12.7.6-এ যাচাই সম্পন্ন (২০২৬-১১-১৬)

| প্যাকেজ | কোন কমান্ডে লাগে | অবস্থা |
|---|---|---|
| `@prisma/engines` (schema engine) | `npm run db:deploy`, `db:migrate`, `db:status`, `db:check` | macOS 12.7.6-এ যাচাই সম্পন্ন |

ডেভেলপারের Mac-এ (macOS 12.7.6) সব ধাপ সফল: `npm install` (শেষে `prisma generate`), Neon dev branch-এ `npm run db:deploy`, `npm run db:seed`, `npm run start:dev`, এবং `/api/v1/health/ready` → `database: up`। README-র "macOS 12-এ `npm run db:deploy` ব্যর্থ হলে" অংশের বিকল্প পথ দরকার পড়েনি; ভবিষ্যতে সমস্যা হলে কাজে লাগবে বলে রাখা হয়েছে।

## ২০২৬-১১-১৬: লগইন, রোল ও অনুমতি (Step 3a)

### ভার্সন (exact pin, npm `latest` ট্যাগ, কোনো RC নয়)

| প্যাকেজ | ভার্সন | নোট |
|---|---|---|
| @node-rs/argon2 | 2.2.2 | পাসওয়ার্ড hashing; নিচের "পাসওয়ার্ড লাইব্রেরি" দেখুন |
| @nestjs/jwt | 12.0.5 | access token |
| @nestjs/throttler | 6.8.0 | লগইনে rate limit (NestJS 12 সাপোর্ট করে) |
| cookie-parser / @types/cookie-parser | 1.4.7 / 1.4.10 | |
| helmet | 8.3.0 | নিরাপত্তা header |

Passport নেওয়া হয়নি: গার্ড নিজে লেখা, কম dependency।

### পাসওয়ার্ড লাইব্রেরি: `@node-rs/argon2` (প্ল্যানের `argon2` প্যাকেজ নয়)

- প্ল্যানে `argon2` 0.45.2 ছিল, সাথে শর্ত ছিল "macOS 12-এ না চললে বিকল্প"। প্যাকেজ পরীক্ষা করে দেখা গেল `argon2`-র সাথে আসা আগে-থেকে-তৈরি বাইনারি আছে শুধু `darwin-arm64`, linux, windows ও freebsd-এর; **`darwin-x64` (Intel Mac) নেই**। macOS 12.7.6 যে Mac-এর শেষ সংস্করণ, সেটা Intel Mac হওয়ার সম্ভাবনাই বেশি; তাহলে `npm install` C++ compiler দিয়ে compile করতে যেত, আর ব্যর্থ হলে পুরো `npm install` ভেঙে যেত।
- `@node-rs/argon2` 2.2.2-র macOS Intel বাইনারি আগে থেকে তৈরি; বাইনারি পরীক্ষা করে দেখা গেছে সেটা macOS 10.13 বা নতুনে চলে (`LC_VERSION_MIN_MACOSX` = 10.13, x86_64)। compile লাগে না, Node ভার্সনের সাথে বাঁধা নয় (Node-API), আর `argon2`-র মতোই থ্রেড-পুলে চলে বলে অনুরোধ আটকায় না।
- algorithm একই (argon2id), প্যারামিটার একই (OWASP নূন্যতম: 19 MiB, 2 pass, 1 lane), hash-এর ফরম্যাট একই (`$argon2id$v=19$m=19456,t=2,p=1$...`)। তাই ভবিষ্যতে অন্য লাইব্রেরিতে গেলেও আগের পাসওয়ার্ড কাজ করবে।
- **macOS 12.7.6-এ যাচাই সম্পন্ন** (২০২৬-১১-১৭; নিচের তালিকা)। নিচের বিকল্প দরকার পড়েনি, ভবিষ্যতে সমস্যা হলে কাজে লাগবে বলে রাখা: বিশুদ্ধ WebAssembly argon2id (`hash-wasm`)। তাতে কোনো নেটিভ বাইনারি লাগে না, কিন্তু hash চলার সময় event loop আটকে থাকে (প্রতি লগইনে প্রায় ১০০ ms), তাই লগইনের rate limit থাকা অবস্থায় গ্রহণযোগ্য।

### মালিক-স্তর: platform owner বনাম ব্যবসা-স্তরের `owner` রোল (মালিকের নির্দেশ)

- **owner-only অনুমতি পায় শুধু `users.is_platform_owner = true` ইউজার।** তালিকা: `commission.view`, `commission.manage`, `profit.view`, `settings.manage`, `users.manage`, `roles.manage`, `audit.view`। `commission.` ও `profit.` দিয়ে শুরু যেকোনো অনুমতি `ownerOnly` না হলে অ্যাপ চালুই হয় না।
- platform owner সব ব্যবসায় ঢুকতে পারেন (access-এর সারি লাগে না, তাই নতুন ব্যবসা যোগ করলেও নিজে থেকে পান) এবং সব অনুমতির মালিক।
- **ব্যবসা-স্তরের `owner` রোল** (যেমন কোনো অংশীদার, এক ব্যবসায়) পায় সব **owner-only-বহির্ভূত** অনুমতি; কমিশন, লাভ ও ব্যবস্থাপনার অনুমতি নয়। তাই ইউজার তৈরি, রোলের অনুমতি বদল ও Settings শুধু platform owner করতে পারেন।
- `owner` রোলের অনুমতি রানটাইমে হিসাব করা ("সব সক্রিয় ও owner-only নয়"), `role_permissions`-এ এর সারি থাকে না। ফলে নতুন অনুমতি যোগ হলে আলাদা সিঙ্ক লাগে না, আর এই রোলের অনুমতি বদলানো যায় না (API 400 দেয়)। এটা আমার ছোট সিদ্ধান্ত।
- **তিন স্তরে বাধ্যতা:** (১) নিবন্ধনে (অ্যাপ চালুর সময় ভুল ঘোষণা ধরা পড়ে), (২) API-তে (owner-only অনুমতি রোলকে দিতে গেলে 400), (৩) ডাটাবেসে: `role_permissions`-এর composite foreign key `(permission_key, permission_owner_only)` → `permissions(key, owner_only)` এবং CHECK `permission_owner_only = false`। সরাসরি SQL-এও owner-only সারি ঢোকে না। টেস্টে দুটো দিকই যাচাই হয়।
- টেস্ট (`test/permissions.e2e-spec.ts`): platform owner সব পায়; `owner` রোল owner-only সাতটা পায় না কিন্তু বাকি সব পায়; ম্যানেজার, হিসাবরক্ষক ও বিক্রয়কর্মী কোনোটাই পায় না।

### ডিফল্ট অনুমতি (মালিক Settings থেকে বদলাতে পারবেন)

| রোল | ডিফল্ট |
|---|---|
| manager | `settings.view`, `users.view`, `product.view/manage`, `product.cost.view`, `customer.view/manage`, `customer.due.view`, `collection.create`, `supplier.view`, `purchase.view/create`, `stock.view/adjust`, `sale.create`, `sale.view.all` |
| accountant | `settings.view`, `customer.view`, `customer.due.view`, `collection.create`, `ledger.view`, `ledger.entry.create`, `payment.create`, `expense.create` |
| salesman | `product.view`, `customer.view/manage`, `stock.view`, `sale.create`, `sale.view.own` |
| কেউ না | `sale.void`, `purchase.void`, `summary.finance.view`, `reports.finance.view` (মালিক চাইলে দেবেন) |

- বিক্রয়কর্মী `stock.view` পায় (শুধু পরিমাণ); কেনা-দাম (`product.cost.view`), টাকার সারাংশ, কমিশন বা লাভ নয়। এই তালিকা প্রাথমিক; প্রতিটা ফিচারের ধাপে চূড়ান্ত হবে।
- ডিফল্ট বসে অ্যাপ চালুর সময়: নতুন অনুমতির জন্য, আর যে ব্যবসার কোনো grant-ই নেই তার জন্য (নতুন ব্যবসা)। মালিকের আগের বদল কখনো ওভাররাইট হয় না। ব্যবসা তৈরির কোডে `PermissionSyncService.applyDefaultsToBusiness(id)` ডাকতে হবে। সীমা: কোনো ব্যবসার *সব* রোল থেকে *সব* অনুমতি মালিক নিজে সরিয়ে দিলে পরের চালুতে ডিফল্ট ফিরে আসবে (বাস্তবে ঘটার কথা নয়)।
- ব্যবসার route `b/:businessSlug/...`; কোনো অনুমতি বা `@AnyBusinessMember()` না লিখলে সবার জন্য 403 (ভুলে খুলে যাওয়া আটকাতে)।

### Token, cookie ও সেশন

- Access token JWT (HS256), ১৫ মিনিট, ভেতরে শুধু ইউজার id ও সেশন id; অনুমতি টোকেনে নেই, তাই অনুমতি বদলালে সঙ্গে সঙ্গে কার্যকর। Refresh token এলোমেলো ২৫৬-বিট, ৩০ দিন, ডাটাবেসে শুধু SHA-256।
- দুটোই httpOnly cookie (`SameSite=Lax`; production-এ `Secure`; refresh cookie শুধু `/api/v1/auth` পথে)। কারণ: পাতার JavaScript (XSS) token চুরি করতে পারে না, আর Next.js সার্ভার থেকেও যায়। `Authorization: Bearer` গ্রহণযোগ্য, তবে token response body-তে দেওয়া হয় না; মোবাইল অ্যাপের ধাপে আলাদা পথ যোগ হবে।
- **ডিপ্লয়ের শর্ত:** cookie কাজ করতে web ও API একই সাইটে থাকতে হবে: কাস্টম ডোমেইনের সাবডোমেইন (`app.` ও `api.`, `COOKIE_DOMAIN` সহ) অথবা Next.js proxy। `vercel.app` + `railway.app`-এর মতো আলাদা সাইটে cookie যায় না; `SameSite=None` দিয়ে এটা ঘোরানো হবে না (CSRF সুরক্ষা দুর্বল হয়)। লোকালে `localhost:3000` ও `localhost:4000` একই সাইট (পোর্ট ধরা হয় না), তাই কাজ করে। ধাপগুলো README-তে।
- CSRF: cookie দিয়ে লগইন করা অবস্থায় বদলানোর অনুরোধে `Origin` header `CORS_ORIGIN`-এর তালিকায় না থাকলে 403; `Origin` না থাকলে (curl) চলে।
- Refresh rotation: প্রতিবার নতুন token; পুরনো token ১০ সেকেন্ডের মধ্যে ফিরলে (দুই ট্যাব) শুধু প্রত্যাখ্যান, তার পরে ফিরলে চুরি ধরে পুরো সেশন বাতিল ও audit-এ লেখা। দুই অনুরোধ একসাথে একই token ঘোরাতে গেলে শর্তযুক্ত UPDATE-এ একটাই জেতে।
- Logout, পাসওয়ার্ড বদল বা রিসেট, ইউজার নিষ্ক্রিয় করা: সেশন DB-তে বাতিল এবং সেশন id মেমোরির revoke-তালিকায় (১৬ মিনিট), তাই access token-ও সঙ্গে সঙ্গে অকেজো। চালুর সময় গত ১৬ মিনিটে বাতিল সেশন DB থেকে তালিকায় তোলা হয়।
- অনুমতি যাচাইয়ে প্রতি অনুরোধে ডাটাবেস query নেই: (ইউজার, ব্যবসা) অনুযায়ী ৬০ সেকেন্ডের মেমোরি cache, রোল/অনুমতি/অ্যাক্সেস/নিষ্ক্রিয় করলে সঙ্গে সঙ্গে মোছে। **ধরে নেওয়া হয়েছে API একটাই instance-এ চলে;** একাধিক হলে cache ও revoke-তালিকা Redis-এ নিতে হবে (কোডে বদলের জায়গা একটাই: `AccessResolver` ও `RevocationList`)।

### লগইনের নিরাপত্তা

- একটাই `identifier` ফিল্ড (email বা phone)। email ছোট হাতের অক্ষরে; phone E.164-এ (`01XXXXXXXXX` → `+8801XXXXXXXXX`)।
- সব ব্যর্থতায় (অজানা ইউজার, ভুল পাসওয়ার্ড, নিষ্ক্রিয়, লক) একই 401 ও বার্তা; অজানা ইউজারেও একটা নকল hash যাচাই চলে, যাতে সময় দেখে বোঝা না যায়।
- পরপর ৫ বার ভুলে ১৫ মিনিট লক (audit-এ লেখা)। ঝুঁকি: কেউ ইচ্ছা করে ভুল দিয়ে অন্যের অ্যাকাউন্ট ১৫ মিনিট আটকাতে পারে (লক স্থায়ী নয়, মালিক `reset-password` দিয়ে খুলতে পারেন, platform owner নিজেও ১৫ মিনিট পরে ঢুকতে পারেন)। লক হওয়া ইউজার কারণ জানবে না।
- এক IP থেকে প্রতি মিনিটে `LOGIN_RATE_LIMIT` (ডিফল্ট ১০) লগইন; তারপর 429। (`TRUST_PROXY` ঠিক না দিলে proxy-র পেছনে সব ইউজার এক IP ধরা হবে।)
- পাসওয়ার্ড ১০–১২৮ অক্ষর; নিজের email বা phone হওয়া চলবে না; চিহ্ন বা বড় হাতের অক্ষর জোর করা হয় না (NIST-এর পরামর্শ)।
- `forgot-password` এই ধাপে নেই: মালিক `reset-password` দিয়ে খুলে দেবেন।

### Settings API ও audit

- `GET users` লাগে `users.view` (ম্যানেজারের ডিফল্টে আছে); সব পরিবর্তন `users.manage` (owner-only)। রোলের অনুমতির ছক ও বদল `roles.manage` (owner-only)।
- ইউজার নিষ্ক্রিয় করা সব ব্যবসায় প্রযোজ্য (`users.is_active` সবার জন্য এক)। platform owner অ্যাকাউন্ট এই API দিয়ে বদলানো যায় না (কমান্ড-লাইনে `admin:create`); নিজেকে নিষ্ক্রিয় করা যায় না। `reset-password` সব সেশন শেষ করে ও লক খোলে।
- `audit_logs` এই ধাপেই (অনুমতি ও রোলের বদল সবচেয়ে জরুরি লগ)। লেখা হয় বদলের একই transaction-এ: রোলের অনুমতি, ইউজার তৈরি, অ্যাক্সেস দেওয়া/সরানো/রোল বদল, নিষ্ক্রিয়/সক্রিয়, পাসওয়ার্ড রিসেট; এবং `auth.account_locked`, `auth.session_reuse_detected`, `user.password_changed`। কোথাও পাসওয়ার্ড বা hash নেই (টেস্টে যাচাই)। বদলানোর বা মোছার API নেই; ডাটাবেস-স্তরের trigger দিয়ে অপরিবর্তনীয় করা এখনো হয়নি। লগ দেখার API (`audit.view`) পরে।

### প্রথম মালিক অ্যাকাউন্ট

`npm run admin:create` (`prisma/admin-create.mjs`): `ADMIN_EMAIL` বা `ADMIN_PHONE`, `ADMIN_PASSWORD`, `ADMIN_NAME` env থেকে পড়ে `is_platform_owner` ইউজার বানায়। পাসওয়ার্ড কোডে, seed-এ বা লগে কোথাও নেই। ইউজার আগে থেকে থাকলে কিছু বদলায় না। অস্থায়ী ডেভ-ইউজার ব্যবস্থা নেই: লগইন এড়ানোর যেকোনো পথ ঝুঁকি।

### এই ধাপে করা হয়নি

- Prisma Client-এর স্বয়ংক্রিয় `businessId` extension: প্রথম ব্যবসা-ডেটার টেবিলের (Product/Customer) ধাপে, তখন ঠিকমতো পরীক্ষা করা যাবে।
- forgot-password, token-কে response body-তে দেওয়া (মোবাইল), Redis, audit দেখার API।

### macOS 12.7.6-এ যাচাই সম্পন্ন (২০২৬-১১-১৭), Step 3a

| প্যাকেজ | কোন কমান্ডে লাগে | অবস্থা |
|---|---|---|
| `@node-rs/argon2` (আগে-থেকে-তৈরি Intel বাইনারি, macOS ≥ 10.13) | `npm install`, `npm run admin:create`, লগইন | macOS 12.7.6-এ যাচাই সম্পন্ন |

ডেভেলপারের Mac-এ (macOS 12.7.6, Node 22) সব ধাপ সফল: `npm ci`, `npm run db:deploy`, `npm run db:seed`, `npm run admin:create`, `npm run start:dev`, এবং README-র "লগইন যাচাই (curl)" ধাপগুলো।

## ২০২৬-১১-১৭: ব্যবসা-ডেটার ভিত্তি ও dealership মাস্টার ডেটা (Step 4a)

### ব্যবসা-ডেটা আলাদা রাখা (businessId)

- `PrismaService.forBusiness(businessId)`: Prisma Client extension, যা ব্যবসা-ডেটার মডেলে প্রতিটা query-র `where`-এ ও প্রতিটা নতুন সারির `data`-তে `businessId` বসায়, আর অন্য ব্যবসার id দেখলে ত্রুটি দেয়। ফলে `update({ where: { id } })` দিয়েও অন্য ব্যবসার সারি পাওয়া যায় না (404)।
- নিরাপত্তা-জাল: সাধারণ `prisma.client` ব্যবসা-ডেটার মডেলে `businessId` (একটাই, স্ট্রিং) ছাড়া query করলে ত্রুটি দেয়, তাই ভুলে বাদ পড়া ফিল্টার সঙ্গে সঙ্গে ধরা পড়ে।
- `businessId` স্পষ্টভাবে পাঠানো হয় (`@CurrentAccess()` → service → `forBusiness`), AsyncLocalStorage-এর লুকানো প্রসঙ্গ নয়: পড়ে বোঝা সহজ, background কাজেও একই।
- কোন মডেল ব্যবসা-ডেটা, module নিজে ঘোষণা করে (`registerTenantModels`); core মডেলের নাম জানে না।
- সীমা: raw SQL, nested write আর অন্য টেবিলের `include` দিয়ে পড়া এই জালের বাইরে; `CLAUDE.md`-তে নিষেধ লেখা। ক্যাটাগরি অন্য ব্যবসার হতে পারে না, তা ডাটাবেসও composite foreign key `(business_id, category_id)` দিয়ে আটকায়।

### টেবিল ও টাইপ

- টাকা `Decimal(14,2)`, পরিমাণ `Decimal(14,3)` (এখনো পরিমাণের কলাম নেই)। API-তে টাকা আসা-যাওয়া করে **স্ট্রিং** হিসেবে (`"570.00"`), float-এর ভুল এড়াতে; সংখ্যা পাঠালে 400।
- কোড `document_counters`-এর এক atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` থেকে, তৈরির একই transaction-এ: পণ্য `P-0001`, গ্রাহক `C-00001`, সরবরাহকারী `S-001`, prefix ব্যবসার config-এ। count বা max কখনো নয়। টেস্টে ২০টা একসাথে তৈরিতে কোনো ডুপ্লিকেট নেই। কোড বদলানো যায় না।
- পণ্যের নাম ও ক্যাটাগরির নাম ব্যবসার ভেতরে unique (বড়-ছোট হাতের অক্ষর নির্বিশেষে, `lower(name_en)` index)। গ্রাহকের ফোন বাধ্যতামূলক, E.164-এ, ব্যবসার ভেতরে unique (মালিকের সিদ্ধান্ত)। শুরুর বাকি ঋণাত্মক হতে পারে = অগ্রিম (মালিকের সিদ্ধান্ত)। `credit_limit` null = সীমা নেই।
- `current_balance` আলাদা কলাম; শুরুর বাকি বদলালে atomic `increment`-এ একই পরিমাণ সরে। পরের ধাপে বিক্রি ও আদায় একই transaction-এ এটা বদলাবে।
- প্রতি ব্যবসায় একটাই প্রিন্সিপাল সরবরাহকারী (partial unique index); তৈরি হয় সাধারণ seed-এ, ব্যবসার config থেকে। সরবরাহকারীর যোগ/বদলের API এখন নেই।
- কিছুই মোছা যায় না, শুধু নিষ্ক্রিয়।

### ব্যবসার config-এর নতুন রূপ

`units` (তালিকা: `key`, `nameEn`, `nameBn`, `decimals`), `defaultUnit`, `codePrefixes`, `principalSupplier`। পুরনো `{ unit: {...} }` রূপও পড়া যায়, তাই Neon-এর বিদ্যমান Akij সারি না বদলালেও চলে। Akij: শুধু বস্তা, পূর্ণ সংখ্যা (মালিকের সিদ্ধান্ত)। BSRM-এর মতো নতুন ডিলারশিপে অন্য একক ও prefix শুধু config দিয়ে (টেস্টে যাচাই, core বা module কোড না বদলে)।

### অনুমতি ও সংবেদনশীল সংশোধন

- নতুন চারটা অনুমতি, কোনো স্টাফ রোলের ডিফল্টে নেই, owner-only নয় (ব্যবসা-স্তরের `owner` রোল ও platform owner পান): `product.price.edit`, `product.deactivate`, `customer.balance.edit`, `customer.deactivate`।
- তৈরির সময় ম্যানেজার দাম, শুরুর বাকি ও সীমা দিতে পারেন (কেনা-দামে `product.cost.view`, বাকি/সীমায় `customer.due.view` লাগে)। তৈরির পরে এগুলো বদল আর নিষ্ক্রিয় করা শুধু ওই চার অনুমতিতে, `reason` বাধ্যতামূলক, audit-এ আগের ও পরের মান। Step 4b-তে ম্যানেজার এগুলোর জন্য সংশোধনের অনুরোধ পাঠাবেন।
- নাম, বানান, ঠিকানা, এলাকা, ফোন, ক্যাটাগরি, একক: আর্থিক প্রভাব নেই, `product.manage` / `customer.manage` দিয়ে সরাসরি (মালিকের ঝোঁক অনুযায়ী অনুমোদন লাগে না), audit-এ লেখা হয়।
- একই মান আবার পাঠালে বদল ধরা হয় না, তাই frontend পুরো ফর্ম পাঠালেও অপ্রয়োজনীয় 403 হয় না।
- কেনা-দাম `product.cost.view` ছাড়া, আর গ্রাহকের বাকি ও সীমা `customer.due.view` ছাড়া response-এ থাকে না (`@VisibleWith`)।

### অনুসন্ধান ও তালিকা

- `pg_trgm` (migration নিজে `CREATE EXTENSION IF NOT EXISTS`; Neon-এ আছে); নাম (ইংরেজি, বাংলা), ফোন ও কোডে GIN trigram index; query `ILIKE '%...%'`। ফোন `01712...` লিখলেও `+8801712...`-তে মেলে।
- তালিকা পাতার নম্বর দিয়ে (offset) + `total`, কারণ মাস্টার ডেটার টেবিল ছোট-মাঝারি আর UI-তে পাতার নম্বর লাগে। list-এর ক্রম (`name_en`, `id`) মেলানো index `(business_id, is_active, name_en, id)`। invoice-এর মতো বড় তালিকায় পরে keyset।

### পারফরম্যান্স মাপ (ক্লাউড কন্টেইনার, PostgreSQL 16, ২০,০০৫ গ্রাহক ও ৩০৪ পণ্য)

| অনুরোধ | median | সর্বোচ্চ |
|---|---|---|
| গ্রাহক, পাতা ১ | 8.2 ms | 9.3 ms |
| গ্রাহক, পাতা ১৫০০ (offset 14990) | 9.2 ms | 10.3 ms |
| অনুসন্ধান "traders" (৪০০০ মিল) | 28.8 ms | 34.5 ms |
| অনুসন্ধান পুরো নাম | 32.4 ms | 47.4 ms |
| অনুসন্ধান বাংলা নাম | 39.9 ms | 58.3 ms |
| অনুসন্ধান ফোন | 36.6 ms | 38.3 ms |
| পণ্য, পাতা ১ / অনুসন্ধান | 4.7 / 5.6 ms | 5.1 / 7.4 ms |

সবই লক্ষ্যের (সাধারণ API ২০০ ms, অনুসন্ধান ৩০০ ms) অনেক নিচে। `EXPLAIN (ANALYZE, BUFFERS)`: প্রথম পাতা list-এর index দিয়ে পড়ে। বহু-ফিল্ডের অনুসন্ধানে ২০ হাজার সারিতে planner sequential scan বেছে নেয় (~২৫-৩০ ms), কারণ চারটা trigram index-এর BitmapOr তখন বেশি খরচের; প্রতিটা trigram index আলাদাভাবে কাজ করে (১.৮-৫.৮ ms) এবং সারি বাড়লে planner সেগুলো নেবে। প্রতি Phase-এ বড় ডেটায় আবার মাপা হবে।

### ঝুঁকি ও যাচাই বাকি

- Neon-এ বাংলা নামের trigram index ব্যবহার হয় কি না (locale-নির্ভর): Neon-এ `EXPLAIN` দিয়ে যাচাই বাকি। না হলেও অনুসন্ধানের ফল ঠিক থাকে, শুধু ধীর।
- সাধারণ `Idempotency-Key` ব্যবস্থা এখনো নেই; মাস্টার ডেটায় ফোন ও নামের unique নিয়ম দুবার তৈরি আটকায়। কেনা-বিক্রির ধাপে লাগবে।
- `npm run db:seed:dev`-এর নমুনা পণ্য ও দাম আসল নয়; গ্রাহকের ফোন `+88010000000xx` (কোনো অপারেটরের নয়)।

## ২০২৬-১১-১৭: Settings API: ইউজার তালিকা ও খোঁজা

- `GET users`-এর প্রতিটা item-এ `isPlatformOwner` (একই query, বাড়তি query নয়)। platform owner তালিকায় আসেন না, কারণ তালিকা ব্যবসার সদস্যপদ থেকে আর platform owner-এর সদস্যপদ লাগে না।
- `POST users/lookup` (শুধু `users.manage`, অর্থাৎ platform owner): ইমেইল বা ফোন দিয়ে বিদ্যমান ইউজার খোঁজা। POST, যাতে ইমেইল/ফোন URL ও লগে না আসে। উত্তরে শুধু id, নাম, অবস্থা, platform owner কি না, এই ব্যবসায় অ্যাক্সেস ও রোল; ইমেইল, ফোন বা অন্য ব্যবসার তথ্য নয়। না মিললে 404।
- অস্তিত্ব আন্দাজের অপব্যবহার ঠেকাতে: rate limit প্রতি **ইউজার** (IP নয়) প্রতি মিনিটে ২০টা (`UserThrottlerGuard`), আর প্রতিটা খোঁজ audit-এ (`user.lookup`: ইমেইল নাকি ফোন, পাওয়া গেল কি না, পাওয়া ইউজারের id; খোঁজার মানটা নয়)।
- ডুপ্লিকেট ইউজার তৈরিতে 409-এর উত্তরে বিদ্যমান ইউজারের id দেওয়া হয় না (টেস্টে নিশ্চিত); id পেতে lookup।
- ইউজারকে ব্যবসা-স্তরের `owner` রোল দেওয়া যায়; owner-only অনুমতি পান না। platform owner বানানো শুধু `admin:create` দিয়ে।

## ২০২৬-১১-১৮: সংশোধন ও বাতিলের অনুমোদন ব্যবস্থা (Step 4b)

### কাঠামো

- একটাই সাধারণ টেবিল `change_requests` (`src/core/approvals`), আলাদা ইতিহাসের টেবিল নয়; প্রতিটা ধাপ `audit_logs`-এ (`change_request.created/approved/applied/rejected/cancelled/stale`)। core কোনো module বা ব্যবসার নাম জানে না: module নিজের `ChangeHandler` (`load`, `validateEdit`, `validateVoid`, `preview`, `applyEdit`, `applyVoid`) `ChangeHandlerRegistry`-তে নিবন্ধন করে। টেস্টে একটা in-memory নকল handler কাঠামো না বদলে নতুন ধরন ও তার void-reversal দেখায়।
- core সামলায় লক, version যাচাই, অবস্থা, audit আর transaction; handler শুধু নিজের টেবিল, একই `tx`-এ।
- stale ধরা হয় রেকর্ডের নতুন `version` কলাম দিয়ে (`updatedAt`-এর মিলিসেকেন্ডে নির্ভর না করে); মাস্টার ডেটার চার টেবিলে `version` ও `updated_by` যোগ, প্রতিটা বদলে `version` বাড়ে।
- `summary` কলাম রাখা হয়নি (প্ল্যান থেকে ছোট বিচ্যুতি): সারাংশ দর্শকের অনুমতি অনুযায়ী পড়ার সময় তৈরি হয়, কারণ সংরক্ষিত এক লাইনের সারাংশে লুকানো মান (যেমন কেনা-দাম) চলে যেত। snapshot ছোট (শুধু প্রস্তাবিত ফিল্ড), তাই খরচ নেই।
- একটা রেকর্ডে একসাথে একটাই pending: partial unique index `(business_id, entity_type, entity_id) WHERE status = 'pending'`। Idempotency: partial unique `(business_id, requested_by, idempotency_key)`; একই key আবার এলে আগের অনুরোধ 200-এ।
- অনুমোদন: অনুরোধ ও রেকর্ড দুটোই `SELECT … FOR UPDATE` (raw SQL-এ নিজে `business_id`); দুজন একসাথে অনুমোদনে একজনই সফল (টেস্টে ৩ জন একসাথে: 200, 409, 409)। version না মিললে অনুরোধ `stale` হয়ে commit, তারপর 409। প্রয়োগে ত্রুটিতে পুরো rollback, অনুরোধ `pending` থাকে।
- অনুমোদনকারীর `change.approve` ছাড়াও প্রতিটা ফিল্ডের সরাসরি-অনুমতি লাগে (বাতিলে `*.void`)। ফলে owner-only অনুমতির পেছনের কোনো ভবিষ্যৎ বদল শুধু platform owner অনুমোদন করতে পারবেন। নিজের অনুরোধে সিদ্ধান্ত নিষিদ্ধ, মালিক হলেও।
- অনুরোধকারী যে ফিল্ড দেখতে পারেন না, তার অনুরোধও পারেন না (403); snapshot, proposed, impact ও summary দর্শকের অনুমতি অনুযায়ী ছাঁটা। `isStale` pending-এ এখনকার version থেকে, আর `stale` অবস্থায় সবসময় `true`।
- অনুমতি: `change.request`, `change.view.own` (ডিফল্ট manager, accountant, salesman), `change.view.all`, `change.approve` (ডিফল্ট কেউ না; ব্যবসা-স্তরের owner রোল ও platform owner পান)। কোনোটাই owner-only নয়, যাতে অংশীদার-owner অনুমোদন দিতে পারেন এবং মালিক চাইলে বিশ্বস্ত কাউকে দিতে পারেন। মোট অনুমতি এখন ৪০টা।
- মাস্টার ডেটায় void নেই; নিষ্ক্রিয় করাই তার জায়গা (`isActive: false` দিয়ে edit)।

### Step 5-এর জন্য ঠিক করা নিয়ম (মালিকের উত্তর)

- কেনা বাতিলে স্টক ঋণাত্মক হলে বাতিল আটকাবে (409); স্টক কখনো ঋণাত্মক নয়।
- বাতিলের উল্টো এন্ট্রি বাতিলের তারিখে; মূল এন্ট্রি অপরিবর্তিত, বাতিল চিহ্নসহ।
- সংশোধন পার্থক্য (delta) হিসেবে atomic `increment`/`decrement`-এ (মোট, বাকি, স্টক, counter), পুরো ফেরত-নতুন নয়।
- অনুমোদনকারী প্রস্তাবিত মান বদলাতে পারেন না; অন্য মান চাইলে প্রত্যাখ্যান করে নিজে সরাসরি সংশোধন (কারণসহ)।
- হিসাবরক্ষকও `change.view.own` পান।

### পারফরম্যান্স

- তালিকা ১০টা করে, `(business_id, status, requested_at)` ও `(business_id, requested_by, requested_at)` index-এ; `pending-count` একই index থেকে। তালিকায় snapshot বা preview নয়, শুধু বিস্তারিততে।
- impact শুধু pending-এর বিস্তারিততে, এক transaction-এ handler-এর `load` + `preview` (মাস্টার ডেটায় এক-দুটো query)।

## ২০২৬-১১-১৮: পণ্য থেকে বিক্রয়মূল্য সরানো ও ত্রুটির code

### বিক্রয়মূল্য

- পণ্যের `default_sale_price` সরানো হলো (নতুন migration; পুরনো migration অপরিবর্তিত), কারণ মালিক প্রতি গ্রাহকের কাছে আলাদা দামে বেচেন; দাম বসবে বিক্রির সময় ইনভয়েসে। পুরনো `products_prices_check` বাদ, নতুন `products_purchase_price_check` (`purchase_price >= 0`)।
- কলামের মান মুছে গেছে (শুধু dev/নমুনা ডেটা, production নেই; মালিকের অনুমোদনে)। এই ঘরের অপেক্ষমাণ সংশোধন-অনুরোধ migration-এ `cancelled` (কারণ `decision_note`-এ); সিদ্ধান্ত হয়ে যাওয়া পুরনো অনুরোধ ইতিহাসে থাকে, সারাংশে "defaultSalePrice changed" (মান দেখায় না)।
- handler-এ নেই এমন ঘরের অনুরোধ অনুমোদনে 409 `CHANGE_FIELD_UNSUPPORTED` (crash নয়)। `product.price.edit` এখন শুধু কেনা-দাম।

### কেনা-দাম (মালিকের সিদ্ধান্ত, Step 5a-তে করা হবে; এই PR-এ বদল নেই)

- বিকল্প গ: কেনার লাইনই আসল দাম। Step 5a-তে পণ্যের `purchasePrice` হবে শুধু-পড়া `lastPurchasePrice` ও `lastPurchasedAt`, যা কেনা নিশ্চিত হলে একই transaction-এ বসবে; পণ্য তৈরির সময় দাম নেওয়া হবে না, হাতে বদলানো যাবে না।
- `product.price.edit` অনুমতি সরবে। কেনার ভুল দাম ঠিক হবে কেনার রেকর্ডের সংশোধনে (`purchase.edit`, সংশোধন-অনুরোধ দিয়ে)।
- `product.cost.view`-এর অর্থ একই: কেনা-দাম যেখানেই থাকুক (পণ্যের শেষ দাম, কেনার লাইন, স্টকের মূল্য), দেখার অনুমতি।
- লাভের হিসাব পণ্যের দাম থেকে নয়, কেনার লাইন থেকে (গড় বা FIFO খরচ); সেটা আলাদা সিদ্ধান্ত।
- বাতিল বিকল্প: ক (হাতে বসানো দাম পণ্যে, কেনার আসল দামের সঙ্গে অমিল হয়), খ (পণ্য থেকে পুরো সরানো, শেষ দাম প্রতিবার query)।

### ত্রুটির code

- উত্তরের আকার শুধু যোগ: `statusCode`, `error`, `message` আগের মতো (validation-এর `message`-তালিকাও হুবহু, টেস্টে Nest-এর নিজের pipe-এর সঙ্গে মেলানো), সাথে সব ত্রুটিতে `code`, ঘরের ত্রুটিতে `field` আর `errors[]`। ফলে আগের frontend ভাঙে না।
- নতুন প্যাকেজ নয়। `src/core/errors`: সাহায্যকারী (Nest-এর নিজের exception class ফেরত দেয়, তাই `instanceof` আগের মতো), `AppValidationPipe` (Nest-এর `flattenValidationErrors` দিয়েই `message`), আর global `AppExceptionFilter`, যা code-হীন ত্রুটিতে status থেকে সাধারণ code বসায় (guard, throttler, Nest-এর route 404)। অজানা ত্রুটিতে 500 `INTERNAL_ERROR`, ভেতরের কোনো বিবরণ নয়।
- validation code স্বয়ংক্রিয়: `<ঘর>_<সমস্যা>`, constraint থেকে সমস্যা (`isNotEmpty` → `REQUIRED`, `maxLength` → `TOO_LONG`, অজানা → `INVALID`)। প্রতি ঘরে একটাই: `REQUIRED`, তারপর `INVALID`, তারপর বাকি (ধরন ভুল হলে দৈর্ঘ্যের বার্তা অর্থহীন)।
- পাসওয়ার্ডের নিয়মের code `PASSWORD_*`, যে ঘরেই আসুক (`password` বা `newPassword`; `field` আলাদা)।
- path-এর ভুল id: `ParseIdPipe`, code `ID_INVALID`।
- 403 গুলো সাধারণ `ACCESS_DENIED` রাখা হলো (কোন অনুমতি নেই তা বলা হয় না)। লগইনের সব ব্যর্থতায় একই `INVALID_CREDENTIALS`।

## ২০২৬-১১-১৮: শুধু-পড়া শেষ কেনা-দাম ও pending অনুরোধের id

### শেষ কেনা-দাম

- `products.purchase_price` বাদ, তার জায়গায় `last_purchase_price` (`Decimal(14,2)`, খালি হতে পারে) ও `last_purchased_at` (`timestamptz(3)`, খালি হতে পারে)। CHECK: দাম `>= 0`, আর দুটো একসাথে খালি বা একসাথে ভরা।
- এখনকার হাতে বসানো দামগুলো মুছে সব পণ্যে `null` (মালিকের অনুমোদনে; শুধু নমুনা ডেটা)। কারণ: কোনো কেনা ছাড়া এগুলোকে "শেষ কেনা-দাম" বলা মিথ্যা হতো, আর প্রথম কেনা বাতিলের পুনর্গণনাতেই মুছে যেত।
- পণ্য তৈরি বা সম্পাদনায় কেনা-দাম নেওয়া হয় না (`PURCHASE_PRICE_NOT_ALLOWED`, `LAST_PURCHASE_PRICE_NOT_ALLOWED`)। পণ্যের সংশোধন-অনুরোধে শুধু `isActive`। কেনা-দাম নিয়ে অপেক্ষমাণ অনুরোধ migration-এ `cancelled`।
- Step 5a-র নিয়ম: কেনা নিশ্চিত হলে একই transaction-এ পণ্যের সারি `FOR UPDATE`, তারপর দাম ও সময় বসে, `version` বাড়ে। কেনা বাতিল বা সংশোধনে শেষ বৈধ কেনার লাইন থেকে পুনর্গণনা (index `(business_id, product_id, purchased_at DESC)` লাগবে), কেনা না থাকলে `null`। কেনার ভুল দাম বা সংখ্যা ঠিক হবে `purchase.edit` অনুরোধে (4b-র edit handler)।
- `product.price.edit` সরানো: registry থেকে বাদ; migration `role_permissions`-এর সারি মুছেছে এবং প্রতিটা প্রভাবিত ব্যবসায় `audit_logs`-এ `permission.retired` (কোন রোল থেকে) লিখেছে; `permissions` টেবিলের সারি চালুর সময় sync নিষ্ক্রিয় করে (অনির্ঘোষিত সব অনুমতির মতো)। মোট অনুমতি ৩৯। `product.cost.view` থাকল: কেনা-দাম যেখানেই থাকুক, দেখার অনুমতি; `lastPurchasedAt`-ও এর পেছনে লুকানো (কবে কেনা হলো সেটাও কেনার তথ্য)।
- change-request-এর টেস্টগুলো কেনা-দামের বদলে গ্রাহকের ক্রেডিট সীমা দিয়ে চলে।

### pending অনুরোধের id

- 409 `CHANGE_REQUEST_PENDING_EXISTS`-এ `changeRequestId` থাকে শুধু যদি অনুরোধকারী সেটা খুলতে পারেন (নিজের অনুরোধ আর `change.view.own`, অথবা `change.view.all`), `GET :id`-এর একই নিয়মে। না হলে id নেই, যাতে অন্যের অনুরোধের অস্তিত্বের বাইরে কিছু জানা না যায়। id আনার query শুধু এই ত্রুটির পথে চলে।

### docs

- `docs/API.md` অংশ ১০-এর শেষে PR #11-এ ভুল করে রয়ে যাওয়া পুরনো (বার্তা-ভিত্তিক) ত্রুটির সারিগুলো সরানো হলো; এখন শুধু code-ভিত্তিক টেবিল, অংশ ১১-র সঙ্গে মেলানো।

## ২০২৬-১১-১৮: Akij থেকে কেনা, স্টক ও মাসিক কেনার কাউন্টার (Step 5a)

প্ল্যান ও মালিকের সিদ্ধান্ত: `docs/plans/step-5a.md`।

### টেবিল

- `purchases`, `purchase_items`, `stock_movements`, `monthly_purchase_counters`; `products.current_stock`। কেনার লাইন, movement ও কেনা composite FK `(business_id, …)`-এ নিজের ব্যবসার পণ্য/কেনা/সরবরাহকারীতেই পড়ে (এ জন্য `products`, `suppliers`-এ `@@unique([businessId, id])` যোগ)।
- `purchase_items`-এ কেনার `purchase_date` ও `status` নকল (একই transaction-এ মেলানো), যাতে "শেষ বৈধ কেনা" একটা index থেকে পড়া যায়: `(business_id, product_id, purchase_date DESC, created_at DESC)`। প্ল্যানে partial index (`WHERE status='active'`) ছিল; Prisma partial index ঘোষণা করে না, তাই পূর্ণ index (পণ্য দিয়ে কেনা-ফিল্টারেও কাজে লাগে), query-তে `status = 'active'`।
- `stock_movements` শুধু-যোগ-হয়: trigger `UPDATE`/`DELETE` আটকায়; শুধু transaction-এর ভেতরে `SET LOCAL jesan.allow_purge = 'on'` থাকলে মোছা যায়, যা কেবল টেস্টের cleanup ব্যবহার করে। movement-এ চিহ্নসহ পরিমাণ, `balance_after` (লকের ভেতরে হিসাব), ব্যবসার তারিখ (`movement_date`), উৎস (`purchase` + id, বা `adjustment`)। সমন্বয়ের নিজের id দরকার নেই, তাই `adjustment`-এ `source_id` খালি (CHECK), প্ল্যানে ছিল "নিজের id"।
- CHECK: স্টক `>= 0`, `balance_after >= 0`, `line_total = round(quantity * unit_price, 2)`, void-এর তিনটা ঘর একসাথে, `payment_method IN ('cash')`, সংশোধন/বাতিল/সমন্বয়ের movement-এ কারণ বাধ্যতামূলক।
- config-এ নতুন (সব ঐচ্ছিক, পুরনো config চলে): `codePrefixes.purchase` (`PUR`), `timezone` (`Asia/Dhaka`), `backdateLimitDays` (৭), `stockAdjustmentLimit` (১০)।

### হিসাবের নিয়ম

- লাইন-মোট `Decimal.ROUND_HALF_UP`-এ দুই দশমিক; PostgreSQL-এর numeric `round()` অর্ধেককে শূন্য থেকে দূরে নেয়, অঋণাত্মকে যা half-up, তাই দুটো মেলে (টেস্ট: `0.005` → `0.01`, `0.1235` → `0.12`, `0.075` → `0.08`)।
- মাস ধরা হয় কেনার তারিখ থেকে; তারিখ ব্যবসার সময়-অঞ্চলের ক্যালেন্ডার দিন (`src/core/common/business-time.ts`, Intl দিয়ে, নতুন প্যাকেজ নয়)। ৩০ নভেম্বর রাত ১১:৫৯ ও ১ ডিসেম্বর ০০:০০ Dhaka-র টেস্ট আছে।
- কাউন্টার: বাতিল ও সংশোধনে **কেনার মাসে** কমে বা বাড়ে (মালিকের সিদ্ধান্ত ১); তারিখের মাস বদলালে পুরনো মাস থেকে নতুন মাসে। শুধু মোট বস্তা (সিদ্ধান্ত ২)।
- কাউন্টার বাড়ানো একটা atomic upsert (`PeriodCounterService`)। কমানো সাধারণ `UPDATE`, কারণ PostgreSQL upsert-এর প্রস্তাবিত insert-সারিতে আগে CHECK চালায়, তাই ঋণাত্মক মানের upsert ব্যর্থ হয় (টেস্টে ধরা পড়েছিল)।
- শেষ কেনা-দাম: প্রতিটা কেনা, বাতিল ও সংশোধনে প্রভাবিত পণ্যগুলোর জন্য শেষ বৈধ লাইন (কেনার তারিখ, তারপর লেখার সময়) থেকে আবার হিসাব; পুরনো তারিখের কেনা পরে লিখলে শেষ দাম বদলায় না। `lastPurchasedAt` = কেনার দিনের শুরু, Asia/Dhaka (সিদ্ধান্ত ৮)।
- পেছনের তারিখ: ভবিষ্যৎ আটকানো; `purchase.edit` ছাড়া শুধু `backdateLimitDays` দিন (সিদ্ধান্ত ৪)।
- সমন্বয়ের সীমা: প্রতি পণ্য, প্রতি ইউজার, প্রতিদিন (Dhaka) সমন্বয়ের পরম মানের যোগফল ≤ ১০, পণ্যের সারি লক করে গোনা, তাই সমান্তরাল অনুরোধেও এড়ানো যায় না (সিদ্ধান্ত ৫)। বেশি হলে 403 `ADJUSTMENT_APPROVAL_REQUIRED`, তারপর `product_stock` অনুরোধ (`adjustBy` চিহ্নসহ পরিমাণ, লক্ষ্য-সংখ্যা নয়, তাই কেনায় stale হয় না; handler-এর version তাই স্থির)। অনুমোদনে `stock.adjust.large`।

### বাতিল ও সংশোধন (4b-র কাঠামোয়)

- `purchase` handler (`PurchaseChangeHandler`, DI-সহ class) আর `product_stock` handler। core-এ ছোট সাধারণ সংযোজন:
  - handler-এর `fieldRule(key)`: লাইনের ঘর (`items.<id>.quantity`) pattern দিয়ে।
  - `ChangeContext.reason` আর `fieldPrefix`: অনুরোধে `proposedChange.`, সরাসরি পথে ফাঁকা।
  - `ChangeRequestsService.applyDirect`: মালিক-স্তরের সরাসরি `PATCH`/`void` একই handler, লক, version, audit ও প্রতি-ঘরের সরাসরি-অনুমতিতে চলে।
  - পুরনো handler বদলায়নি।
- বাতিলে উল্টো movement বাতিলের দিনের তারিখে; স্টক কম থাকলে 409 `STOCK_INSUFFICIENT`, কিছুই বদলায় না। সংশোধনে শুধু পার্থক্য, `purchase_edit` movement সংশোধনের দিনের তারিখে।
- লাইন যোগ বা বাদ, বা পণ্য বদল সংশোধনে নয় (সিদ্ধান্ত ৩); বাতিল + নতুন কেনা।
- একটা bug নমুনা সংগ্রহের সময় ধরা পড়ে: বহু-লাইনের কেনায় এক লাইনের সংশোধনের preview অন্য লাইনকে শূন্য দেখাত (প্রয়োগ ঠিক ছিল)। ঠিক করা হয়েছে, দুই লাইনের টেস্ট যোগ হয়েছে।

### লক ও সমান্তরাল কাজ

- পণ্য সবসময় id-ক্রমে `FOR UPDATE` (`lockRows`, core-এ; raw SQL-এ নিজে `business_id`)। ক্রম: অনুরোধ, তারপর কেনা, তারপর পণ্য, তারপর কাউন্টার। সব পথে একই ক্রম, তাই deadlock হয় না।
- টেস্ট: একই পণ্যে ১০টা সমান্তরাল কেনা (স্টক, নম্বর, কাউন্টার ঠিক), একই `Idempotency-Key`-এ দুটো সমান্তরাল অনুরোধ (একটা 201, একটা 200, একটাই কেনা)।

### অনুমতি

- নতুন: `purchase.edit`, `stock.adjust.large` (দুটোরই ডিফল্টে কোনো স্টাফ রোল নেই; owner-only নয়, যাতে ব্যবসা-স্তরের `owner` রোল অনুমোদন দিতে পারেন)। মোট ৪১টা।
- owner-only শুধু `commission.view`-এর পেছনে মাসিক কাউন্টার ও preview-এর কাউন্টার-লাইন।
- কেনা-দামের জন্য আলাদা অনুমতি নয়: `product.cost.view` (#12-র অর্থে)। কেনা তৈরিতেও লাগে, কারণ দাম লিখতে দাম দেখতে হয়।
- ম্যানেজার কেনার বস্তা দেখেন, কাউন্টার ও কমিশনের অঙ্ক নয় (সিদ্ধান্ত ৭)।

### ত্রুটির code

- নতুন: `PURCHASE_NOT_FOUND`, `PRODUCT_DUPLICATE`, `PRODUCT_NOT_FOUND_OR_INACTIVE`, `QUANTITY_INVALID`, `UNIT_PRICE_INVALID`, `SUPPLIER_NOT_FOUND_OR_INACTIVE`, `PURCHASE_DATE_INVALID`, `PURCHASE_DATE_IN_FUTURE`, `PURCHASE_DATE_TOO_OLD`, `PURCHASE_ALREADY_VOID`, `STOCK_INSUFFICIENT`, `ADJUSTMENT_APPROVAL_REQUIRED`, `ADJUST_BY_INVALID`, `NOTE_INVALID`, `SUPPLIER_REFERENCE_INVALID`।
- CLAUDE.md-র সমস্যা-শব্দের তালিকায় যোগ হয়েছে `TOO_OLD`, `IN_FUTURE`, `INSUFFICIENT`, আর `details` রাখার নিয়ম।
- প্ল্যানের `ADJUSTMENT_NEEDS_APPROVAL` নাম বদলে `ADJUSTMENT_APPROVAL_REQUIRED` (তালিকার `REQUIRED` শব্দে)।
- `Idempotency-Key`-এর যাচাই এখন core-এ (`idempotencyKeyOf`), change-requests ও কেনা দুটোই এটা ব্যবহার করে।

### Step 5b ও লোকেশন

- 5b-র অর্ডার, ডেলিভারি আর লোকেশন কীভাবে বসবে: `docs/plans/step-5a.md`-এর অংশ ৬–৭।
- ডেলিভারির movement একই `StockLedger` দিয়ে যাবে। শুধু `kind`-এর CHECK তালিকা বাড়বে।

### পারফরম্যান্স মাপ (ক্লাউড কন্টেইনার, PostgreSQL 16, `npm run db:seed:perf`)

ডেটা: ৩০০ পণ্য, ১,০০,০০০ কেনা (২,০০,০০০ লাইন), ১০,০০,০০০ stock movement। চালু API-তে (HTTP, লগইন-সহ) প্রতিটা অনুরোধ ৩ বার গরম করে ৭ বার মাপা।

| অনুরোধ | median | সর্বোচ্চ |
|---|---|---|
| কেনার তালিকা, পাতা ১ | 9.8 ms | 10.7 ms |
| কেনার তালিকা, পাতা ৫০০০ (offset 49,990) | 17.4 ms | 24.8 ms |
| কেনা, পণ্য দিয়ে ফিল্টার | 6.0 ms | 7.4 ms |
| কেনা, সরবরাহকারী + এক মাস | 5.2 ms | 5.4 ms |
| কেনার বিস্তারিত | 4.2 ms | 5.3 ms |
| স্টকের তালিকা, পাতা ১ | 3.9 ms | 4.6 ms |
| স্টক অনুসন্ধান | 5.5 ms | 5.9 ms |
| পণ্যের ইতিহাস, পাতা ১ | 5.2 ms | 6.5 ms |
| পণ্যের ইতিহাস, পাতা ৩০০ | 4.7 ms | 5.0 ms |
| পণ্যের ইতিহাস, এক মাস | 5.0 ms | 7.9 ms |
| মাসিক কাউন্টার | 2.4 ms | 2.7 ms |
| কেনা সেভ | 31.2 ms | 46.3 ms |
| কেনা বাতিল | 23.4 ms | 31.9 ms |

- সবই লক্ষ্যের (পড়া ২০০ ms, সেভ ৫০০ ms, অনুসন্ধান ৩০০ ms) অনেক নিচে।
- প্রথম মাপে কেনার তালিকার পাতা ১ ছিল ১৮৯ ms। কারণ: Prisma-র `_count` লাইনের সংখ্যা গুনতে ব্যবসার **সব** কেনার লাইন group করে, তারপর পাতা কাটে (একাই ~১০০ ms)। সমাধান: পাতার ১০টা id ধরে একটা `groupBy`। ফলে পাতা ১ নামল ১০ ms-এ। নিয়ম: তালিকায় relation-এর `_count` নয়।
- `EXPLAIN (ANALYZE, BUFFERS)`: তালিকা `(business_id, purchase_date DESC, id DESC)` index থেকে সরাসরি পড়ে (০.১ ms)। ১ লাখ সারির `count(*)` ~১৬ ms, যা এখন তালিকার সময়ের বড় অংশ।
- গভীর পাতা (offset) এখনো দ্রুত। কেনা কয়েক লাখ ছাড়ালে তালিকা keyset-এ নেওয়ার প্রস্তাব থাকল।

## ২০২৬-১১-১৮: অনিয়মিত টেস্ট ঠিক করা

- PR #13 merge-এর পরে `main`-এর CI একবার ব্যর্থ হয়েছিল। `master-data.e2e-spec.ts` পুরো উত্তরে `"545"` লেখা নেই যাচাই করত। এলোমেলো id বা সময়ে সংখ্যাটা কাকতালীয়ভাবে থাকায় টেস্ট ভুল করে ব্যর্থ হয়; কোডে কোনো ভুল ছিল না।
- পাঁচটা টেস্টে একই ধরন ছিল। এখন সবাই টাকার পূর্ণ রূপ খোঁজে (`"545.50"`)। uuid-এ দশমিক বিন্দু থাকে না, ISO সময়ের মিলিসেকেন্ড `Z`-এ শেষ হয়, তাই এই রূপ শুধু দাম থেকেই আসতে পারে।
- নিয়ম: লুকানো মানের টেস্টে টাকা পূর্ণ রূপে খোঁজো, শুধু অঙ্ক নয়; আর ঘরটা নেই সেটাও যাচাই করো (`not.toHaveProperty`)।
