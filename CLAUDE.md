# CLAUDE.md: jesan-api

Jesan Enterprise মাল্টি-বিজনেস ERP প্ল্যাটফর্মের backend (NestJS)। Frontend আলাদা repo: `jesan-web`।
প্রধান নির্দেশনা: রুটের প্রপোজাল PDF (`CodTox_Jesan_Enterprise_Business_Platform_Proposal_v3.pdf`)। নতুন Phase শুরুর আগে সংশ্লিষ্ট সেকশন পড়ো।

## কাজের ধরন (মালিকের স্থায়ী নির্দেশ, ২০২৬-১১-১৬)

1. **বড় কাজের শুরুতে প্ল্যান।** প্ল্যানে সব বড় সিদ্ধান্ত পরিষ্কার থাকবে: কী বানানো হবে, কোন প্যাকেজ ও ভার্সন, ডাটাবেসের কাঠামো (টেবিল ও সম্পর্ক), কমিশন বা টাকার হিসাবের নিয়ম, লগইন ও নিরাপত্তার নকশা, ঝুঁকি ও বিকল্প। মালিক প্ল্যান অনুমোদন করলে সেটাই পুরো কাজের অনুমতি।
2. **অনুমোদনের পর আর জিজ্ঞেস নয়।** নিজে করো: কোড, টেস্ট, lint, type-check, test, build, commit, push, PR খোলা, এবং সব চেক পাস করলে `main`-এ squash merge করে branch মুছে দেওয়া। ছোট ধাপের জন্য অনুমতি চাইবে না।
3. **প্ল্যানের বাইরের বড় সিদ্ধান্তে থামো ও অনুমতি নাও:** ডাটাবেস টেবিলের কাঠামো বদল, টাকার হিসাবের নিয়ম বদল, নিরাপত্তার বদল, ডেটা মুছে যাওয়ার ঝুঁকি, force push, আসল secret বা production সংক্রান্ত কিছু। ছোট প্রযুক্তিগত সিদ্ধান্ত (ফাইলের নাম, ফোল্ডার, ছোট রিফ্যাক্টর) নিজে নাও এবং `DECISIONS.md`-তে লেখো।
4. **কোনো চেক ব্যর্থ হলে merge নয়।** নিজে কারণ খুঁজে ঠিক করো। ঠিক না হলে মালিককে জানাও। চেক পাস করাতে টেস্ট বাদ দেওয়া বা বন্ধ করা নিষেধ।
5. **আসল secret কখনো কোডে, চ্যাটে বা commit-এ নয়।** লাগলে `.env.example`-এ শুধু নাম রাখো এবং মালিককে বলো আসল মান কোথায় বসাতে হবে।
6. **কাজের শেষে ছোট রিপোর্ট:** কী কী হলো, কোথায় merge হলো, মালিকের কী করতে হবে (যেমন Mac-এ `git pull`)।

## Git branch নিয়ম

- প্রতিটা নতুন কাজে `main` থেকে নতুন নামের branch নাও: `claude/<কাজের-নাম>` (যেমন `claude/decisions-macos-verified`)।
- পুরনো (merge হয়ে যাওয়া) branch পুনরায় ব্যবহার নয়।
- force push কখনো নয়।
- `main`-এ সরাসরি push নয়; সবসময় PR, CI সবুজ হলে squash merge।
- merge-এর পর branch মোছো। মোছা না গেলে রিপোর্টে জানাও, যাতে মালিক নিজে মুছতে পারেন।

## CI (GitHub Actions)

`.github/workflows/ci.yml` প্রতিটা PR-এ এবং `main`-এ push হলে Node 22-এ (`.nvmrc` থেকে) PostgreSQL 18 service-সহ চালায়: `npm ci` → `db:deploy` → `db:check` → lint → type-check → test → build। এই চেক সবুজ না হলে merge নয়। নতুন চেক বা script যোগ হলে workflow-ও হালনাগাদ করো।

## প্রতিটা কাজের পর (বাধ্যতামূলক)

1. অ্যাপ চালিয়ে দেখো: `npm run start`, তারপর `curl localhost:4000/api/v1/health`
2. `npm run lint`
3. `npm run type-check`
4. `npm test`
5. `npm run build`

পাঁচটাই পাস না করলে কাজ শেষ নয়, commit নয়।

