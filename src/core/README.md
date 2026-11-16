# core

সব ব্যবসার জন্য এক ও অভিন্ন অংশ। প্রপোজাল সেকশন ৩ অনুযায়ী এখানে থাকবে: auth ও রোল, businesses registry, module manifest, ledger/accounts ইঞ্জিন, document numbering, audit log, settings, report/export কাঠামো।

## নিয়ম

- core কোনো ব্যবসার নাম বা নিয়ম জানে না। এখানে `akij` বা `bsrm` শব্দ থাকলে সেটা ভুল।
- core কখনো `src/modules/*` থেকে কিছু import করে না। module-রা core ব্যবহার করে, উল্টোটা নয়।
- পাস-ফেল পরীক্ষা: নতুন ব্যবসা যোগ করতে core-এর কোনো ফাইল বদলাতে হলে স্থাপত্য ঠিক হয়নি।

## এখন যা আছে

- `config/`: environment variable ভ্যালিডেশন (`PORT`, `NODE_ENV`, `CORS_ORIGIN`)।
- `health/`: `GET /api/v1/health`।
