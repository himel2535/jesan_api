# Step 5b: গ্রাহকের অর্ডার, ডেলিভারি ও টাকা আদায় (প্ল্যান)

অবস্থা: **স্বয়ংক্রিয় মোড** (মালিক অনুপস্থিত; নিচের সিদ্ধান্ত ১–৮ আগে থেকে অনুমোদিত)। Branch: `claude/step-5b-orders-deliveries`। অগ্রগতি: `docs/plans/step-5b-progress.md`।

ভিত্তি:
- প্রপোজাল ৭.৫, ৭.৬, ৯.৩, ১০
- Step 4a: `forBusiness`, `DocumentCounterService`
- Step 4b: `ChangeHandler`, `applyDirect`
- Step 5a: `StockLedger`, `business-time`, `lockRows`, `idempotencyKeyOf`
- CLAUDE.md-র ত্রুটির code-এর নিয়ম

## ১. ব্যবসার প্রবাহ

1. **অর্ডার:** গ্রাহক অর্ডার দেন। দাম অর্ডারেই বসে (প্রতি লাইনে), সাথে ডেলিভারির সময়সীমা: `today`, `two_days`, `one_week`, আর ঐচ্ছিক নির্দিষ্ট তারিখ। অর্ডারে **স্টক বা টাকা বদলায় না**। শুধু গ্রাহকের "ডেলিভারি বাকি" বস্তা বাড়ে।
2. **ডেলিভারি:** একটা অর্ডারের আংশিক বা পুরো। ঐচ্ছিক পরিবহন রেফারেন্স থাকে (Transport module পরে; ভাড়া গ্রাহকের কাছ থেকে নেওয়া হয় না)। একই transaction-এ:
   - স্টক কমে (`delivery` movement)।
   - অর্ডারের ডেলিভারি-হওয়া বস্তা বাড়ে।
   - গ্রাহকের পাওনা বাড়ে (বস্তা × অর্ডারের দাম)।
   - গ্রাহকের খাতায় এন্ট্রি পড়ে।
3. **আদায়:** নগদ, bKash, Nagad, ব্যাংক বা চেক (ব্যবসার config-এর তালিকা)। গ্রাহকের ব্যালেন্সে সরাসরি যায়। ঐচ্ছিক অর্ডার-রেফারেন্স থাকে (যেমন অগ্রিম কোন অর্ডারের জন্য), তবে **অর্ডারে বরাদ্দ হয় না**। পাওনার বেশি আদায় চলে; তাতে ব্যালেন্স ঋণাত্মক হয়, অর্থাৎ অগ্রিম।

## ২. ডাটাবেস (একটা migration)

সব টেবিলে `business_id` আর composite FK `(business_id, …)`। টাকা `Decimal(14,2)`, পরিমাণ `Decimal(14,3)`। কিছুই মোছা হয় না।

| টেবিল | মূল কলাম | নিয়ম |
|---|---|---|
| `sales_orders` | `code` (`ORD-0001`), `customer_id`, `order_date`, `delivery_window`, `deliver_by?`, `total_quantity`, `delivered_quantity`, `total_amount`, `status`, `note`, `idempotency_key`, `version`, `created_by`, void-এর ঘর | CHECK `0 <= delivered <= total`; `deliver_by >= order_date`; window তালিকা |
| `sales_order_items` | `order_id`, `product_id`, `quantity`, `delivered_quantity`, `unit_price`, `line_total` | এক অর্ডারে এক পণ্য একবার; `line_total = round(q × p, 2)` |
| `deliveries` | `code` (`DEL-0001`), `order_id`, `customer_id`, `delivery_date`, `transport_reference?`, `total_quantity`, `total_amount`, `credit_limit_exceeded`, `status`, `note`, `idempotency_key`, `version`, void-এর ঘর | |
| `delivery_items` | `delivery_id`, `order_item_id`, `product_id`, `quantity`, `unit_price`, `line_total`, `status` | এক ডেলিভারিতে একটা অর্ডার-লাইন একবার |
| `collections` | `code` (`COL-0001`), `customer_id`, `order_id?`, `collection_date`, `method`, `amount`, `reference?`, `note`, `status`, `idempotency_key`, `version`, void-এর ঘর | `amount > 0` |
| `customer_ledger_entries` | `customer_id`, `kind`, `amount` (চিহ্নসহ, + মানে পাওনা বাড়ে), `entry_date`, `source_type`, `source_id`, `reason`, `created_by` | **শুধু-যোগ-হয়** (trigger, স্টক খাতার মতো) |
| `customers`-এ যোগ | `pending_delivery_quantity`, `delivered_amount`, `collected_amount` | সব `>= 0` |

