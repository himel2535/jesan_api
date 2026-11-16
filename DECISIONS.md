# DECISIONS.md

সিদ্ধান্ত ও ভার্সনের খাতা। নতুন সিদ্ধান্ত নিচে যোগ হবে, তারিখসহ।

## ২০২৬-১১-১৬: শুরুর কাঠামো

### Node.js: 22 LTS (প্রপোজালের 26 LTS নয়)

- প্রপোজাল (সেকশন ৪) Node 26 LTS চেয়েছিল। কিন্তু ডেভেলপারের Mac macOS 12.7.6-এ আটকে আছে (ওই Mac-এর শেষ সংস্করণ, আপডেট করা যায় না), তাই **Node 22 LTS** নেওয়া হয়েছে। লোকাল: v22.23.5, ক্লাউড: v22.23.4, npm 10.9.9।
- `.nvmrc` = `22`, `package.json` engines = `node >=22.12` (Vitest 5 চায় `^22.12.0`, ESLint 10 চায় `^22.13.0`)।
- Mac বদলালে বা সার্ভারে deploy-এর সময় Node 24/26-এ যাওয়া হবে। `@types/node` সেজন্য 22.x-এ রাখা, তখন একসাথে বাড়বে।

### TypeScript: 6.0.3 (সর্বশেষ 7.0.2 নয়)

- `typescript-eslint@8.72.2`-এর peer `typescript >=4.8.4 <6.1.0`, আর `@nestjs/cli@12.0.13` নিজে `typescript ~6.0.2` ব্যবহার করে। TS 7 নিলে `--force` লাগত, যা নীতিতে নিষেধ।
- typescript-eslint ও Nest CLI TS 7 সাপোর্ট দিলে আপগ্রেড।

### Prisma (এখন install হয়নি, শুধু নোট)

- npm-এ `prisma`-র `latest` ট্যাগ = `8.0.0-rc.33` (**RC, নেওয়া যাবে না**)। Stable = **7.10.1** (`prisma`-র `prev` ট্যাগ; `@prisma/client`-এর `latest` = 7.10.1)।
- install-এর সময়: `npm install prisma@7 @prisma/client@7`। Prisma 8 GA হলে তবেই আপগ্রেড।

### টেস্ট: Vitest 5 + SWC (Jest/ts-jest নয়)

- প্রপোজাল অনুযায়ী। NestJS-এর DI-র জন্য decorator metadata লাগে, Vitest-এর ডিফল্ট transformer তা দেয় না, তাই `unplugin-swc` + `@swc/core`।

### অন্যান্য

- Env ভ্যালিডেশন `@nestjs/config`-এর `validate` + class-validator দিয়ে (DTO-র একই লাইব্রেরি, বাড়তি dependency নয়)। ভুল মানে অ্যাপ চালু হয় না।
- API path: global prefix `api` + URI versioning, ডিফল্ট `v1` → `/api/v1/...`।
- `CORS_ORIGIN` কমা দিয়ে একাধিক origin নিতে পারে।
- Health endpoint `src/core/health`-এ (ব্যবসা-নিরপেক্ষ), কোনো I/O করে না।
- `package.json`-এ ভার্সন exact pin (caret ছাড়া), যাতে লোকাল ও ক্লাউড হুবহু এক থাকে। আপগ্রেড হবে সচেতনভাবে, `npm outdated` দেখে।
- Build: `nest build` (tsc)। `module`/`moduleResolution` = `nodenext` (TS 6-এ পুরনো `node` resolution deprecated)।

### ভার্সন তালিকা (npm registry-র `latest` ট্যাগ থেকে যাচাই, কোনো RC/beta নেই)