## ডাটাবেস

- Schema বদলালে: `npm run db:migrate` দিয়ে নতুন migration বানাও; পুরনো migration ফাইল কখনো সম্পাদনা নয়। CHECK constraint migration SQL-এ হাতে লেখো।
- টেস্ট আসল ডাটাবেসে চালাও: `DATABASE_URL` সেট করে `npm run db:deploy`, তারপর `npm test`।
- `src/generated/` git-এ নয়; `PrismaService` (`src/core/database`) ছাড়া অন্য কোথাও `PrismaClient` বানানো নয়।
- Seed-এ কোনো ইউজার বা পাসওয়ার্ড নয়। নমুনা ডেটা শুধু `prisma/seed-dev.mjs`-এ (production-এ চলে না), আসল ব্যবসার তথ্য ছাড়া।

## লগইন, রোল ও অনুমতি

- সব route ডিফল্টে সুরক্ষিত; `@Public()` শুধু health ও sign-in endpoint-এ।
- ব্যবসার route `b/:businessSlug/...`; প্রতিটায় `@RequirePermission(...)` বা ইচ্ছা করে `@AnyBusinessMember()`। কিছু না লিখলে 403।
- নতুন module নিজের অনুমতি registry-তে ঘোষণা করবে। `commission.*` ও `profit.*` অবশ্যই `ownerOnly`; owner-only অনুমতি পায় শুধু `users.is_platform_owner = true` ইউজার। ব্যবসা-স্তরের `owner` রোল পায় সব owner_only-বহির্ভূত অনুমতি।
- টাকার সংবেদনশীল ফিল্ড সার্ভারে লুকাও (`@VisibleWith` + `@SerializeWith`), শুধু frontend-এ নয়। প্রতিটা নতুন গোপন ফিল্ডে এই ধরনের টেস্ট দাও।
- পাসওয়ার্ড, token বা hash কখনো লগে, audit-এ বা response-এ নয়। ব্যর্থ লগইনে সবসময় একই বার্তা।
- অনুমতি বা রোল বদলালে `AccessResolver`-এর cache মোছো (`invalidateBusiness` / `invalidateUser`) এবং `audit_logs`-এ লেখো।
- API-র কোনো endpoint, request, response, ত্রুটি বা অনুমতি বদলালে একই PR-এ `docs/API.md` হালনাগাদ করো (frontend এটার উপর নির্ভর করে)।

## ত্রুটির code (`src/core/errors`)

- প্রতিটা ত্রুটি core-এর সাহায্যকারী দিয়ে: `badRequest` / `conflict` / `notFoundError` / `forbidden` / `unauthorized` (`code`, `message`, ঘরের হলে `field`)। Nest-এর exception সরাসরি নয়; স্থির code ছাড়া নতুন ত্রুটি নয়।
- code `UPPER_SNAKE`, রূপ `<বিষয়>_<সমস্যা>` (যেমন `PHONE_DUPLICATE`, `CATEGORY_NOT_FOUND_OR_INACTIVE`, `STALE_REQUEST`)। সমস্যার শব্দ এই তালিকা থেকে: `REQUIRED`, `INVALID`, `TOO_SHORT`, `TOO_LONG`, `TOO_SMALL`, `TOO_LARGE`, `TOO_OLD`, `IN_FUTURE`, `INSUFFICIENT`, `NOT_ALLOWED`, `DUPLICATE`, `NOT_FOUND`, `UNKNOWN`, `INACTIVE`, `FORBIDDEN`, `ALREADY_<অবস্থা>`, `EXISTS`, `UNSUPPORTED`। ঘরের বাইরের অতিরিক্ত তথ্য (যেমন উপলব্ধ স্টক) `details`-এ। বিষয় ঘরের নাম হলে `camelCase` থেকে `UPPER_SNAKE` (`codeSubject`)।
- `field` = request-এর key (ভেতরের ঘর dot দিয়ে, header-এর নাম হুবহু)। একটা ঘরের ত্রুটিতেই শুধু `field`।
- একবার প্রকাশ হওয়া code কখনো বদলানো, সরানো বা অন্য অর্থে ব্যবহার নয়; বার্তা বদলানো যায়।
- code, field বা বার্তায় ব্যক্তিগত তথ্য (ফোন, ইমেইল), অন্য রেকর্ডের id/নাম বা অন্য ব্যবসার ইঙ্গিত নয়। অন্য ব্যবসার id আর না-থাকা id-তে একই code ও বার্তা।
- নতুন code যোগ হলে একই PR-এ `docs/API.md`-র ত্রুটির তালিকায় code, status, field ও "কখন আসে" লেখো, আর টেস্টে code (ও field) যাচাই করো।


