# নতুন ডিলারশিপ ব্যবসা যোগ করা

এই নথি দেখায় একটা নতুন dealership-টাইপ ব্যবসা (যেমন রড/স্টিলের দোকান) যোগ করতে ঠিক কী বদলাতে হবে — **কোনো কোড নয়**, শুধু একটা `businesses` সারি (`config` ঘর) ও তার সঙ্গের seed ডেটা। কোডে কোনো ব্যবসার নাম, একক বা নিয়ম (`akij`, `বস্তা`, `OPC`) ধরা থাকলে সেটা স্থাপত্যের ভুল — `src/core/README.md`-র পরীক্ষা।

যদি নতুন ব্যবসা যোগ করতে `src/` বদলাতে হয়, তাহলে আগে কারণসহ মালিককে জানাতে হবে (CLAUDE.md)।

## `businesses.config` (JSON)

সব ঘর ঐচ্ছিক — না দিলে নিরাপদ ডিফল্ট (`src/modules/dealership/dealership.config.ts`-এর `parseDealershipConfig`)। পুরনো সারিতে নতুন ঘর না থাকলেও চলে।

| ঘর | ধরন | ডিফল্ট | কাজ |
|---|---|---|---|
| `units` | `{key,nameEn,nameBn,decimals}[]` | `[{key:'unit',...,decimals:0}]` | বিক্রির একক; `decimals` ০–৩ |
| `defaultUnit` | string | প্রথম unit-এর key | ডিফল্ট একক |
| `codePrefixes.product/customer/supplier/purchase/order/delivery/collection/expense` | string | `P`/`C`/`S`/`PUR`/`ORD`/`DEL`/`COL`/`EXP` | কোডের উপসর্গ (`A-Z`, ৬ অক্ষর পর্যন্ত) |
| `principalSupplier` | `{nameEn,nameBn}` | নেই | থাকলে seed নিজে একটা সরবরাহকারী বানায় |
| `timezone` | IANA zone | `Asia/Dhaka` | ব্যবসার দিন কোথায় শুরু/শেষ |
| `backdateLimitDays` | number (০–৩৬৬০) | ৭ | কর্মী কত দিন পেছনের তারিখ দিতে পারে (কেনা, অর্ডার, ডেলিভারি, আদায়, খরচ) |
| `stockAdjustmentLimit` | number | ১০ | প্রতিদিন প্রতি পণ্যে প্রতি জনের সর্বোচ্চ স্টক সমন্বয় |
| `creditLimitMode` | `'warn'` \| `'block'` | `'warn'` | ক্রেডিট সীমা পার হলে আটকানো হবে কিনা |
| `collectionMethods` | string[] | `['cash','bkash','nagad','bank','cheque']` | আদায়ের পদ্ধতি |
| `expenseMethods` | string[] | `collectionMethods`-এর মান | খরচের পদ্ধতি |
| `cashMethodKeys` | string[] | `['cash']` | এর মধ্যে কোন পদ্ধতিগুলো নগদ (ক্যাশ বইয়ের নগদ/ব্যাংক ভাগ) |
| `defaultExpenseCategories` | `{nameEn,nameBn}[]` | `seed-helpers.mjs`-এর নিরপেক্ষ তালিকা (বেতন, ভাড়া, বিদ্যুৎ, যানবাহন ও জ্বালানি, আপ্যায়ন, অন্যান্য) | শুধু seed পড়ে — একবার বসানোর পরে ধরন বদলাতে ব্যবসার Settings বা ডাটাবেস থেকেই |

পদ্ধতির key-র রূপ `/^[a-z][a-z0-9_]{0,15}$/`, উপসর্গের রূপ `/^[A-Z][A-Z0-9]{0,5}$/`, unit key-র রূপ `/^[a-z][a-z0-9_]{0,15}$/` — ভুল রূপ বা তালিকা খালি হলে নিরাপদ ডিফল্টে পড়ে, ত্রুটি দেয় না।

## seed-এ কী করতে হবে

1. **`prisma/seed.mjs`**-এর `businesses` তালিকায় একটা নতুন object যোগ করো: `slug`, `nameEn`, `nameBn`, `type: 'dealership'`, `config`। আসল ব্যবসার তথ্য ছাড়া কিছু এখানে যাবে না।
2. বাকি সবকিছু (সরবরাহকারী, খরচের ধরন) আপনাআপনি হয়:
   - `principalSupplier` দেওয়া থাকলে একটা সরবরাহকারী বসে (শুধু যে ব্যবসায় একটাও নেই)।
   - খরচের ধরন `defaultExpenseCategories` থেকে, না থাকলে নিরপেক্ষ fallback (শুধু যে ব্যবসায় একটাও নেই)।
3. `npm run db:seed` চালাও (idempotent — পুরনো সারি বদলায় না)।
4. নমুনা মাস্টার ডেটা (ক্যাটাগরি, পণ্য, গ্রাহক) চাইলে `prisma/seed-dev.mjs`-এ, production-এ চলে না।

## উদাহরণ: টন/কেজির রড-ব্যবসা

```js
{
  slug: 'city-rods',
  nameEn: 'City Rod Traders',
  nameBn: 'সিটি রড ট্রেডার্স',
  type: 'dealership',
  config: {
    units: [
      { key: 'kg', nameEn: 'Kilogram', nameBn: 'কেজি', decimals: 3 },
      { key: 'ton', nameEn: 'Ton', nameBn: 'টন', decimals: 3 },
    ],
    defaultUnit: 'ton',
    codePrefixes: { product: 'RD', customer: 'RC', supplier: 'RS', expense: 'RE' },
    expenseMethods: ['cash', 'bank'],
    cashMethodKeys: ['cash'],
    defaultExpenseCategories: [
      { nameEn: 'Wages', nameBn: 'মজুরি' },
      { nameEn: 'Freight', nameBn: 'পরিবহন' },
    ],
  },
}
```

এই config-এ কোনো কোড বদলাতে হয়নি — `test/expenses.e2e-spec.ts` ও `test/master-data.e2e-spec.ts` ঠিক এই ধরনের দ্বিতীয় config দিয়ে পুরো প্রবাহ (দশমিক একক, ভিন্ন উপসর্গ, ভিন্ন পদ্ধতি) যাচাই করে, কোনো `src/` বদল না করেই।

## পরে যা একই থাকে

- খরচের ধরন, পদ্ধতির তালিকা, ক্রেডিট সীমার নিয়ম — সবই ব্যবসার Settings থেকে বদলানো যায় (এখনো API নয়, সরাসরি ডাটাবেস/seed; Settings API ভবিষ্যতের ধাপ)।
- `src/modules/dealership`-এর কোনো ফাইল বদলাতে হবে না; `src/core`-এ ব্যবসার নাম বা নিয়ম থাকার কথাই নয়।
