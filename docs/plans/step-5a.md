# Step 5a: Akij থেকে কেনা, স্টক ও মাসিক কেনার কাউন্টার (প্ল্যান)

অবস্থা: **অনুমোদিত (২০২৬-১১-১৮)**, কাজ চলছে; অগ্রগতি নিচের "অগ্রগতি" অংশে। Branch: `claude/step-5a-purchase-stock`।
ভিত্তি: প্রপোজাল ৭.৪, ৭.৭, ৮, ৯.৩–৯.৬, ১০, ১১; Step 4a (`forBusiness`, `DocumentCounterService`), Step 4b (`ChangeHandler`, void-এর নিয়ম), #11 (ত্রুটির code), #12 (শেষ কেনা-দামের নিয়ম)।

শেষে "প্রশ্ন" অংশে ৮টা সিদ্ধান্ত আপনার কাছ থেকে চাই। প্রতিটায় আমার সুপারিশ দেওয়া আছে; "সুপারিশ মেনে" বললেই চলবে।

---

## ১. যা বানানো হবে

1. **কেনা** (`purchases`, `purchase_items`): নগদ, পুরো পরিশোধিত। ক্রম নম্বর `PUR-0001` (প্রতি ব্যবসায় আলাদা), idempotency key, লাইনে পণ্য, বস্তা, একক কেনা-দাম, লাইন-মোট।
2. **স্টক**:
   - শুধু-যোগ-হয় খাতা `stock_movements`।
   - পণ্যে `current_stock`।
   - সব বদল একই transaction-এ।
3. **শেষ কেনা-দাম**: #12-র নিয়মে কেনায় বসবে। বাতিল বা সংশোধনে পুনর্গণনা হবে।
4. **স্টক সমন্বয়**: কারণসহ, audit-এ। ছোট সমন্বয় সরাসরি করা যায়, বড়টা অনুমোদন-সাপেক্ষ।
5. **মাসিক কেনার কাউন্টার** `monthly_purchase_counters`: কাউন্টারটা শুধু owner-only অনুমতিতে দেখা যাবে।
6. **কেনা বাতিল ও সংশোধন**: 4b-র handler দিয়ে। ম্যানেজার অনুরোধ পাঠাবেন। মালিক অনুমোদন দেবেন, অথবা নিজে সরাসরি করবেন।
7. **API, অনুমতি, ত্রুটির code, `docs/API.md`, টেস্ট আর ১ লাখ কেনার পারফরম্যান্স মাপ।**

`product.price.edit` আর আসবে না।

---

## ২. ডাটাবেস (একটা migration)

সাধারণ নিয়ম (CLAUDE.md অনুযায়ী):
- সব টেবিলে `business_id` (FK, RESTRICT)।
- সব composite index শুরু হবে `business_id` দিয়ে।
- টাকা `Decimal(14,2)`, পরিমাণ `Decimal(14,3)`।
- কিছুই মোছা হবে না।
- মডেলগুলো `registerTenantModels`-এ ঘোষণা হবে।
- এক ব্যবসার কেনার লাইন যাতে অন্য ব্যবসার কেনা বা পণ্যে না পড়ে, তার জন্য composite FK `(business_id, purchase_id)` আর `(business_id, product_id)`।

### `purchases`

| কলাম | টাইপ | নিয়ম |
|---|---|---|
| `id` | uuid v7 | |
| `business_id` | uuid | FK |
| `code` | varchar(32) | `PUR-0001`, `DocumentCounterService.next(tx, …, 'purchase')`; unique `(business_id, code)` |
| `supplier_id` | uuid | composite FK `(business_id, supplier_id)`; না দিলে প্রিন্সিপাল সরবরাহকারী (Akij); নিষ্ক্রিয় হলে 400 |
| `purchase_date` | date | ব্যবসার ক্যালেন্ডার তারিখ (Asia/Dhaka); ভবিষ্যৎ নয়; না দিলে আজ (Dhaka) |
| `payment_method` | varchar(16) | CHECK `IN ('cash')`; এখন সবসময় নগদ, পুরো পরিশোধিত |
| `total_quantity` | decimal(14,3) | লাইনের যোগফল |
| `total_amount` | decimal(14,2) | লাইন-মোটের যোগফল |
| `status` | varchar(8) | CHECK `active` / `void` |
| `note` | varchar(500) | ঐচ্ছিক |
| `supplier_reference` | varchar(64) | ঐচ্ছিক, Akij-এর কাগজের নম্বর |
| `idempotency_key` | varchar(64) | ঐচ্ছিক; partial unique `(business_id, created_by, idempotency_key)` |
| `version` | int | প্রতিটা বদলে বাড়ে (4b-র stale ধরার জন্য) |
| `created_by`, `updated_by`, `voided_by` | uuid | FK users |
| `voided_at`, `void_reason` | | CHECK: `void` হলে দুটোই বাধ্যতামূলক, `active` হলে দুটোই খালি |
| `created_at`, `updated_at` | timestamptz(3) | |

