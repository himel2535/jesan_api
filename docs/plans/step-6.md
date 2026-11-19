# Step 6: খরচ, ক্যাশ বই ও মূল রিপোর্ট (প্ল্যান)

অবস্থা: **স্বয়ংক্রিয় মোড** (মালিক অনুপস্থিত; §১১-র সিদ্ধান্তগুলো আগে থেকে অনুমোদিত)। Branch: `claude/step-6-expenses-cashbook-reports`। অগ্রগতি: `docs/plans/step-6-progress.md`।

ভিত্তি:
- প্রপোজাল ৭.৭ (হিসাব ও খরচ), ৯.২, ৯.৬, ১০
- Step 4a: `forBusiness`, `DocumentCounterService`, `registerTenantModels`
- Step 4b: `ChangeHandler`, `ChangeHandlerRegistry`, `applyDirect`
- Step 5a: `business-time`, `business-dates`, `lockRows`, `idempotencyKeyOf`
- Step 5b: `CustomerAccounts`, `customer_ledger_entries`, `collections`
- CLAUDE.md-র ত্রুটির code ও ব্যবসা-ডেটার নিয়ম

এই ধাপে **নেই**: মালিকের কমিশন, লাভ, কেনা-দাম-নির্ভর কোনো কলাম (Step 7)।

## ১. যা বানানো হবে

1. **খরচ** — খরচের ধরন (ব্যবসা-ভিত্তিক টেবিল, ডিফল্ট তালিকা config/seed থেকে) আর খরচের এন্ট্রি (তারিখ, ধরন, পরিমাণ, পদ্ধতি, বিবরণ, প্রমাণ-নোট)। কর্মী নিজে সম্পাদনা বা বাতিল করতে পারবে না: শুধু কারণসহ অনুরোধ, মালিকের অনুমোদনে প্রয়োগ। কোনো hard delete নেই।
2. **ক্যাশ বই** — দৈনিক নগদ ও ব্যাংক/মোবাইল-ব্যাংকিং পদ্ধতি অনুযায়ী আদায় (জমা), খরচ, কেনার টাকা, শুরুর ও শেষ জমা। শুধু-পড়া, আসল লেনদেন-সারি থেকে গোনা।
3. **ছয়টা রিপোর্ট** — বিক্রয়, আদায়, বাকির তালিকা (বয়স-ভাগসহ), স্টক ও স্টক-চলন, খরচ, দৈনিক সারাংশ। সব শুধু-পড়া, তারিখ-সীমা ও পাতাভাগসহ।

## ২. ডাটাবেস (একটাই migration)

| টেবিল | মূল কলাম | নিয়ম |
|---|---|---|
| `expense_categories` | `business_id`, `name_en`, `name_bn`, `sort_order`, `is_active`, `version` | ব্যবসায় নাম অদ্বিতীয়; মোছা নয়, নিষ্ক্রিয় (কারণ বাধ্যতামূলক) |
| `expenses` | `business_id`, `code`, `expense_date`, `category_id`, `method`, `amount`, `note`, `proof_note`, `status`, `idempotency_key`, `version` | টাকা `Decimal(14,2)` CHECK `> 0`; `status` ∈ (`active`,`void`); মোছা নয়, বাতিল |

- কোড `DocumentCounterService.next(tx, …, 'expense')` + `formatCode(config.codePrefixes.expense, n, 4)` → `EXP-0001`। কখনো `count(*)`/`max()+1` নয়।
- `category_id` composite FK `(business_id, category_id)` → অন্য ব্যবসার ধরন ডাটাবেসই আটকায়।
- `idempotency_key`-এ partial unique index `(business_id, created_by, idempotency_key)`, hint `idempotency`।
- Index সব `business_id` দিয়ে শুরু, list-এর `orderBy` হুবহু মেলানো: `[business_id, expense_date desc, id desc]`, `[business_id, category_id, expense_date desc]`, `[business_id, status, expense_date desc]`, `[business_id, method, expense_date desc]`; প্রতিটা FK কলামে নিজের index।
- ক্যাশ বইয়ের জন্য তিনটা **covering index** (index-only scan, যেন শুরুর জমা গুনতে পুরো সারি পড়তে না হয়):
  - `expenses(business_id, status, expense_date) INCLUDE (method, amount)`
  - `collections(business_id, status, collection_date) INCLUDE (method, amount)`
  - `purchases(business_id, status, purchase_date) INCLUDE (payment_method, total_amount)`