- **সংগতি:** `current_balance = opening_balance + delivered_amount − collected_amount`, আর খাতার যোগফল = `delivered_amount − collected_amount`। একই transaction-এ রক্ষণাবেক্ষণ হয়, script (`npm run consistency:check`) আর টেস্টে যাচাই হয়।
- **`stock_movements`:** `kind`-এর CHECK-এ যোগ হয় `delivery`, `delivery_edit`, `delivery_void`; `source_type`-এ যোগ হয় `delivery`।
- **Index:**
  - প্রতিটা তালিকায় `(business_id, তারিখ DESC, id DESC)`।
  - গ্রাহক ধরে `(business_id, customer_id, তারিখ DESC)`।
  - বিক্রয়কর্মীর নিজের অর্ডার `(business_id, created_by, order_date DESC)`।
  - `(business_id, order_id)`।
  - গ্রাহকের খাতা `(business_id, customer_id, created_at DESC, id DESC)`।
- **config** (সব ঐচ্ছিক):
  - `codePrefixes.order` / `.delivery` / `.collection` (`ORD` / `DEL` / `COL`)
  - `creditLimitMode` (`warn` ডিফল্ট, বা `block`)
  - `collectionMethods` (ডিফল্ট `cash`, `bkash`, `nagad`, `bank`, `cheque`)

## ৩. নিয়ম

- **ক্রেডিট সীমা** (সিদ্ধান্ত ১): শুধু নতুন ডেলিভারিতে দেখা হয়। নিয়ম: ডেলিভারির পরের ব্যালেন্স > সীমা।
  - `warn` মোডে ডেলিভারি হয়; উত্তরে আর ডেলিভারিতে `creditLimitExceeded: true` থাকে।
  - `block` মোডে 409 `CREDIT_LIMIT_EXCEEDED` (field `items`, `details`: সীমা ও পরের ব্যালেন্স)।
  - নতুন অনুমতি `delivery.credit.override` (মালিক-স্তর) থাকলে block মোডেও ডেলিভারি হয়, পতাকাসহ।
- **ডেলিভারি** (সিদ্ধান্ত ৪):
  - অর্ডার-লাইনের বাকি বস্তার বেশি হলে 400 `DELIVERY_QUANTITY_TOO_LARGE` (`details.remaining`)।
  - স্টক কম হলে 409 `STOCK_INSUFFICIENT`।
  - বাতিল অর্ডারে 409 `ORDER_ALREADY_VOID`।
- **অর্ডার বাতিল** (সিদ্ধান্ত ৫):
  - সক্রিয় ডেলিভারি থাকলে 409 `DELIVERY_EXISTS`; আগে সেগুলো বাতিল করতে হবে।
  - অগ্রিম ফেরত আলাদা এন্ট্রি: সেই আদায় বাতিল হয় (উল্টো খাতা-এন্ট্রি, বাতিলের দিনে)।
- **সংশোধন** (সিদ্ধান্ত ৬, সব 4b-র handler-এ, প্রভাবের পূর্বরূপসহ):
  - অর্ডার: লাইনের বস্তা (ডেলিভারি-হওয়ার নিচে নয়) ও দাম, সময়সীমা, তারিখ, নোট। দাম বদলালে আগে ডেলিভারি-হওয়া অংশের মূল্য, ব্যালেন্স আর খাতাও বদলায় (খাতায় `delivery_edit`, সংশোধনের দিনে)।
  - ডেলিভারি: লাইনের বস্তা বাড়ানো বা কমানো (স্টক, অর্ডারের বাকি, ব্যালেন্স একসাথে), তারিখ, রেফারেন্স, নোট।
  - আদায়: টাকা, পদ্ধতি, তারিখ, রেফারেন্স, নোট।
