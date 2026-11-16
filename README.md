# jesan-api

Jesan Enterprise (জিসান এন্টারপ্রাইজ) মাল্টি-বিজনেস প্ল্যাটফর্মের backend API। NestJS 12, strict TypeScript।
Frontend আলাদা repository-তে: `jesan-web`।

## এখন পর্যন্ত কী হয়েছে

- শুরুর কাঠামো: NestJS অ্যাপ, env ভ্যালিডেশন, global validation pipe, CORS, lint/format/test, CI।
- ডাটাবেস: PostgreSQL + Prisma 7, core টেবিল (`businesses`, `users`, `roles`, `user_business_access`), migration ও seed।
- `GET /api/v1/health` (অ্যাপ বেঁচে আছে কি না, সবসময় দ্রুত 200) এবং `GET /api/v1/health/ready` (ডাটাবেস পৌঁছানো যায় কি না)।

লগইন, রোলের অনুমতি ও বিজনেস ফিচার এখনো নেই।

## লোকালে চালানো

1. **Node 22 LTS ইনস্টল করুন** (22.12 বা নতুন)। nvm থাকলে:

   ```bash
   nvm install 22
   ```

   ```bash
   nvm use
   ```

2. **Dependency ইনস্টল** (শেষে নিজে থেকেই `prisma generate` চলে):

   ```bash
   npm install
   ```

3. **`.env` বানান:**

   ```bash
   cp .env.example .env
   ```

   তারপর `.env`-এ ডাটাবেসের দুটো মান বসান (নিচের "ডাটাবেস" অংশ দেখুন)। ডাটাবেস ছাড়াও অ্যাপ চালু হয়, তখন `/health/ready` বলবে `not_configured`।

4. **Migration চালান ও ভিত্তি ডেটা বসান:**

   ```bash
   npm run db:deploy
   ```

   ```bash
   npm run db:seed
   ```

5. **চালান:**

   ```bash
   npm run start:dev
   ```

6. **পরীক্ষা:**

   ```bash
   curl http://localhost:4000/api/v1/health
   ```

   ```bash
   curl http://localhost:4000/api/v1/health/ready
   ```

   উত্তর: `{"status":"ok"}` এবং `{"status":"ok","database":"up"}`

## Environment variable

| নাম | ডিফল্ট | বর্ণনা |
|---|---|---|
| `PORT` | `4000` | API-র পোর্ট (1 থেকে 65535) |
| `NODE_ENV` | `development` | `development`, `test` বা `production` |
| `CORS_ORIGIN` | `http://localhost:3000` | অনুমোদিত origin; একাধিক হলে কমা দিয়ে |
| `DATABASE_URL` | নেই | অ্যাপের জন্য **pooled** connection। `production`-এ বাধ্যতামূলক, অন্যথায় ঐচ্ছিক |
| `DIRECT_URL` | নেই | migration-এর জন্য **direct** connection। না থাকলে migration `DATABASE_URL` ব্যবহার করে |

ভুল মান দিলে অ্যাপ চালু হবে না এবং কারণ দেখাবে (মানটা দেখাবে না)। আসল secret কখনো repository-তে রাখবেন না; `.env` gitignore করা আছে।

## ডাটাবেস

PostgreSQL 18, Prisma ORM 7। Schema: `prisma/schema.prisma`, migration: `prisma/migrations/`, connection কনফিগ: `prisma.config.ts`।

### Neon-এর দুটো connection

Neon ড্যাশবোর্ডে আপনার **dev branch**-এর "Connection string" থেকে দুটো মান নিন এবং শুধু নিজের `.env`-এ বসান:

| `.env`-এর নাম | কোনটা | চেনার উপায় |
|---|---|---|
| `DATABASE_URL` | Pooled connection ("Connection pooling" চালু) | host-এ `-pooler` আছে |
| `DIRECT_URL` | Direct connection ("Connection pooling" বন্ধ) | host-এ `-pooler` নেই |