- `DEALERSHIP_TENANT_MODELS`-এ `ExpenseCategory`, `Expense` যোগ; নইলে প্রতিটা query unscoped বলে আটকাবে।
- CHECK constraint migration SQL-এ হাতে লেখা।

**ক্যাশ বইয়ের কোনো টেবিল নেই** (§১১.১): প্রতিটা সংখ্যা তিন উৎস থেকে গোনা হয় —

| দিক | উৎস | শর্ত |
|---|---|---|
| জমা | `collections` | `status='active'` |
| খরচ | `expenses` | `status='active'` |
| কেনার টাকা | `purchases` | `status='active'`, `payment_method` ∈ config-এর নগদ পদ্ধতি |

দিনের সীমা ব্যবসার সময়-অঞ্চলে (`business-time.ts`), সার্ভারের ঘড়িতে নয়। লেখার কোনো পথ বদলায় না, তাই Step 5b-র lock order অপরিবর্তিত।

**config-এ যোগ** (সব ঐচ্ছিক, JSON কলাম, migration লাগে না):

| ঘর | ডিফল্ট | কাজ |
|---|---|---|
| `codePrefixes.expense` | `EXP` | খরচের কোডের উপসর্গ |
| `expenseMethods` | `collectionMethods`-এর মান | খরচ দেওয়ার পদ্ধতি |
| `cashMethodKeys` | `['cash']` | কোন পদ্ধতি "নগদ"; বাকিগুলো ব্যাংক/মোবাইল |
| `defaultExpenseCategories` | `seed-helpers.mjs`-এর নিরপেক্ষ তালিকা | শুধু seed পড়ে |

## ৩. নিয়ম

- খরচের তারিখ `checkBusinessDate(…, { mayBackdate: access.permissions.has('expense.edit') })` — ভবিষ্যতে নয়, কর্মীর ব্যাকডেট `backdateLimitDays`-এ সীমিত (বিদ্যমান নিয়ম)।
- পদ্ধতি config-এর `expenseMethods`-এ থাকতে হবে, নইলে 400 `EXPENSE_METHOD_UNKNOWN`।
- ধরন একই ব্যবসার ও active হতে হবে, নইলে 400 `EXPENSE_CATEGORY_NOT_FOUND_OR_INACTIVE`।
- দুবার ক্লিক বা retry-তে একটাই খরচ (`Idempotency-Key`, ব্যবহারকারী-ভিত্তিক)।
- সংশোধন ও বাতিল `ExpenseChangeHandler` দিয়ে: `expense.edit` / `expense.void` থাকলে সরাসরি (`applyDirect`), নইলে `change.request`-এ অনুরোধ। প্রতিটা বদলে `version` বাড়ে। বাতিল = `status='void'` + কারণ; উল্টো এন্ট্রি লাগে না, কারণ ক্যাশ বই derived আর `status='active'` ফিল্টারই reversal (§১১.৩)।
- রিপোর্টে কোনো কেনা-দাম, লাভ বা কমিশন নেই। `daily-summary`-র নগদ অংশ `@VisibleWith('cashbook.view')` দিয়ে সার্ভারেই লুকানো।
- তারিখ-সীমা না দিলে ডিফল্ট চলতি মাস; সর্বোচ্চ ৪০০ দিন (§১১.৭)।

## ৪. অনুমতি

| key | owner-only | manager | accountant | salesman |
|---|---|---|---|---|
| `expense.view` | | ✓ | ✓ | |
| `expense.create` (বিদ্যমান) | | ✓ (নতুন) | ✓ | |
| `expense.edit` | | | | |
| `expense.void` | | | | |
| `expense.category.manage` | | ✓ | | |
| `cashbook.view` | | ✓ | ✓ | |
| `report.view` | | ✓ | ✓ | |

