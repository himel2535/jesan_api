# Step 6 অগ্রগতি

Branch: `claude/step-6-expenses-cashbook-reports`। প্ল্যান: `docs/plans/step-6.md`। সেশন থামলে নতুন সেশন এখান থেকে ধরবে।

- [x] ০. প্ল্যান ও অগ্রগতির ফাইল
- [x] ১. migration + schema + config + অনুমতি + tenant models
- [x] ২. খরচের ধরন: CRUD + change handler + টেস্ট
- [x] ৩. খরচ: তৈরি, তালিকা, বিস্তারিত, idempotency + টেস্ট
- [x] ৪. `ExpenseChangeHandler`: সংশোধন ও বাতিল + টেস্ট
- [x] ৫. ক্যাশ বই + `consistency:check` + টেস্ট
- [ ] ৬. ছয়টা রিপোর্ট + টেস্ট
- [ ] ৭. perf seed, মাপ, index যাচাই → DECISIONS.md
- [ ] ৮. docs (API.md, adding-a-business.md, README.md, CLAUDE.md, DECISIONS.md)
- [ ] ৯. যাচাই, PR, merge, চূড়ান্ত রিপোর্ট

## কোডের অবস্থা

- ধাপ ০–৫ শেষ। নতুন টেস্ট: `test/expenses.e2e-spec.ts` (১৩টা), `test/expense-changes.e2e-spec.ts` (১০টা), `test/cash-book.e2e-spec.ts` (৬টা)। পুরো suite ৩২০/৩২০ পাস (লোকাল PostgreSQL ১৬)। `npm run consistency:check` সবুজ।
- প্ল্যান থেকে ছোট বদল:
  - `PATCH expenses/:id`-এ `@RequirePermission('expense.edit')` (প্ল্যানে `expense.view` ছিল)। কারণ: Step 5b-র collections-এর সঙ্গে মিল; কর্মী এমনিতেই অনুরোধের পথে যায়।
  - `GET expense-categories` পাতাভাগ ছাড়া (`?active=` আছে)। কারণ: ধরন অল্প, পণ্যের ক্যাটাগরির মতোই।
  - covering index-এ `INCLUDE` নয়, সব কলাম key-তে। কারণ: Prisma `INCLUDE` লিখতে পারে না, আর `db:check` সবুজ রাখতে হবে।
  - `expense_category` change handler-ও যোগ হয়েছে (ধরন নিষ্ক্রিয় করার অনুরোধ), পণ্যের ক্যাটাগরির মতো।

## নোট

- এই সেশন cloud container-এ চলছে: repo `/home/user/jesan_api`-তে clone করা, লোকাল PostgreSQL ১৬-তে `jesan_test` ও `jesan_perf` ডাটাবেস, `.env` ও `.env.perf` gitignored।

### ধাপ ৫ নোট
- ক্যাশ বই কোনো টেবিল নয়: তিন উৎসের `groupBy`/`aggregate` (collections, expenses,
  cash purchases), `Promise.all`-এ, লুপে query নয়।
- পাতাভাগ দিনের উপর (PAGE_SIZE=10); প্রতিটা পাতার শুরুর ব্যালেন্স আগের দিনগুলোর
  যোগফল থেকে গণনা (একই request-এ, ডাটাবেসে আলাদা query নয়)।
- `resolveDateRange` ব্যবহার করে ডিফল্ট চলতি মাস ও সর্বোচ্চ ৪০০ দিন (business-dates.ts)।
- `consistency:check`-এ নতুন দুটো block: ক্যাশ বইয়ের মোট (সরাসরি যোগফল বনাম
  দিনভিত্তিক যোগফল) আর active খরচের ধরন নিজের ব্যবসার কিনা (FK already guarantees;
  defensive)।
