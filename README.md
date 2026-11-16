# jesan-api

Jesan Enterprise (জিসান এন্টারপ্রাইজ) মাল্টি-বিজনেস প্ল্যাটফর্মের backend API। NestJS 12, strict TypeScript।
Frontend আলাদা repository-তে: `jesan-web`।

## এখন পর্যন্ত কী হয়েছে

শুরুর কাঠামো: NestJS অ্যাপ, env ভ্যালিডেশন, global validation pipe, CORS, `GET /api/v1/health`, lint/format/test সেটআপ।
ডাটাবেস, Prisma, লগইন, রোল ও বিজনেস ফিচার এখনো নেই।

## লোকালে চালানো

1. **Node 22 LTS ইনস্টল করুন** (22.12 বা নতুন)। nvm থাকলে:

   ```bash
   nvm install 22
   ```

   ```bash
   nvm use
   ```

2. **Dependency ইনস্টল:**

   ```bash
   npm install
   ```

3. **`.env` বানান** (`.env.example` থেকে কপি করে প্রয়োজনে মান বদলান):

   ```bash
   cp .env.example .env
   ```

4. **চালান:**

   ```bash
   npm run start:dev
   ```

5. **পরীক্ষা:**

   ```bash
   curl http://localhost:4000/api/v1/health
   ```

   উত্তর: `{"status":"ok"}`

## Environment variable

| নাম | ডিফল্ট | বর্ণনা |
|---|---|---|
| `PORT` | `4000` | API-র পোর্ট (1 থেকে 65535) |
| `NODE_ENV` | `development` | `development`, `test` বা `production` |
| `CORS_ORIGIN` | `http://localhost:3000` | অনুমোদিত origin; একাধিক হলে কমা দিয়ে |

ভুল মান দিলে অ্যাপ চালু হবে না এবং কারণ দেখাবে। আসল secret কখনো repository-তে রাখবেন না; `.env` gitignore করা আছে।

## কমান্ড

| কমান্ড | কাজ |
|---|---|
| `npm run start:dev` | watch মোডে চালানো |
| `npm run start` | একবার build করে চালানো |
| `npm run build` / `npm run start:prod` | production build / `dist` থেকে চালানো |
| `npm run lint` | ESLint |
| `npm run type-check` | `tsc --noEmit` |
| `npm test` | Vitest (unit + e2e) |
| `npm run format` | Prettier |

## ফোল্ডার

```
src/
  main.ts            অ্যাপ চালু
  app.setup.ts       prefix, versioning, validation pipe, CORS (টেস্টও এটাই ব্যবহার করে)
  app.module.ts
  core/              সব ব্যবসার জন্য এক অংশ (README দেখুন)
  modules/
    dealership/      ডিলারশিপ ধরনের ব্যবসার module (README দেখুন)
test/                e2e টেস্ট
```

সিদ্ধান্ত ও ভার্সন তালিকা: [DECISIONS.md](./DECISIONS.md)। কাজের নিয়ম: [CLAUDE.md](./CLAUDE.md)।