- ফাঁকা ঘর = মালিক-স্তর; কর্মী অনুরোধ পাঠাবে।
- বিক্রয়কর্মী কিছুই পায় না (সে শুধু নিজের অর্ডার দেখে)।
- বিদ্যমান `reports.finance.view`, `summary.finance.view`, `payment.create`, `ledger.*` ছোঁয়া হবে না — Step 7-এর লাভ ও কমিশনের জন্য সংরক্ষিত (§১১.৫)।
- `PermissionSyncService.grantDefaults` শুধু **নতুন** key-তে ডিফল্ট বসায়, তাই `expense.create`-এ manager যোগ করলে আগের ব্যবসায় আপনাআপনি যাবে না — মালিককে Settings-এ দিতে হবে।

## ৫. API (সব `b/:businessSlug/` এর নিচে, তালিকা ১০ সারি/পাতা)

### খরচ

| Route | অনুমতি |
|---|---|
| `GET expense-categories?page=&active=` | `expense.view` |
| `POST expense-categories` | `expense.category.manage` |
| `PATCH expense-categories/:id` | `expense.category.manage` (নিষ্ক্রিয়ে `reason`) |
| `GET expense-methods` | `expense.create` |
| `POST expenses` | `expense.create` + `Idempotency-Key` (201 নতুন / 200 replay) |
| `GET expenses?page=&from=&to=&categoryId=&method=&status=` | `expense.view` |
| `GET expenses/:id` | `expense.view` |
| `PATCH expenses/:id` | `expense.view` (ফিল্ড-ভিত্তিক অনুমতি handler-এ) |
| `POST expenses/:id/void` | `expense.void` |

কর্মীর সংশোধন/বাতিল: বিদ্যমান `POST change-requests` (`entityType: 'expense'`) — নতুন endpoint লাগে না।

### ক্যাশ বই

`GET cash-book?from=&to=&page=` — `cashbook.view`। উত্তর: `openingBalance`, `closingBalance`, `byMethod[]` (`method`, `isCash`, `in`, `out`, `net`), `days[]` (`date`, `opening`, `collections`, `expenses`, `purchases`, `closing`)।

### রিপোর্ট (সব `report.view`)

| Route | groupBy | উৎস |
|---|---|---|
| `GET reports/sales` | `date` \| `customer` \| `product` \| `category` | active `deliveries` / `delivery_items` |
| `GET reports/collections` | `date` \| `method` | active `collections` |
| `GET reports/dues` | গ্রাহক | `customers` + বয়স-ভাগ |
| `GET reports/stock` | পণ্য | `products.current_stock` (শুধু পরিমাণ) |
| `GET reports/stock-movements` | পণ্য × `kind` | `stock_movements` সারাংশ |
| `GET reports/expenses` | `category` \| `month` | active `expenses` |
| `GET reports/daily-summary?date=` | — | আজকের অর্ডার, ডেলিভারি, আদায়, খরচ, নগদ অবস্থা |

বাকির বয়স-ভাগ (০–৭, ৮–৩০, ৩০+ দিন): আদায় কোনো ডেলিভারিতে বরাদ্দ হয় না, তাই FIFO — শুরুর বাকি সবচেয়ে পুরনো ধরে, পাতার ১০ জন গ্রাহকের খাতা পুরনো থেকে নতুন মিলিয়ে (§১১.৪)। অগ্রিম (ঋণাত্মক ব্যালেন্স) আলাদা কলামে, কোনো bucket-এ নয়।

## ৬. পারফরম্যান্স

লক্ষ্য: পড়া ২০০ ms, সেভ ৫০০ ms।

**N+1 নেই:**
- প্রতিটা তালিকা `Promise.all([findMany(skip/take), count])`; relation-এর `_count` নয়।
- ক্যাশ বই: তিন উৎসের aggregate একসাথে `Promise.all`-এ, লুপে query নয়।
- বয়স-ভাগ: শুধু পাতার ১০ গ্রাহকের id ধরে একটাই query।