- **বাতিল:** স্টক আর খাতার উল্টো এন্ট্রি বাতিলের দিনের তারিখে; মূল এন্ট্রি অপরিবর্তিত।
- **তারিখ:** ভবিষ্যৎ আটকানো। সংশোধনের অনুমতি নেই এমন স্টাফ শুধু `backdateLimitDays` (৭) দিন পেছনে।
- **লকের ক্রম** (deadlock এড়াতে, সব পথে একই): অনুরোধ, তারপর দলিল (অর্ডার/ডেলিভারি/আদায়), তারপর ডেলিভারির অর্ডার, তারপর পণ্য (id-ক্রমে), তারপর গ্রাহক।
- **idempotency key:** অর্ডার, ডেলিভারি আর আদায় তিনটাতেই।

## ৪. অনুমতি (সিদ্ধান্ত ৭)

| অনুমতি | নতুন? | ডিফল্ট | মানে |
|---|---|---|---|
| `sale.create` | না | manager, salesman | অর্ডার তৈরি |
| `sale.view.all` / `sale.view.own` | না | manager / salesman | সব অর্ডার / নিজের অর্ডার |
| `sale.edit` | হ্যাঁ | মালিক-স্তর | অর্ডারের সংশোধন |
| `sale.void` | না | মালিক-স্তর | অর্ডার বাতিল |
| `delivery.view`, `delivery.create` | হ্যাঁ | manager | ডেলিভারি দেখা ও তৈরি |
| `delivery.edit`, `delivery.void` | হ্যাঁ | মালিক-স্তর | ডেলিভারি সংশোধন ও বাতিল |
| `delivery.credit.override` | হ্যাঁ | মালিক-স্তর | block মোডে ক্রেডিট সীমা পার হয়ে ডেলিভারি |
| `collection.create` | না | manager, accountant | আদায় তৈরি |
| `collection.view` | হ্যাঁ | manager, accountant | আদায় দেখা |
| `collection.edit`, `collection.void` | হ্যাঁ | মালিক-স্তর | আদায় সংশোধন ও বাতিল |

কোনোটাই owner-only নয়। কমিশন বা লাভের কিছুই এই ধাপে আসবে না। মোট অনুমতি হবে ৫০টা।

## ৫. API (`/b/:businessSlug/...`)

| পথ | কাজ |
|---|---|
| `POST/GET orders`, `GET/PATCH orders/:id`, `POST orders/:id/void` | অর্ডার |
| `POST/GET deliveries`, `GET/PATCH deliveries/:id`, `POST deliveries/:id/void` | ডেলিভারি |
| `POST/GET collections`, `GET/PATCH collections/:id`, `POST collections/:id/void`, `GET collection-methods` | আদায় |
| `GET customers/:id/ledger` | গ্রাহকের খাতা (`customer.due.view`) |
| গ্রাহকের উত্তরে নতুন ঘর | `pendingDeliveryQuantity` (সবাই), `deliveredAmount`, `collectedAmount` (`customer.due.view`) |
| `POST change-requests` | `entityType`: `sales_order`, `delivery`, `collection` (4b-র API) |

তালিকা ১০টা করে, নতুন আগে।

## ৬. টেস্ট

- অর্ডার: তৈরি, নিজের বনাম সব দেখা।
- আংশিক ডেলিভারি, বাকির বেশি ডেলিভারি, স্টক কম।
- ক্রেডিট: warn, block, override।
- আদায়: অগ্রিম ও ঋণাত্মক ব্যালেন্স, পদ্ধতির তালিকা।
- প্রতিটা বাতিল ও সংশোধন, প্রভাবের পূর্বরূপসহ।
- সমান্তরাল দুই ডেলিভারি একই বাকির জন্য।
- idempotency, অন্য ব্যবসা 404, প্রতিটা অনুমতির সীমা, লুকানো ঘর।
- সংগতি: ব্যালেন্স = শুরুর বাকি + ডেলিভারি − আদায় = শুরুর বাকি + খাতা; স্টক = movement।

