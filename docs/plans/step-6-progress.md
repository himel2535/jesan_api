# Step 6 অগ্রগতি

Branch: `claude/step-6-expenses-cashbook-reports`। প্ল্যান: `docs/plans/step-6.md`। সেশন থামলে নতুন সেশন এখান থেকে ধরবে।

- [x] ০. প্ল্যান ও অগ্রগতির ফাইল
- [ ] ১. migration + schema + config + অনুমতি + tenant models
- [ ] ২. খরচের ধরন: CRUD + change handler + টেস্ট
- [ ] ৩. খরচ: তৈরি, তালিকা, বিস্তারিত, idempotency + টেস্ট
- [ ] ৪. `ExpenseChangeHandler`: সংশোধন ও বাতিল + টেস্ট
- [ ] ৫. ক্যাশ বই + `consistency:check` + টেস্ট
- [ ] ৬. ছয়টা রিপোর্ট + টেস্ট
- [ ] ৭. perf seed, মাপ, index যাচাই → DECISIONS.md
- [ ] ৮. docs (API.md, adding-a-business.md, README.md, CLAUDE.md, DECISIONS.md)
- [ ] ৯. যাচাই, PR, merge, চূড়ান্ত রিপোর্ট

## কোডের অবস্থা

- ধাপ ০ শেষ।

## নোট

- এই সেশন cloud container-এ চলছে: repo `/home/user/jesan_api`-তে clone করা, লোকাল PostgreSQL ১৬-তে `jesan_test` ও `jesan_perf` ডাটাবেস, `.env` ও `.env.perf` gitignored।