**মাপ:** `npm run db:seed:perf:sales` (১ লাখ অর্ডার, ডেলিভারি ও আদায়, ২০০০ গ্রাহক) + নতুন `npm run db:seed:perf:expenses` (~৫০,০০০ খরচ)। চালু API-তে (HTTP, লগইন-সহ) প্রতিটা অনুরোধ ৩ বার গরম করে ৭ বার মাপা; প্রতিটা ভারী query-তে `EXPLAIN (ANALYZE, BUFFERS)`। ফল `DECISIONS.md`-তে।

**২০০ ms পার করলে:** আগে index ঠিক করা; তাতেও না হলে `cash_book_daily` summary টেবিল একই transaction-এ রক্ষণাবেক্ষণ আর `consistency:check`-এ আসল সারির সঙ্গে মেলানো — সত্য তখনো আসল সারিতেই। করতে হলে কারণসহ `DECISIONS.md`-তে।

**`consistency:check`-এ নতুন পরীক্ষা:** প্রতি ব্যবসায় `Σ(দৈনিক net) = Σ active collections − Σ active expenses − Σ active নগদ purchases`, প্রতিটা দিনের `closing = opening + in − out`, `opening(d+1) = closing(d)`, আর কোনো active খরচের ধরন অন্য ব্যবসার বা নিষ্ক্রিয় নয়।

## ৭. টেস্ট (Vitest, আসল PostgreSQL)

- খরচ তৈরি: কোড `EXP-0001`, টাকা স্ট্রিং, audit লেখা; একই `Idempotency-Key` দুবার → একটাই সারি (201, তারপর 200)।
- ভুল: শূন্য/ঋণাত্মক টাকা, অচেনা পদ্ধতি, অন্য ব্যবসার বা নিষ্ক্রিয় ধরন, ভবিষ্যতের তারিখ, সীমার বাইরে ব্যাকডেট — প্রতিটায় `code` ও `field` যাচাই।
- কর্মী সরাসরি `PATCH`/`void` করতে পারে না (403); অনুরোধ → preview → মালিকের অনুমোদন → প্রয়োগ; নিজের অনুরোধ নিজে অনুমোদন নয়; stale অনুরোধ।
- বাতিলের পরে ক্যাশ বই ও খরচ রিপোর্ট থেকে বাদ; দুবার বাতিল → `EXPENSE_ALREADY_VOID`।
- ক্যাশ বই: শুরুর + জমা − খরচ − নগদ কেনা = শেষ; পদ্ধতি অনুযায়ী ভাগ; নগদ বনাম ব্যাংক ভাগ config থেকে; দিনের সীমা ব্যবসার সময়-অঞ্চলে।
- ছয়টা রিপোর্ট: তারিখ-সীমা, পাতাভাগ, প্রতিটা `groupBy`; বয়স-ভাগের তিন bucket; অগ্রিম আলাদা; অনুমতি ছাড়া 403; কেনা-দাম/লাভ/কমিশনের কোনো ঘর নেই (`not.toHaveProperty`)।
- বিচ্ছিন্নতা: অন্য ব্যবসার খরচ বা ধরনের id → 404 (একই code ও বার্তা); `prisma.client` দিয়ে unscoped query আটকায়।
- **দুই config-এ**: বস্তা (পূর্ণসংখ্যা, ডিফল্ট পদ্ধতি) আর নমুনা রড-ব্যবসা (টন/কেজি, দশমিক ৩, ভিন্ন `codePrefixes.expense`, `expenseMethods`, `cashMethodKeys`, ভিন্ন ডিফল্ট ধরন) — কোড না বদলেই চলে।

## ৮. WIP commit-এর ধাপ

0. প্ল্যান ও অগ্রগতির ফাইল
1. migration + schema + config + অনুমতি + tenant models
2. খরচের ধরন: CRUD + change handler + টেস্ট
3. খরচ: তৈরি, তালিকা, বিস্তারিত, idempotency + টেস্ট
4. `ExpenseChangeHandler`: সংশোধন ও বাতিল (সরাসরি ও অনুরোধে) + টেস্ট
5. ক্যাশ বই + `consistency:check`-এ নতুন পরীক্ষা + টেস্ট
6. ছয়টা রিপোর্ট + টেস্ট
7. perf seed, মাপ, index যাচাই → `DECISIONS.md`
8. `docs/API.md`, `docs/adding-a-business.md`, `README.md`, `CLAUDE.md`, `DECISIONS.md`
9. পুরো যাচাই → PR → CI সবুজ → squash merge → branch মোছা → রিপোর্ট