## ব্যবসা-ডেটা (business data)

- ব্যবসা-ডেটার প্রতিটা টেবিলে `business_id` (FK, RESTRICT), সব composite index `business_id` দিয়ে শুরু; module নিজের মডেল `registerTenantModels([...])`-এ ঘোষণা করবে।
- এই মডেলে query সবসময় `prisma.forBusiness(access.businessId)` দিয়ে (`access` আসে `@CurrentAccess()` থেকে)। `prisma.client` দিয়ে `businessId` ছাড়া query ত্রুটি দেয়; সেটা এড়াতে কখনো `businessId` হাতে বসিয়ে ঘুরপথ নয়।
- ব্যবসা-ডেটায় nested write বা অন্য টেবিলের `include` দিয়ে ব্যবসা-ডেটা পড়া নয় (scope সেখানে পৌঁছায় না)। raw SQL শুধু core-এর নির্দিষ্ট সাহায্যকারীতে (যেমন `DocumentCounterService`), আর তাতে নিজে `business_id` দিতে হবে।
- নম্বর বা কোড সবসময় `DocumentCounterService.next(tx, ...)` দিয়ে, একই transaction-এ; কখনো `count(*)` বা `max()+1` নয়।
- টাকা `Decimal(14,2)`, পরিমাণ `Decimal(14,3)`; API-তে টাকা স্ট্রিং (`"570.00"`), JavaScript-এ টাকার হিসাব নয়। balance-এর মতো জমানো মান atomic `increment`-এ বদলাও।
- কিছুই মোছা নয়, নিষ্ক্রিয়। আর্থিক প্রভাবের সংশোধন (দাম, বাকি, সীমা, নিষ্ক্রিয়) আলাদা অনুমতি ও `reason` চায় এবং audit-এ আগের/পরের মান লেখে; ডিফল্টে শুধু মালিক-স্তরের।
- অন্য ব্যবসার id দিলে 404। প্রতিটা নতুন ব্যবসা-ডেটার টেবিলে বিচ্ছিন্নতার টেস্ট দাও।
- ভবিষ্যতের প্রতিটা আর্থিক বা স্টকের রেকর্ডের module সংশোধন-অনুরোধ ব্যবস্থা (`src/core/approvals`) ব্যবহার করবে: সত্যিকারের মোছা নেই, বাতিল (void) হয় উল্টো এন্ট্রিতে (বাতিলের তারিখে, একই transaction-এ); module নিজের সংশোধনযোগ্য ফিল্ড, বাতিল ও `ChangeHandler` ঘোষণা করে `ChangeHandlerRegistry`-তে নিবন্ধন করবে; প্রতিটা বদলে রেকর্ডের `version` বাড়বে; সরাসরি সংশোধন বা বাতিলের অনুমতি ডিফল্টে মালিক-স্তরে সীমিত, স্টাফ অনুরোধ করবে।
- স্টক বদলায় শুধু `StockLedger.apply(tx, ...)` দিয়ে, কাজের একই transaction-এ: পণ্যের সারি id-ক্রমে লক, শূন্যের নিচে নয় (409 `STOCK_INSUFFICIENT`), `stock_movements`-এ movement (`balance_after`-সহ) আর `current_stock` একসাথে। `stock_movements` শুধু-যোগ-হয় (trigger); মোছা শুধু টেস্টের cleanup-এ `SET LOCAL jesan.allow_purge = 'on'` দিয়ে, application কোডে কখনো নয়। নতুন movement-এর ধরন (যেমন 5b-র `delivery`, `delivery_void`) migration-এ CHECK তালিকায় যোগ করো।
- মাস বা দিনভিত্তিক জমানো সংখ্যা (যেমন মাসিক কেনার কাউন্টার) `PeriodCounterService.add(tx, ...)` দিয়ে, একই transaction-এ; কখনো সব রেকর্ড যোগ করে নয়। ব্যবসার তারিখ (`YYYY-MM-DD`) সবসময় ব্যবসার সময়-অঞ্চলে (`src/core/common/business-time.ts`), সার্ভারের ঘড়িতে নয়।
- তালিকায় relation-এর `_count` নয় (Prisma সব সারি group করে, ১ লাখে ~১০০ ms); পাতার id ধরে আলাদা `groupBy`।
- পণ্যের `lastPurchasePrice` / `lastPurchasedAt` শুধু-পড়া: কেনা নিশ্চিত হলে একই transaction-এ (পণ্যের সারি লক করে) বসে; কেনা বাতিল বা সংশোধনে একই transaction-এ শেষ বৈধ কেনার লাইন থেকে পুনর্গণনা (না থাকলে `null`)। কোনো API বা handler এগুলো হাতে বসায় না; কেনার ভুল দাম ঠিক হয় `purchase.edit` অনুরোধে।

