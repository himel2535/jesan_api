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

## CI (GitHub Actions)

`.github/workflows/ci.yml` প্রতিটা PR-এ এবং `main`-এ push হলে Node 22-এ (`.nvmrc` থেকে) চালায়: `npm ci` → lint → type-check → test → build। এই চেক সবুজ না হলে merge নয়। নতুন চেক বা script যোগ হলে workflow-ও হালনাগাদ করো।

## প্রতিটা কাজের পর (বাধ্যতামূলক)

1. অ্যাপ চালিয়ে দেখো: `npm run start`, তারপর `curl localhost:4000/api/v1/health`
2. `npm run lint`
3. `npm run type-check`
4. `npm test`
5. `npm run build`

পাঁচটাই পাস না করলে কাজ শেষ নয়, commit নয়।

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

`npm run start:dev` · `npm run build` · `npm run lint` · `npm run type-check` · `npm test` · `npm run format`