## ৯. ঝুঁকি

| ঝুঁকি | প্রশমন |
|---|---|
| ক্যাশ বইয়ের শুরুর জমা পুরো ইতিহাস যোগ করে | covering index-এ index-only scan; §৬-এর শর্তে summary টেবিলের পথ খোলা |
| বয়স-ভাগের FIFO ভারী | শুধু পাতার ১০ গ্রাহকে, বিদ্যমান খাতার index থেকে |
| PR বড় (migration + ৩ feature + docs) | ৯টা WIP commit, প্রতিটায় নিজের টেস্ট |
| লোকাল PostgreSQL ১৬, CI-তে ১৮ | ১৭/১৮-নির্ভর কোনো feature নয়; চূড়ান্ত যাচাই CI-তে |
| `grantDefaults` পুরনো ব্যবসায় নতুন ডিফল্ট দেয় না | চূড়ান্ত রিপোর্টে মালিককে Settings-এর কাজ জানানো |

## ১০. এই ধাপে করা হবে না

- মালিকের কমিশন ও লাভের হিসাব, কোনো কেনা-দাম-নির্ভর কলাম (Step 7)।
- সরবরাহকারীর খাতা বা বাকিতে কেনা (কেনা এখনো নগদ ও পুরো পরিশোধিত)।
- `businesses.config` সম্পাদনার Settings API (এখনো seed/DB-only)।

## ১১. স্বয়ংক্রিয় সিদ্ধান্ত (মালিকের অনুপস্থিতিতে নেওয়া, সবচেয়ে নিরাপদ পথ)

1. **ক্যাশ বই derived, টেবিল নয়।** কারণ: আলাদা ক্যাশ-টেবিল দ্বিতীয় সত্য হতো; derived হলে লেখার পথ ও lock order অপরিবর্তিত থাকে, আর বাতিল-সংশোধন আপনাআপনি মিলে যায়।
2. **খরচের ধরন আসল টেবিল, config-এর স্ট্রিং তালিকা নয়।** কারণ: প্রতি-সারি নিষ্ক্রিয়, পুনঃনামকরণ, audit আর খরচের FK দরকার। ডিফল্ট তালিকা তবু config/seed থেকেই।
3. **বাতিলে উল্টো এন্ট্রি নয়, `status='void'` + `version++`।** কারণ: ক্যাশ বই derived, তাই `status` ফিল্টারই reversal; সারি কখনো মোছা হয় না।
4. **বয়স-ভাগ FIFO, শুধু পাতার ১০ জনে।** কারণ: আদায় ডেলিভারিতে বরাদ্দ হয় না, তাই একটা অনুমান দরকার; FIFO সবচেয়ে রক্ষণশীল (পুরনো বাকি আগে শোধ ধরে)।
5. **`report.view` নতুন key; `reports.finance.view` ছোঁয়া হবে না।** কারণ: প্রকাশিত key-র অর্থ বদলানো নিষেধ; পরেরটা Step 7-এর লাভ/কমিশনের জন্য।
6. **`note` (বিবরণ) ও `proof_note` (প্রমাণ-নোট) আলাদা দুই ঘর।** কারণ: মালিকের চাওয়া দুটো আলাদা তথ্য।
7. **রিপোর্টে সর্বোচ্চ ৪০০ দিনের তারিখ-সীমা।** কারণ: এক পাতার query যেন কখনো পুরো table না পড়ে।
8. **`expense.create`-এ manager যোগ।** কারণ: ছোট ডিলারশিপে ম্যানেজারই খরচ লেখেন। পুরনো ব্যবসায় retroactive নয়, তাই রিপোর্টে জানানো হবে।
