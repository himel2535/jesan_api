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
- **Mac-এ যাচাই বাকি:** `npm install`, `npm run admin:create`, লগইন (নিচের তালিকা)। না চললে বিকল্প: বিশুদ্ধ WebAssembly argon2id (`hash-wasm`)। তাতে কোনো নেটিভ বাইনারি লাগে না, কিন্তু hash চলার সময় event loop আটকে থাকে (প্রতি লগইনে প্রায় ১০০ ms), তাই লগইনের rate limit থাকা অবস্থায় গ্রহণযোগ্য।

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

### লোকালে যাচাই বাকি (macOS 12.7.6), Step 3a

| প্যাকেজ | কোন কমান্ডে লাগে | অবস্থা |
|---|---|---|
| `@node-rs/argon2` (আগে-থেকে-তৈরি Intel বাইনারি, macOS ≥ 10.13) | `npm install`, `npm run admin:create`, লগইন | যাচাই বাকি |