দুটোর শেষেই `?sslmode=require` থাকবে। Production-এর মান শুধু হোস্টিং-এর environment variable-এ বসবে, কোনো ফাইলে নয়।

### কমান্ড

| কমান্ড | কাজ |
|---|---|
| `npm run db:deploy` | বাকি থাকা migration ডাটাবেসে প্রয়োগ করে (নিরাপদ, কিছু মোছে না) |
| `npm run db:seed` | ভিত্তি ডেটা: ৪টা ডিফল্ট রোল ও প্রথম ব্যবসা। বারবার চালানো নিরাপদ, বিদ্যমান সারি বদলায় না। কোনো ইউজার বা পাসওয়ার্ড বানায় না |
| `npm run db:status` | কোন migration প্রয়োগ হয়েছে |
| `npm run db:migrate` | schema বদলের পর নতুন migration বানায় (শুধু ডেভেলপমেন্টে) |
| `npm run db:check` | ডাটাবেস আর schema মিলছে কি না |
| `npm run db:generate` | Prisma client আবার বানায় (`src/generated/prisma`, git-এ নেই) |

### macOS 12-এ `npm run db:deploy` ব্যর্থ হলে

> macOS 12.7.6-এ `npm run db:deploy` চলে বলে যাচাই হয়েছে (২০২৬-১১-১৬)। নিচের পথগুলো শুধু ভবিষ্যতে সমস্যা হলে।

`prisma migrate` একটা নেটিভ বাইনারি (schema engine) চালায়, যা পুরনো macOS-এ না-ও চলতে পারে। অ্যাপ চালাতে ওই বাইনারি লাগে না, শুধু migration-এ লাগে। ব্যর্থ হলে বিকল্প:

1. **Neon SQL Editor (সবচেয়ে সহজ):** Neon ড্যাশবোর্ডের SQL Editor-এ dev branch বেছে `prisma/migrations/` ফোল্ডারের প্রতিটা `migration.sql`-এর লেখা তারিখের ক্রমে পেস্ট করে চালান। তারপর Mac-এ `npm run db:seed` চালান (seed খাঁটি JavaScript, ওই বাইনারি লাগে না)।
   এই পথে Prisma-র migration ইতিহাস টেবিলে (`_prisma_migrations`) সারি পড়ে না; তাই পরে `db:deploy` চালানো গেলে আগে প্রতিটা হাতে-চালানো migration চিহ্নিত করতে হবে: `npx prisma migrate resolve --applied <migration-ফোল্ডারের-নাম>`।
2. **GitHub Actions থেকে:** Neon-এর direct URL টা GitHub repository-র secret হিসেবে রেখে একটা হাতে-চালানো workflow দিয়ে `npm run db:deploy`। এতে ইতিহাসও ঠিক থাকে। এই workflow এখনো বানানো হয়নি; দরকার হলে বলুন।

### টেস্ট

`DATABASE_URL` সেট থাকলে `npm test` আসল ডাটাবেসেও টেস্ট চালায় (আগে `npm run db:deploy` লাগবে)। টেস্ট নিজের বানানো সারি নিজেই মুছে দেয়, তবে seed-এর সারি রেখে দেয়; তাই production ডাটাবেসের বিপরীতে টেস্ট চালাবেন না। `DATABASE_URL` না থাকলে ডাটাবেস-টেস্টগুলো বাদ পড়ে। CI-তে সবসময় PostgreSQL 18-এ চলে।

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
    database/        Prisma module ও service
  generated/prisma/  Prisma client (git-এ নেই, `npm install`-এ তৈরি হয়)
  modules/
    dealership/      ডিলারশিপ ধরনের ব্যবসার module (README দেখুন)
test/                e2e টেস্ট
prisma/              schema, migration, seed
prisma.config.ts     Prisma CLI-র কনফিগ
```

সিদ্ধান্ত ও ভার্সন তালিকা: [DECISIONS.md](./DECISIONS.md)। কাজের নিয়ম: [CLAUDE.md](./CLAUDE.md)।