| প্যাকেজ | ভার্সন | নোট |
|---|---|---|
| @nestjs/core, common, platform-express, testing | 12.5.0 | |
| @nestjs/config | 12.1.1 | |
| @nestjs/cli, @nestjs/schematics | 12.0.13 | |
| typescript | 6.0.3 | latest 7.0.2, উপরের কারণ |
| class-validator / class-transformer | 0.15.1 / 0.5.1 | |
| reflect-metadata / rxjs | 0.2.2 / 7.8.2 | |
| vitest | 5.1.0 | |
| unplugin-swc / @swc/core | 2.0.0 / 1.16.22 | |
| supertest / @types/supertest | 7.3.2 / 7.2.1 | |
| eslint / @eslint/js / typescript-eslint | 10.15.0 / 10.0.1 / 8.72.2 | |
| eslint-config-prettier / prettier / globals | 10.1.8 / 3.10.1 / 17.14.0 | |
| @types/node / @types/express | 22.20.5 / 5.0.6 | @types/node latest 26.6.6, Node 22-এর সাথে মেলানো |

### macOS 12.7.6-এ নেটিভ বাইনারি: যাচাই সম্পন্ন (২০২৬-১১-১৬)

নিচের প্যাকেজগুলো আগে থেকে compile করা নেটিভ বাইনারি আনে (শুধু dev/test tool, production runtime-এ নয়)। ডেভেলপারের Mac-এ (macOS 12.7.6, Node v22.23.5, npm 10.9.9) যাচাই হয়েছে: `npm install` সফল, `npm test`-এ ১১টা টেস্ট পাস, `npm run start:dev` চালু এবং watch mode কাজ করছে।

| প্যাকেজ | কোন কমান্ডে লাগে | অবস্থা |
|---|---|---|
| `@swc/core` 1.16.22 | `npm test` | macOS 12.7.6-এ যাচাই সম্পন্ন |
| `rolldown` (Vite 8 → Vitest-এর ভেতরে) | `npm test` | macOS 12.7.6-এ যাচাই সম্পন্ন |
| `fsevents` (macOS-only, optional) | `npm run start:dev`, `vitest` watch | macOS 12.7.6-এ যাচাই সম্পন্ন |

`lightningcss` Vite 8-এর dependency হিসেবে install হয় (Mac-এ install সফল), কিন্তু এই repository-তে CSS প্রসেসিং নেই বলে কখনো চলে না। এর আসল যাচাই হবে frontend (`jesan-web`)-এ।

### জানা সমস্যা

- `npm audit`: ৭টা moderate, সবই dev-only (`typescript-eslint` → `minimatch`)। সর্বশেষ typescript-eslint-এও ঠিক হয়নি; প্রস্তাবিত "fix" হলো পুরনো ভার্সনে নামা, তাই করা হয়নি। `npm audit --omit=dev` = ০। পরের রিলিজে আবার দেখা হবে।

## ২০২৬-১১-১৬: CI ও কাজের ধরন

- GitHub Actions (`.github/workflows/ci.yml`): প্রতিটা PR ও `main`-এ push-এ lint, type-check, test, build। Node ভার্সন `.nvmrc` থেকে পড়া হয়, যাতে লোকাল, ক্লাউড ও CI এক থাকে। `actions/checkout@v7`, `actions/setup-node@v7` (সর্বশেষ major)। Workflow-এর অনুমতি শুধু `contents: read`।
- Merge পদ্ধতি: চেক সবুজ হলে `main`-এ squash merge, তারপর branch মুছে ফেলা (মালিকের নির্দেশ, `CLAUDE.md`-র "কাজের ধরন")।

## ২০২৬-১১-১৬: Git branch নিয়ম

- প্রতিটা কাজে `main` থেকে নতুন নামের branch (`claude/<কাজের-নাম>`); পুরনো branch পুনরায় ব্যবহার নয়, force push নয়, `main`-এ সরাসরি push নয়। কারণ: squash merge-এর পর পুরনো branch-এর ইতিহাস `main`-এর সাথে মেলে না, তাই পুনরায় ব্যবহার করতে গেলে force push বা অগোছালো merge লাগে; নতুন branch-এ সেই ঝুঁকি নেই এবং প্রতিটা PR ছোট ও পরিষ্কার থাকে।
- ক্লাউড সেশনের অনুমতিতে remote branch মোছা আটকাতে পারে (প্রথম PR-এ 403 এসেছিল), তাই মোছা না গেলে রিপোর্টে জানানো হবে।