## ৭. স্বয়ংক্রিয় সিদ্ধান্ত: পর্যালোচনা দরকার

মালিক অনুপস্থিত থাকায় এগুলো আমি নিয়েছি। সব নিরাপদ এবং পরে ফেরানো যায়।

1. **অর্ডারের অনুমতি:** নতুন `order.*` না বানিয়ে আগে থেকে ঘোষিত `sale.*` ব্যবহার, আর `sale.edit` যোগ। কারণ: Settings-এ এগুলো আগেই আছে, আর অনুমতি সরাতে হলে ডেটা migration লাগত।
2. **গ্রাহকের খাতা আলাদা টেবিল** (`customer_ledger_entries`, শুধু-যোগ-হয়)। কারণ: বাতিলের উল্টো এন্ট্রি বাতিলের তারিখে রাখা আর গ্রাহকের statement দেখানো। খাতায় `balance_after` রাখা হয়নি, কারণ শুরুর বাকি পরে সংশোধন হলে পুরনো সংখ্যা ভুল হয়ে যেত।
3. **অর্ডার বাতিলে আদায় আপনা থেকে বদলায় না।** অগ্রিম গ্রাহকের ঋণাত্মক ব্যালেন্স (জমা) হিসেবে থাকে। টাকা ফেরত দিলে সেই আদায় বাতিল করতে হয়। কারণ: স্বয়ংক্রিয় ফেরত ভুল হলে টাকার ক্ষতি; হাতে বাতিল নিরাপদ ও ফেরানো যায়।
4. **ক্রেডিট সীমা শুধু নতুন ডেলিভারিতে** দেখা হয়, সংশোধনে নয়। সংশোধন মালিক-স্তরের, তাঁরা নিজেই সীমা দেখে সিদ্ধান্ত নেন।
5. **block মোডের ত্রুটি:** 409 `CREDIT_LIMIT_EXCEEDED`, field `items`, কারণ ডেলিভারির পরিমাণই সীমা পার করায়।
6. **ব্যালেন্সের বদলে গ্রাহকের `version` বাড়ে না।** নইলে প্রতিটা ডেলিভারির পরে গ্রাহকের ক্রেডিট সীমার অপেক্ষমাণ অনুরোধ stale হয়ে যেত।
7. **অর্ডারের সব ঘরের সংশোধন** (নোট ও সময়সীমা সহ) `sale.edit`-এ। কারণ: `sale.create` দিলে বিক্রয়কর্মী অন্যের অর্ডারও বদলাতে পারতেন।
8. **নিষ্ক্রিয় গ্রাহক:** নতুন অর্ডার নেওয়া হয় না, কিন্তু আগের অর্ডারের ডেলিভারি আর আদায় চলে।
9. **বিক্রয়কর্মী ডেলিভারির তালিকা দেখেন না।** নিজের অর্ডারের বিস্তারিততে সেই অর্ডারের ডেলিভারির সারাংশ দেখেন।
10. **ডেলিভারির মূল্য সবসময় অর্ডারের বর্তমান দামে।** দাম সংশোধন হলে আগে ডেলিভারি-হওয়া লাইনের মূল্যও বদলায় (সিদ্ধান্ত ৬)।
11. **লাইন যোগ বা বাদ সংশোধনে নয়** (Step 5a-র কেনার মতো); তার জন্য বাতিল + নতুন।
12. **একটা ডেলিভারি একটাই অর্ডারের।**
13. **`daily_summaries` আর Accounts এই ধাপে নয়।**
14. **গ্রাহকের তালিকায় নতুন ফিল্টার নেই।** শুধু সারাংশ কলাম যোগ হয় (সিদ্ধান্ত ৮)।