## পারফরম্যান্স চেকলিস্ট (প্রপোজাল সেকশন ৯.৬): প্রতিটা feature শেষে

1. এই API কি পুরো table আনছে? (pagination আছে? প্রতি পাতায় ১০ সারি)
2. প্রতিটা ফিল্টার ও join-এর কলামে index আছে? `EXPLAIN (ANALYZE, BUFFERS)` দেখেছি?
3. লুপের ভেতরে কোনো query বা ক্রমিক await আছে? (স্বাধীন query `Promise.all`-এ)
4. সেভে double-click করলে একই কাজ দুইবার হয়? (idempotency key আছে?)
5. দুজন একসাথে এই কাজ করলে stock/নম্বর/বাকি ভুল হয়? (atomic update ও একটাই transaction আছে?)
6. সেভের পর অপ্রয়োজনীয় query-ও কি refetch হচ্ছে?
7. ১ লক্ষ invoice-এর seed ডেটায় লক্ষ্যমাত্রা মিলছে? (সাধারণ API ২০০ms, সেভ ৫০০ms, search ৩০০ms)

## সিদ্ধান্ত

প্রতিটা সিদ্ধান্ত (ভার্সন, tool বাছাই, অস্পষ্ট ব্যবসার নিয়মে নেওয়া সহজ ও নিরাপদ পথ) `DECISIONS.md`-তে এক-দুই লাইনে কারণসহ লেখো। প্রতি Phase শেষে ভার্সন তালিকা হালনাগাদ করো।

## Secret

কোনো আসল secret (পাসওয়ার্ড, token, API key, connection string) কখনো কোডে, চ্যাটে বা commit-এ নয়। `.env` gitignore করা; `.env.example`-এ শুধু নাম ও নিরীহ নমুনা মান, আসল মান কোথায় বসবে তা মালিককে জানাও।

## স্থাপত্যের নিয়ম

- `src/core`: সবার জন্য এক। কোনো ব্যবসার নাম বা নিয়ম নয় (`akij`, `bsrm` শব্দ core-এ থাকলে সেটা ভুল)।
- `src/modules/<template>`: ব্যবসার ধরন অনুযায়ী module। module কেবল core ব্যবহার করে; core কখনো module import করে না; এক module অন্য module সরাসরি ডাকে না।
- সব ব্যবসা-ডেটায় `businessId`; টাকায় float নয় (Decimal); delete নয়, void।
- প্রতিটা অংশ আলাদা NestJS module (controller, service, DTO, validation)। TypeScript strict।

## ভার্সন নীতি

- Node 22 LTS (`.nvmrc`), কারণ `DECISIONS.md`-তে।
- install-এর আগে `npm view <pkg> version dist-tags` দিয়ে সর্বশেষ stable যাচাই। RC/beta/canary/next নয়।
- `prisma`-র `latest` ট্যাগ RC হতে পারে: সবসময় `prisma@7` ও `@prisma/client@7` স্পষ্ট লিখে install।
- peer সমস্যা `--force` / `--legacy-peer-deps` দিয়ে ঢাকা নিষেধ। lockfile commit হবে।

## কমান্ড

`npm run start:dev` · `npm run build` · `npm run lint` · `npm run type-check` · `npm test` · `npm run format` · `npm run db:deploy` · `npm run db:migrate` · `npm run db:seed` · `npm run db:seed:dev` · `npm run db:check` · `npm run admin:create`