Index:
- `(business_id, purchase_date DESC, id DESC)`: তালিকা, নতুন আগে।
- `(business_id, supplier_id, purchase_date DESC)`
- `(business_id, status, purchase_date DESC)`
- FK-এর কলামগুলোতে।

### `purchase_items`

| কলাম | টাইপ | নিয়ম |
|---|---|---|
| `id`, `business_id`, `purchase_id`, `product_id` | uuid | composite FK; unique `(purchase_id, product_id)`, অর্থাৎ এক কেনায় এক পণ্য একবারই |
| `quantity` | decimal(14,3) | CHECK `> 0`; ব্যবসার এককের দশমিক নিয়মে যাচাই (বস্তা = পূর্ণসংখ্যা) |
| `unit_price` | decimal(14,2) | CHECK `>= 0` |
| `line_total` | decimal(14,2) | CHECK `= round(quantity * unit_price, 2)`; সার্ভারে Decimal দিয়ে হিসাব, JavaScript-এর সংখ্যায় নয় |
| `purchase_date`, `status` | | কেনা থেকে নকল করা (একই transaction-এ মেলানো থাকে), যাতে নিচের index দিয়ে সরাসরি পড়া যায় |
| `created_at` | | |

Index:
- `(business_id, product_id, purchase_date DESC, created_at DESC) WHERE status = 'active'`: শেষ বৈধ কেনা খোঁজা (#12-র নিয়ম), আর পণ্য দিয়ে কেনার তালিকা ফিল্টার।
- `(business_id, purchase_id)`

### `stock_movements` (শুধু-যোগ-হয় খাতা)

| কলাম | টাইপ | নিয়ম |
|---|---|---|
| `id`, `business_id`, `product_id` | uuid | composite FK |
| `kind` | varchar(16) | CHECK `purchase`, `purchase_edit`, `purchase_void`, `adjustment` (5b-তে যোগ হবে `delivery`, `delivery_void`) |
| `quantity` | decimal(14,3) | চিহ্নসহ (+/-), CHECK `<> 0` |
| `balance_after` | decimal(14,3) | এই movement-এর পরের স্টক (পণ্যের সারি লক থাকা অবস্থায় হিসাব হয়), CHECK `>= 0` |
| `movement_date` | date | ব্যবসার তারিখ: কেনায় কেনার তারিখ, বাতিল বা সংশোধনে সেদিনের তারিখ (Dhaka) |
| `source_type`, `source_id` | varchar(16), uuid | `purchase` + কেনার id; সমন্বয়ে `adjustment` + নিজের id |
| `reason` | varchar(500) | CHECK: `adjustment`, `purchase_void` আর `purchase_edit`-এ বাধ্যতামূলক |
| `created_by`, `created_at` | | |

Index:
- `(business_id, product_id, created_at DESC, id DESC)`: পণ্যের স্টক-ইতিহাস, নতুন আগে।
- `(business_id, movement_date)`
- `(business_id, source_type, source_id)`

**শুধু-যোগ নিশ্চিত করা:** একটা DB trigger `UPDATE` আর `DELETE` আটকাবে (ত্রুটি দেবে)। টেস্টের cleanup শুধু `SET LOCAL jesan.allow_purge = 'on'` দিয়ে মুছতে পারবে। production কোডে এটা কোথাও ব্যবহার হবে না, আর CLAUDE.md-তে নিয়ম হিসেবে লেখা থাকবে।

### `products`-এ যোগ

- `current_stock` decimal(14,3), ডিফল্ট `0`, CHECK `>= 0` (স্টক কখনো ঋণাত্মক নয়)।
- স্টক বদলের প্রতিটা ঘটনায় পণ্যের সারি `FOR UPDATE` লক হয়। একাধিক পণ্য থাকলে **id-র ক্রমে** লক হয়, যাতে deadlock না হয়। তারপর atomic `increment`, আর `balance_after` লেখা হয়।
- **সংগতি:** `current_stock` = ওই পণ্যের সব movement-এর যোগফল = শেষ movement-এর `balance_after`। এর জন্য টেস্ট থাকবে, আর `npm run stock:check` script (শুধু পড়ে, অমিল পেলে রিপোর্ট করে)।

### `monthly_purchase_counters`

| কলাম | টাইপ | নিয়ম |
|---|---|---|
| `business_id` | uuid | PK-এর অংশ |
| `period` | int | `YYYYMM` (যেমন `202611`), PK-এর অংশ |
| `quantity` | decimal(14,3) | CHECK `>= 0` |
| `updated_at` | | |

- বাড়ানো বা কমানো হয় একটা atomic upsert-এ: `INSERT … ON CONFLICT DO UPDATE SET quantity = quantity + x`, কেনার একই transaction-এ। ফলে সমান্তরাল কেনায় ভুল হয় না।
- এটা raw SQL, তাই CLAUDE.md অনুযায়ী core-এ একটা সাধারণ সাহায্যকারী হবে: `PeriodCounterService.add(tx, businessId, table, period, delta)`, যা নিজে `business_id` বসায়।
- কাউন্টার শুধু মোট বস্তার (ভাঙা দরকার কি না, প্রশ্ন ২)।
- মাস ধরা হয় **কেনার তারিখ** থেকে। `purchase_date` আগে থেকেই Dhaka-র ক্যালেন্ডার তারিখ, তাই সীমানার ভুল হয় না। "আজ" ঠিক হয় ব্যবসার সময়-অঞ্চলে: config-এ `timezone`, ডিফল্ট `Asia/Dhaka`। যেমন রাত ১২টার পরে ৩১ অক্টোবর থেকে ১ নভেম্বর হলে কেনা নভেম্বরে পড়ে।

### config-এ যোগ

- `codePrefixes.purchase` (ডিফল্ট `PUR`)
- `timezone` (ডিফল্ট `Asia/Dhaka`)
- `stockAdjustmentLimit` (ডিফল্ট `10`, এককে)

পুরনো config যেমন আছে তেমনই চলবে।

---

## ৩. কাজের ধারা

### কেনা তৈরি: `POST /b/:slug/purchases` (অনুমতি `purchase.create`)

body: `{ purchaseDate?, supplierId?, note?, supplierReference?, items: [{ productId, quantity, unitPrice }] }`। লাইন থাকতে হবে ১ থেকে ৫০টা। header-এ `Idempotency-Key` ঐচ্ছিক।

একটাই transaction-এ:
1. সরবরাহকারী আর পণ্যগুলো যাচাই (সক্রিয় ও এই ব্যবসার)।
2. পণ্যগুলো id-র ক্রমে `FOR UPDATE` লক।
3. নম্বর নেওয়া।
4. কেনা আর সব লাইন এক `createMany`-তে লেখা।
5. প্রতিটা পণ্যের জন্য movement (`purchase`, +বস্তা, তারিখ = কেনার তারিখ) এক `createMany`-তে।
6. `current_stock` বাড়ানো।
7. শেষ কেনা-দাম বসানো, যদি এই কেনাই এখন শেষ বৈধ কেনা হয়। নিয়ম: (`purchase_date`, `created_at`) ক্রমে সবচেয়ে নতুন। পুরনো তারিখের কেনা পরে লেখা হলে শেষ কেনা-দাম বদলায় না।
8. কাউন্টারে +মোট বস্তা (কেনার মাসে)।
9. audit `purchase.created`।

কেনা-দামের কেনার ঘর দেখতে কেনা-দাম দেখার অনুমতিও লাগে (`product.cost.view`, ম্যানেজারের আছে)।

idempotency: একই ইউজার একই key আবার পাঠালে আগের কেনা ফেরত আসে, status 200 (4b-র মতো)।

### বাতিল (void): 4b-র `purchase` handler

- **ম্যানেজার:** `POST change-requests` (`entityType: "purchase"`, `kind: "void"`, কারণসহ)। মালিক অনুমোদন দেন।
- **মালিক-স্তর সরাসরি:** `POST purchases/:id/void { reason }` (`purchase.void`)।
- দুটো পথই একই handler-এর `validateVoid` + `applyVoid` চালায়, এক transaction-এ। core-এ একটা ছোট সাধারণ সংযোজন: `ChangeRequestsService.applyDirect(...)`, যাতে সরাসরি পথেও লক, version, audit আর সরাসরি-অনুমতির যাচাই একই থাকে। সরাসরি করলে ওই রেকর্ডের কোনো অপেক্ষমাণ অনুরোধ থাকলে সেটা `stale` হয়ে যায়।
- `validateVoid`: কোনো পণ্যের `current_stock` < ফেরত-বস্তা হলে 409 `STOCK_INSUFFICIENT` (field `items.<itemId>`), উত্তরে উপলব্ধ বস্তা থাকবে। **আপনার সিদ্ধান্ত মতে আটকাবে।**
- `applyVoid`:
  1. কেনা ও লাইন `void` হয়, `voided_*` বসে।
  2. প্রতিটা লাইনের জন্য উল্টো movement `purchase_void` (−বস্তা), **তারিখ বাতিলের দিন**।
  3. `current_stock` কমে।
  4. কাউন্টার −বস্তা (কোন মাসে, প্রশ্ন ১)।
  5. প্রভাবিত পণ্যগুলোর শেষ কেনা-দাম শেষ বৈধ লাইন থেকে পুনর্গণনা হয়, কিছু না থাকলে `null`।
  6. `version` বাড়ে।
- মূল কেনা আর মূল movement অপরিবর্তিত থাকে।

### সংশোধন (edit): 4b-র edit handler

- সংশোধনযোগ্য ঘর:
  - `purchaseDate`
  - প্রতিটা লাইনের `items.<itemId>.quantity` আর `items.<itemId>.unitPrice`
  - `note`, `supplierReference`
- লাইন যোগ বা বাদ, বা পণ্য বদল এই পথে হয় না; তার জন্য বাতিল করে নতুন কেনা (প্রশ্ন ৩)।
- **core-এ ছোট সংযোজন:** handler-এর ঘর এখন একটা নির্দিষ্ট তালিকা। লাইনের ঘর (`items.<id>.quantity`) চেনার জন্য interface-এ ঐচ্ছিক `fieldRule(key)` যোগ হবে। কাঠামো সাধারণই থাকবে, পুরনো handler বদলাবে না।
- অনুমতি:
  - দাম-এর ঘর দেখতে `product.cost.view` লাগে।
  - সরাসরি করতে বা অনুমোদনে লাগে `purchase.edit`।
  - `note` আর `supplierReference` স্পর্শকাতর নয়: `purchase.create` দিয়ে সরাসরি `PATCH`-এ বদলানো যায়, audit-সহ।
- প্রভাবের পূর্বরূপ (preview):
  - প্রতিটা পণ্যের স্টক +/− বস্তা।
  - কেনার মোট আগে → পরে (`product.cost.view`)।
  - শেষ কেনা-দামের বদল (`product.cost.view`)।
  - কাউন্টার: কোন মাসে কত বদলায়, তারিখ বদলালে দুই মাসেই (`commission.view`, তাই ম্যানেজার দেখেন না)।
- প্রয়োগ, এক transaction-এ:
  - বস্তার পার্থক্যটুকু movement `purchase_edit` (চিহ্নসহ, **সংশোধনের দিনের তারিখে**)।
  - `current_stock` atomic।
  - বস্তা কমালে স্টক ঋণাত্মক হলে 409 `STOCK_INSUFFICIENT`।
  - লাইন-মোট ও মোট আবার হিসাব।
  - কাউন্টার: পুরনো মাস থেকে পুরনো বস্তা বাদ, নতুন মাসে নতুন বস্তা যোগ (মাস না বদলালে শুধু পার্থক্য)।
  - শেষ কেনা-দাম পুনর্গণনা।
  - নকল করা `purchase_date` লাইনগুলোতেও বসে।
  - `version` বাড়ে।
- মালিক-স্তর সরাসরি: `PATCH purchases/:id` (`purchase.edit` + `reason`), একই handler-এ।

### স্টক সমন্বয়: `POST /b/:slug/stock/adjustments` (অনুমতি `stock.adjust`)

- body: `{ productId, quantity (চিহ্নসহ), reason }`। কারণ বাধ্যতামূলক, ৩–৫০০ অক্ষর।
- পণ্যের সারি লক হয়, তারপর movement `adjustment`। ফল ঋণাত্মক হলে 409 `STOCK_INSUFFICIENT`। audit `stock.adjusted` (আগে/পরে)।
- **সীমা (প্রস্তাব):**
  - এক সমন্বয়ে `|quantity|` ≤ `stockAdjustmentLimit` (ডিফল্ট ১০ বস্তা) হলে `stock.adjust` দিয়ে সরাসরি।
  - বড় হলে 403 `ADJUSTMENT_NEEDS_APPROVAL`। তখন ম্যানেজার 4b-তে অনুরোধ পাঠান (`entityType: "product_stock"`, ঘর `quantity` = নতুন সংখ্যা)।
  - যাঁর `stock.adjust.large` আছে (নতুন, মালিক-স্তর), তিনি সীমা ছাড়াই সরাসরি করতে পারেন।
  - সীমা ব্যবসার Settings-এ বদলানো যাবে, এখন config দিয়ে।
- সমন্বয়ের নিজের টেবিল লাগে না: movement-ই রেকর্ড (`source_type = 'adjustment'`, `source_id` = movement-এর নিজের id)। ভুল সমন্বয় ঠিক হয় আরেকটা উল্টো সমন্বয়ে, কারণসহ।

---

## ৪. API (`/api/v1/b/:businessSlug/...`)

| Method ও পথ | অনুমতি | কাজ |
|---|---|---|
| `POST purchases` | `purchase.create` (+ `product.cost.view`) | কেনা তৈরি, 201 / একই key-তে 200 |
| `GET purchases?from=&to=&supplierId=&productId=&status=&page=` | `purchase.view` | তালিকা, ১০টা করে, তারিখ অনুযায়ী নতুন আগে |
| `GET purchases/:id` | `purchase.view` | বিস্তারিত, লাইনসহ (দাম ও মোট শুধু `product.cost.view`-এ) |
| `PATCH purchases/:id` | `purchase.create` (নোট/রেফারেন্স), `purchase.edit` + `reason` (বস্তা/দাম/তারিখ) | সংশোধন |
| `POST purchases/:id/void` | `purchase.void` | সরাসরি বাতিল, `{ reason }` |
| `GET stock?search=&categoryId=&page=` | `stock.view` | পণ্য ধরে বর্তমান স্টক (বিক্রয়কর্মী শুধু পরিমাণ দেখেন; `lastPurchasePrice` শুধু `product.cost.view`-এ) |
| `GET stock/:productId/movements?from=&to=&kind=&page=` | `stock.view` | পণ্যের স্টক-ইতিহাস, `balance_after`-সহ, উৎসের কোড (যেমন `PUR-0042`) |
| `POST stock/adjustments` | `stock.adjust` | সমন্বয় (উপরের সীমাসহ) |
| `GET purchase-counters?year=` | `commission.view` (owner-only) | মাস ধরে মোট কেনা বস্তা |
| `POST change-requests` | `change.request` | `entityType: "purchase"` (edit/void) বা `"product_stock"`; 4b-র API, নতুন কিছু নয় |

নতুন ত্রুটির code (CLAUDE.md-র নিয়মে, প্রতিটা `docs/API.md`-তে "কখন আসে"-সহ):
- `PURCHASE_NOT_FOUND`
- `SUPPLIER_NOT_FOUND_OR_INACTIVE` (`supplierId`)
- `PRODUCT_NOT_FOUND_OR_INACTIVE` (`items.<n>.productId`)
- `PRODUCT_DUPLICATE` (`items.<n>.productId`)
- `QUANTITY_INVALID` (`items.<n>.quantity`, এককের দশমিক নিয়ম)
- `PURCHASE_DATE_IN_FUTURE` (`purchaseDate`)
- `PURCHASE_ALREADY_VOID`
- `STOCK_INSUFFICIENT` (৪০৯, উপলব্ধ পরিমাণসহ)
- `ADJUSTMENT_NEEDS_APPROVAL`
- `IDEMPOTENCY_KEY_INVALID`

---

## ৫. অনুমতি

| অনুমতি | owner-only | ডিফল্ট | মানে |
|---|---|---|---|
| `purchase.view` | না | manager | কেনার তালিকা ও বিস্তারিত (দাম ছাড়া, যদি `product.cost.view` না থাকে) |
| `purchase.create` | না | manager | কেনা তৈরি, নোট/রেফারেন্স সংশোধন |
| `purchase.edit` (নতুন) | না | কেউ না (মালিক-স্তর) | বস্তা, দাম, তারিখ সংশোধন সরাসরি বা অনুমোদন |
| `purchase.void` | না | কেউ না (মালিক-স্তর) | সরাসরি বাতিল বা অনুমোদন |
| `stock.view` | না | manager, salesman | বর্তমান স্টক ও ইতিহাস, শুধু পরিমাণ |
| `stock.adjust` | না | manager | সীমার মধ্যে সমন্বয় |
| `stock.adjust.large` (নতুন) | না | কেউ না (মালিক-স্তর) | সীমা ছাড়া সমন্বয়, বড় সমন্বয়ের অনুমোদন |
| `product.cost.view` | না | manager | কেনা-দাম, লাইন-মোট, কেনার মোট, শেষ কেনা-দাম, যেখানেই থাকুক |
| `commission.view` | **হ্যাঁ** | - | মাসিক কেনার কাউন্টার, preview-এর কাউন্টার-লাইন |

- **owner-only শুধু `commission.view`।** কারণ: কাউন্টারটাই কমিশনের অগ্রগতি, আর প্রপোজাল অনুযায়ী কমিশন শুধু platform owner দেখেন।
- `purchase.edit`, `purchase.void`, `stock.adjust.large` owner-only নয়। ব্যবসা-স্তরের `owner` রোলও এগুলো অনুমোদন করতে পারবেন, আর মালিক চাইলে বিশ্বস্ত কাউকে দিতে পারবেন (4b-র নিয়ম)।
- **কেনা-দামের জন্য আলাদা অনুমতি নয়:** `product.cost.view` এক অর্থেই থাকবে (#12-র সিদ্ধান্ত: "কেনা-দাম যেখানেই থাকুক")।
- নতুন অনুমতি হবে দুটো (`purchase.edit`, `stock.adjust.large`), মোট ৪১টা। registry, seed আর `docs/API.md`-র ছকে যোগ হবে।
- কমিশন-সংশ্লিষ্ট কিছু (কাউন্টার, preview-এর কাউন্টার-লাইন) ম্যানেজার বা বিক্রয়কর্মীর উত্তরে যাবে না। এর জন্য `@VisibleWith` আর handler-এর `visibleWith` ব্যবহার হবে, টেস্টসহ।

---

## ৬. 5b (অর্ডার, ডেলিভারি, আদায়) কীভাবে বসবে, এখন বানানো হবে না

- **অর্ডার** (`sales_orders`, `sales_order_items`): দাম অর্ডারেই বসে; ডেলিভারির সময়সীমা (`today`, `two_days`, `one_week`)। **অর্ডারে স্টক বদলায় না।** "প্রতিশ্রুত কিন্তু ডেলিভারি হয়নি" পরে অর্ডার থেকে হিসাব করা যাবে (`available = current_stock − undelivered`), দরকার হলে আলাদা কলামে।
- **ডেলিভারি** (`deliveries`, `delivery_items`):
  - একটা অর্ডারের আংশিক বা পুরো ডেলিভারি হবে।
  - ঐচ্ছিক `transport_reference` ঘর থাকবে (Transport module-এর id বা লেখা; ভাড়া গ্রাহকের কাছ থেকে নয়)।
  - ডেলিভারিতে movement `delivery` (−) হবে, এই PR-এর একই লক-ক্রম, `balance_after` আর ঋণাত্মক-রোধে। বাতিলে `delivery_void` (+), বাতিলের তারিখে।
  - শুধু `kind`-এর CHECK তালিকায় দুটো মান যোগ হবে; বাকি কাঠামো তৈরি।
- **আদায় ও গ্রাহকের ব্যালেন্স:** 5b-র নিজের টেবিল; স্টকের সঙ্গে সম্পর্ক নেই।
- **কমিশন কাউন্টার** শুধু কেনা থেকে, ডেলিভারি থেকে নয় (আপনার নির্দেশ)।

## ৭. ভবিষ্যতে লোকেশন (গুদাম) যোগ করলে

এখন এক পণ্যের একটাই স্টক। পরে লোকেশন এলে নকশা ভাঙবে না:
- `stock_locations` টেবিল যোগ হবে, প্রতিটা ব্যবসায় একটা ডিফল্ট লোকেশন।
- `stock_balances (business_id, product_id, location_id, quantity)` যোগ হবে।
- `stock_movements.location_id` যোগ হবে, পুরনো সারি ডিফল্ট লোকেশনে।
- `products.current_stock` থাকবে **মোট** হিসেবে, একই transaction-এ রক্ষণাবেক্ষণ হবে। ফলে এখনকার API ও রিপোর্ট বদলাবে না, শুধু লোকেশন-ভাঙা যোগ হবে।
- লক-ক্রম আর `balance_after` লোকেশন ধরে হবে।

---

## ৮. পারফরম্যান্স

- **N+1 নেই:**
  - তালিকায় সরবরাহকারীর নাম একই query-তে আসে।
  - বিস্তারিততে লাইন আর পণ্যের নাম দুটো query-তে, `Promise.all`-এ।
  - কেনার সব লাইন, সব movement এক `createMany`-তে।
  - স্টক বাড়ানো প্রতি পণ্যে একটা `update` (লক নেওয়া সারিতে)।
  - শেষ কেনা-দাম আর কাউন্টার প্রতি পণ্য বা মাসে একটা statement।
- তালিকা পাতা-নম্বরে (১০টা) + `total`।
- **মাপ** (নতুন `prisma/seed-perf.mjs`, শুধু dev/perf ডাটাবেসে; production-এ চলবে না):
  - ১ লাখ কেনা (~২ লাখ লাইন) আর ১০ লাখ movement।
  - মাপা হবে কেনার তালিকা (ফিল্টারসহ ও ছাড়া, প্রথম ও গভীর পাতা), স্টকের তালিকা ও অনুসন্ধান, পণ্যের ইতিহাস, কেনা সেভ, বাতিল।
  - লক্ষ্য: পড়া ২০০ms, সেভ ৫০০ms, অনুসন্ধান ৩০০ms।
  - `EXPLAIN (ANALYZE, BUFFERS)`-এর ফল আর সময় `DECISIONS.md`-তে।
  - গভীর পাতা ধীর হলে keyset-এ যাওয়ার প্রস্তাব রিপোর্টে।

## ৯. টেস্ট (Vitest, আসল PostgreSQL)

- **কেনা:** স্টক, movement, কাউন্টার, শেষ কেনা-দাম, মোট। পুরনো তারিখের কেনায় শেষ কেনা-দাম বদলায় না।
- **সমান্তরাল:** ১০টা সমান্তরাল কেনা একই পণ্যে, ফলে স্টক, কাউন্টার আর নম্বর ঠিক। কেনা ও বাতিল একসাথে, deadlock নেই।
- **বাতিল:** উল্টো movement বাতিলের তারিখে, কাউন্টার কমে, শেষ কেনা-দাম পুনর্গণনা (আগের বৈধ কেনায় বা `null`)। বিক্রি বা সমন্বয়ের ফলে স্টক কম থাকলে বাতিল 409 আর কিছুই বদলায় না।
- **সংশোধন:** বস্তা, দাম, তারিখ (মাস বদলসহ); preview-এর লাইন; stale; ঋণাত্মকে আটকানো।
- **সংগতি:** প্রতিটা টেস্টের শেষে movement-যোগফল = `current_stock` = শেষ `balance_after`।
- **অন্যান্য:**
  - idempotency।
  - অন্য ব্যবসার কেনা, পণ্য বা সরবরাহকারীতে 404/400।
  - প্রতিটা অনুমতির সীমা (৪ রোল + platform owner)।
  - ফিল্ড লুকানো: বিক্রয়কর্মী ও দাম-ছাড়া দর্শক, কাউন্টার-লাইন ম্যানেজারের কাছে যায় না।
- **মাসের সীমানা:** ৩০ নভেম্বর রাত ১১:৫৯ আর ১ ডিসেম্বর ০০:০০ Dhaka (UTC-তে আগের দিন ১৮:০০), ৩১ তারিখের মাস, বছর বদল।
- **append-only:** `stock_movements`-এ `UPDATE`/`DELETE` ত্রুটি দেয়।
- **প্রতিটা নতুন ত্রুটির code ও field।**

## ১০. WIP commit-এর ধাপ

1. migration + config + core সাহায্যকারী (`PeriodCounterService`, `fieldRule`, `applyDirect`)।
2. কেনা তৈরি, স্টক, শেষ কেনা-দাম, কাউন্টার + টেস্ট।
3. বাতিল ও সংশোধন handler, সরাসরি পথ + টেস্ট।
4. স্টক তালিকা, ইতিহাস, সমন্বয় + টেস্ট।
5. perf seed ও মাপ।
6. `docs/API.md`, README, `DECISIONS.md`, `CLAUDE.md`।

তারপর CI-র পুরো ক্রম, অ্যাপ চালিয়ে curl, PR, সবুজ হলে merge। রিপোর্টে Mac-এর ধাপ থাকবে: `npm run db:deploy`।

---

## ১১. মালিকের সিদ্ধান্ত (অনুমোদিত)

1. বাতিল ও সংশোধনে কাউন্টার কমে/বদলায় **কেনার মাসে**। period lock পরের ধাপে।
2. কাউন্টার শুধু মোট বস্তা (OPC + PCC মিলিয়ে)।
3. সংশোধন: শুধু বিদ্যমান লাইনের বস্তা ও দাম, তারিখ, নোট (ও রেফারেন্স)। লাইন যোগ/বাদ/পণ্য বদল নয়।
4. পুরনো তারিখ: ভবিষ্যৎ আটকানো। `purchase.edit` নেই এমন ইউজার config `backdateLimitDays` (ডিফল্ট ৭) দিন পর্যন্ত পেছনে; তার বেশি পুরনো তারিখ শুধু `purchase.edit` ধারী। ত্রুটি `PURCHASE_DATE_TOO_OLD` (field `purchaseDate`), টেস্টসহ।
5. সমন্বয়ের সীমা: ডিফল্ট ১০ বস্তা, তবে **প্রতি পণ্য, প্রতি ইউজার, প্রতিদিনের (Dhaka) সমন্বয়ের পরম মানের যোগফলে**, যাতে ভাগ করে সীমা এড়ানো না যায়।
6. Accounts ও `daily_summaries` এই PR-এ নয়।
7. ম্যানেজার কেনার বস্তা দেখেন, কাউন্টার ও কমিশনের অঙ্ক নয়।
8. `lastPurchasedAt` = কেনার তারিখের শুরু (Asia/Dhaka), ISO।
9. `line_total`-এর রাউন্ডিং স্পষ্ট ROUND_HALF_UP: Decimal লাইব্রেরি ও PostgreSQL `round()` (numeric-এ half away from zero, ধনাত্মকে half-up) মেলানো, টেস্টসহ।
10. `stock:check` script শুধু হাতে চালানোর, CI-তে নয়।

## ১২. অগ্রগতি (কাজ থেমে গেলে এখান থেকে শুরু)

- [ ] ১. migration + config + core সাহায্যকারী
- [ ] ২. কেনা তৈরি, স্টক, শেষ কেনা-দাম, কাউন্টার + টেস্ট
- [ ] ৩. বাতিল ও সংশোধন handler, সরাসরি পথ + টেস্ট
- [ ] ৪. স্টক তালিকা, ইতিহাস, সমন্বয় + টেস্ট
- [ ] ৫. perf seed ও মাপ
- [ ] ৬. docs (API.md, README, DECISIONS.md, CLAUDE.md)
- [ ] ৭. যাচাই, PR, merge
