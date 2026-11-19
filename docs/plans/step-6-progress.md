# Step 6 অগ্রগতি

Branch: `claude/step-6-expenses-cashbook-reports`। প্ল্যান: `docs/plans/step-6.md`। সেশন থামলে নতুন সেশন এখান থেকে ধরবে।

- [x] ০. প্ল্যান ও অগ্রগতির ফাইল
- [x] ১. migration + schema + config + অনুমতি + tenant models
- [x] ২. খরচের ধরন: CRUD + change handler + টেস্ট
- [x] ৩. খরচ: তৈরি, তালিকা, বিস্তারিত, idempotency + টেস্ট
- [x] ৪. `ExpenseChangeHandler`: সংশোধন ও বাতিল + টেস্ট
- [ ] ৫. ক্যাশ বই + `consistency:check` + টেস্ট
- [ ] ৬. ছয়টা রিপোর্ট + টেস্ট
- [ ] ৭. perf seed, মাপ, index যাচাই → DECISIONS.md
- [ ] ৮. docs (API.md, adding-a-business.md, README.md, CLAUDE.md, DECISIONS.md)
- [ ] ৯. যাচাই, PR, merge, চূড়ান্ত রিপোর্ট

## কোডের অবস্থা

- ধাপ ০–৪ শেষ। নতুন টেস্ট: `test/expenses.e2e-spec.ts` (১৩টা), `test/expense-changes.e2e-spec.ts` (১০টা)। পুরো suite ৩১৪/৩১৪ পাস (লোকাল PostgreSQL ১৬)।
- প্ল্যান থেকে ছোট বদল:
  - `PATCH expenses/:id`-এ `@RequirePermission('expense.edit')` (প্ল্যানে `expense.view` ছিল)। কারণ: Step 5b-র collections-এর সঙ্গে মিল; কর্মী এমনিতেই অনুরোধের পথে যায়।
  - `GET expense-categories` পাতাভাগ ছাড়া (`?active=` আছে)। কারণ: ধরন অল্প, পণ্যের ক্যাটাগরির মতোই।
  - covering index-এ `INCLUDE` নয়, সব কলাম key-তে। কারণ: Prisma `INCLUDE` লিখতে পারে না, আর `db:check` সবুজ রাখতে হবে।
  - `expense_category` change handler-ও যোগ হয়েছে (ধরন নিষ্ক্রিয় করার অনুরোধ), পণ্যের ক্যাটাগরির মতো।

## নোট

- এই সেশন cloud container-এ চলছে: repo `/home/user/jesan_api`-তে clone করা, লোকাল PostgreSQL ১৬-তে `jesan_test` ও `jesan_perf` ডাটাবেস, `.env` ও `.env.perf` gitignored।
