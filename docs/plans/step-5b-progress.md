# Step 5b অগ্রগতি

Branch: `claude/step-5b-orders-deliveries`। প্ল্যান: `docs/plans/step-5b.md`। সেশন থামলে নতুন সেশন এখান থেকে ধরবে।

- [x] ০. প্ল্যান ফাইল
- [x] ১. migration (orders, deliveries, collections, customer ledger, customers-এর সারাংশ কলাম, stock kind) + config + অনুমতি
- [ ] ২. অর্ডার: তৈরি, তালিকা, বিস্তারিত + টেস্ট
- [ ] ৩. ডেলিভারি: তৈরি (স্টক, ব্যালেন্স, খাতা, ক্রেডিট সীমা), তালিকা + টেস্ট
- [ ] ৪. আদায় ও গ্রাহকের খাতা + টেস্ট
- [ ] ৫. বাতিল ও সংশোধন handler (sales_order, delivery, collection) + টেস্ট
- [ ] ৬. consistency:check script, পারফরম্যান্স মাপ
- [ ] ৭. docs (API.md, README, DECISIONS.md, CLAUDE.md)
- [ ] ৮. যাচাই, PR, merge, চূড়ান্ত রিপোর্ট

## কোডের অবস্থা

- ধাপ ২–৫-এর কোড লেখা হয়েছে (orders, deliveries, collections, ledger, তিনটা change handler, controller, module wiring, গ্রাহকের সারাংশ ঘর)। type-check ও lint পরিষ্কার। **নতুন e2e টেস্ট এখনো বাকি**; পরের ধাপে লেখা হবে।
- প্ল্যান থেকে ছোট বদল:
  - `sales_orders`-এ `delivery_status` কলাম যোগ (pending/partial/delivered, পরিমাণের সঙ্গে CHECK-এ মেলানো), তালিকার ফিল্টার index থেকে পড়ার জন্য।
  - লকের ক্রম চূড়ান্ত: অনুরোধ → অর্ডার → ডেলিভারি/আদায় → গ্রাহক → পণ্য। ডেলিভারির সংশোধন বা বাতিলেও আগে অর্ডার লক হয়, যাতে অর্ডারের দাম-সংশোধনের সঙ্গে deadlock না হয়।

## নোট

- ধাপ ১-এ ধরা পড়া: Step 5a-র তিনটা টেস্ট ফাইল (`purchases`, `purchase-changes`, `stock`) প্রথম `runSeed()`-এর আগে ব্যবসা বানাত। নতুন ডাটাবেসে তখন রোল থাকে না, তাই ম্যানেজার ডিফল্ট অনুমতি পেত না। আগে অন্য ফাইল আগে seed করত বলে CI সবুজ ছিল; ফাইলের ক্রম বদলালেই ভাঙত। এখন প্রতিটা ফাইল শুরুতেই seed করে।
