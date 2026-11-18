# jesan-api

Jesan Enterprise (জিসান এন্টারপ্রাইজ) মাল্টি-বিজনেস প্ল্যাটফর্মের backend API। NestJS 12, strict TypeScript।
Frontend আলাদা repository-তে: `jesan-web`।

## এখন পর্যন্ত কী হয়েছে

- শুরুর কাঠামো: NestJS অ্যাপ, env ভ্যালিডেশন, global validation pipe, CORS, lint/format/test, CI।
- ডাটাবেস: PostgreSQL + Prisma 7, core টেবিল, migration ও seed।
- `GET /api/v1/health` (অ্যাপ বেঁচে আছে কি না, সবসময় দ্রুত 200) এবং `GET /api/v1/health/ready` (ডাটাবেস পৌঁছানো যায় কি না)।
- লগইন, রোল ও অনুমতি (শুধু backend): email বা phone দিয়ে লগইন, ব্যবসাভিত্তিক সীমা, অনুমতি-ভিত্তিক নিয়ন্ত্রণ, কমিশন ও লাভ শুধু মালিকের, Settings API ([নিচে](#লগইন-রোল-ও-অনুমতি))।

- ব্যবসা-ডেটা আলাদা রাখার ভিত্তি (প্রতিটা query-তে স্বয়ংক্রিয় `businessId`) এবং dealership-এর মাস্টার ডেটা: ক্যাটাগরি, পণ্য, গ্রাহক, সরবরাহকারী (তালিকা, অনুসন্ধান, তৈরি, সম্পাদনা, নিষ্ক্রিয়)।
- সংশোধন ও বাতিলের অনুমোদন ব্যবস্থা (maker-checker): স্টাফ কারণসহ অনুরোধ পাঠান, মালিক প্রভাব দেখে অনুমোদন বা প্রত্যাখ্যান করেন, প্রয়োগ এক transaction-এ ([নিচে](#সংশোধনের-অনুরোধ-ও-অনুমোদন))।

কেনা, বিক্রি, স্টক, খাতা, কমিশন ও রিপোর্ট এখনো নেই।

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

   ডেভেলপমেন্টে নমুনা ক্যাটাগরি (OPC, PCC), পণ্য ও গ্রাহক চাইলে (production-এ চলে না, বারবার চালানো নিরাপদ):

   ```bash
   npm run db:seed:dev
   ```

5. **প্রথম মালিক অ্যাকাউন্ট বানান** (একবারই)। `.env`-এ এই তিনটা বসান (পাসওয়ার্ড কমপক্ষে ১০ অক্ষর; কোডে, চ্যাটে বা commit-এ কখনো নয়):

   ```
   ADMIN_EMAIL=আপনার-ইমেইল
   ADMIN_NAME=আপনার নাম
   ADMIN_PASSWORD=আপনার-পছন্দের-পাসওয়ার্ড
   ```

   ইমেইলের বদলে বা সাথে `ADMIN_PHONE=01XXXXXXXXX`-ও দেওয়া যায়। তারপর:

   ```bash
   npm run admin:create
   ```

   কমান্ড শেষ হলে `.env` থেকে `ADMIN_PASSWORD` লাইনটা **মুছে ফেলুন**। কমান্ডটা বারবার চালানো নিরাপদ: ইউজার আগে থেকে থাকলে কিছু বদলায় না। এটা `is_platform_owner` ইউজার বানায়, যিনি সব ব্যবসায় ঢুকতে পারেন (আলাদা access সারি লাগে না)।

6. **চালান:**

   ```bash
   npm run start:dev
   ```

7. **পরীক্ষা:**

   ```bash
   curl http://localhost:4000/api/v1/health
   ```

   ```bash
   curl http://localhost:4000/api/v1/health/ready
   ```

   উত্তর: `{"status":"ok"}` এবং `{"status":"ok","database":"up"}`। লগইনের পরীক্ষা নিচের "লগইন ও অনুমতি" অংশে।

## Environment variable

| নাম | ডিফল্ট | বর্ণনা |
|---|---|---|
| `PORT` | `4000` | API-র পোর্ট (1 থেকে 65535) |
| `NODE_ENV` | `development` | `development`, `test` বা `production` |
| `CORS_ORIGIN` | `http://localhost:3000` | অনুমোদিত origin; একাধিক হলে কমা দিয়ে |
| `DATABASE_URL` | নেই | অ্যাপের জন্য **pooled** connection। `production`-এ বাধ্যতামূলক, অন্যথায় ঐচ্ছিক |
| `DIRECT_URL` | নেই | migration-এর জন্য **direct** connection। না থাকলে migration `DATABASE_URL` ব্যবহার করে |
| `JWT_ACCESS_SECRET` | নেই | access token সই করার গোপন মান, কমপক্ষে ৩২ অক্ষর। `production`-এ বাধ্যতামূলক। না থাকলে (ডেভে) প্রতি চালুতে অস্থায়ী একটা তৈরি হয়, তাই অ্যাপ রিস্টার্টে সবাই লগআউট হয় |
| `COOKIE_DOMAIN` | নেই | `app.` ও `api.` সাবডোমেইন একই cookie ভাগ করতে চাইলে মূল ডোমেইন (যেমন `example.com`) |
| `TRUST_PROXY` | `0` | API-র সামনে কয়টা reverse proxy আছে (আসল IP পেতে) |
| `LOGIN_RATE_LIMIT` | `10` | এক IP থেকে প্রতি মিনিটে লগইন চেষ্টার সীমা |

`ADMIN_EMAIL`, `ADMIN_PHONE`, `ADMIN_NAME`, `ADMIN_PASSWORD` শুধু `npm run admin:create`-এর জন্য; অ্যাপ এগুলো পড়ে না।

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

### লগইন, রোল ও অনুমতি

request ও response-এর পুরো রূপ, ত্রুটির কোড ও refresh-এর নিয়ম: [docs/API.md](./docs/API.md)।

### Endpoint

| Endpoint | কাজ |
|---|---|
| `POST /api/v1/auth/login` | `{ "identifier": "email বা phone", "password": "..." }`। সফল হলে দুটো httpOnly cookie বসে |
| `POST /api/v1/auth/refresh` | refresh cookie দিয়ে নতুন token জোড়া (পুরনোটা সঙ্গে সঙ্গে অকেজো) |
| `POST /api/v1/auth/logout` | এই ডিভাইসের সেশন শেষ। বারবার চালানো নিরাপদ |
| `GET /api/v1/auth/me` | ইউজার, তার ব্যবসাগুলো, প্রতিটায় রোল ও অনুমতির তালিকা |
| `POST /api/v1/auth/change-password` | নিজের পাসওয়ার্ড বদল; অন্য সব ডিভাইস লগআউট হয় |

phone `01XXXXXXXXX`, `8801XXXXXXXXX` বা `+8801XXXXXXXXX`, যেভাবেই লিখুন, একই নম্বর ধরা হয়।

**forgot-password এই ধাপে নেই।** কেউ পাসওয়ার্ড ভুলে গেলে মালিক Settings API-র `reset-password` দিয়ে নতুন পাসওয়ার্ড বসিয়ে দেবেন (এতে অ্যাকাউন্টের লক-ও খুলে যায়)।

### কে কী দেখতে পারে

- **ব্যবসাভিত্তিক সীমা:** ব্যবহারকারী শুধু সেই ব্যবসায় ঢুকতে পারেন যেখানে তাকে `user_business_access`-এ রোল দেওয়া আছে (Akij-এর ম্যানেজার শুধু Akij-তে)। যাচাই হয় সার্ভারে, প্রতিটা `/b/:businessSlug/...` অনুরোধে। অজানা ব্যবসা আর "ঢোকার অনুমতি নেই", দুটোতেই একই 403।
- **platform owner** (`users.is_platform_owner = true`): সব ব্যবসায় ঢুকতে পারেন এবং **সব** অনুমতির মালিক, owner-only গুলোসহ।
- **ব্যবসা-স্তরের `owner` রোল** (কোনো অংশীদারকে এক ব্যবসায় দেওয়া যায়): সব অনুমতি পায় **শুধু owner-only গুলো ছাড়া**। অর্থাৎ কমিশন, লাভ ও ব্যবস্থাপনার অনুমতি পায় না। এই রোলের অনুমতি বদলানো যায় না।
- **owner-only অনুমতি** (শুধু platform owner): `commission.view`, `commission.manage`, `profit.view`, `settings.manage`, `users.manage`, `roles.manage`, `audit.view`। অন্য কাউকে দেওয়ার চেষ্টা API-তে 400 পায়, আর ডাটাবেসও সরাসরি SQL-এও এই সারি ঢুকতে দেয় না (foreign key + CHECK)।
- **ম্যানেজার, হিসাবরক্ষক, বিক্রয়কর্মী:** প্রতিটা ব্যবসায় প্রতিটা রোলের অনুমতি ডাটাবেসে (`role_permissions`), মালিক Settings API দিয়ে বদলাতে পারেন। ডিফল্ট `src/modules/dealership/dealership.permissions.ts`-এ। বিক্রয়কর্মী `stock.view` পায় (শুধু পরিমাণ), কিন্তু কেনা-দাম (`product.cost.view`), টাকার সারাংশ, কমিশন বা লাভ নয়।
- **টাকার ফিল্ড সার্ভারে লুকানো:** অনুমতি না থাকলে response-এ কমিশন, লাভ ইত্যাদি ফিল্ড **পাঠানোই হয় না**। response DTO-তে ঘোষণা না করা কোনো ফিল্ডও কখনো বের হয় না। নিয়ম `src/core/README.md`-তে।
- নতুন অনুমতি ঘোষণা করে প্রতিটা module নিজে (`PermissionRegistry`)। অ্যাপ চালুর সময় সেগুলো `permissions` টেবিলে মিলিয়ে নেওয়া হয় এবং নতুন অনুমতির ডিফল্ট রোলে বসে। মালিকের আগের বদল কখনো মুছে যায় না।

### Settings API (platform owner)

সব পথ `/api/v1/b/:businessSlug/...`-এর নিচে। মাস্টার ডেটার (পণ্য, গ্রাহক ইত্যাদি) API ও নমুনা [docs/API.md](./docs/API.md)-তে।

| Endpoint | অনুমতি | কাজ |
|---|---|---|
| `GET roles/permissions` | `roles.manage` | রোল × অনুমতির ছক |
| `PUT roles/:roleKey/permissions` | `roles.manage` | একটা রোলের অনুমতির পুরো তালিকা বসানো (`{ "permissions": ["stock.view", ...] }`) |
| `GET users?page=1` | `users.view` | ব্যবসার ইউজার, প্রতি পাতায় ১০ জন |
| `POST users` | `users.manage` | ইউজার তৈরি ও রোল বরাদ্দ (`name`, `email` বা `phone`, `password`, `roleKey`) |
| `POST users/lookup` | `users.manage` | ইমেইল বা ফোন দিয়ে বিদ্যমান ইউজার খোঁজা (id, নাম, অবস্থা, এই ব্যবসায় আছেন কি না); প্রতি ইউজার মিনিটে ২০টা, audit-এ লেখা |
| `POST users/:userId/access` | `users.manage` | বিদ্যমান ইউজারকে এই ব্যবসায় রোলসহ ঢোকার অনুমতি |
| `PATCH users/:userId/role` | `users.manage` | রোল বদল |
| `DELETE users/:userId/access` | `users.manage` | এই ব্যবসার অ্যাক্সেস সরানো (ইউজার মোছা নয়) |
| `PATCH users/:userId/status` | `users.manage` | `{ "isActive": false }` দিলে সব ব্যবসা থেকে সঙ্গে সঙ্গে লগআউট |
| `POST users/:userId/reset-password` | `users.manage` | নতুন পাসওয়ার্ড (`{ "newPassword": "..." }`); সব সেশন শেষ, লক খোলে |

প্রতিটা বদল `audit_logs`-এ লেখা হয় (কে, কখন, কী বদলাল; পাসওয়ার্ড কখনো নয়)। platform owner অ্যাকাউন্ট এই API দিয়ে বদলানো যায় না। অনুমতি বা রোল বদলালে তার প্রভাব সঙ্গে সঙ্গে কার্যকর হয় (সার্ভারের ৬০ সেকেন্ডের cache মুছে যায়)।

### Token ও নিরাপত্তা

- **Access token** ১৫ মিনিট, **refresh token** ৩০ দিন, দুটোই httpOnly cookie (`jesan_at`, `jesan_rt`; refresh cookie শুধু `/api/v1/auth` পথে যায়)। পাতার JavaScript এগুলো পড়তে পারে না। `Authorization: Bearer` header-ও গ্রহণযোগ্য।
- প্রতিবার refresh করলে refresh token বদলে যায়। পুরনো token ১০ সেকেন্ডের পরে আবার এলে ধরে নেওয়া হয় চুরি হয়েছে এবং পুরো সেশন বাতিল হয়। logout, পাসওয়ার্ড বদল বা ইউজার নিষ্ক্রিয় করলে access token-ও সঙ্গে সঙ্গে অকেজো।
- পাসওয়ার্ড argon2id; ১০ থেকে ১২৮ অক্ষর; নিজের email বা phone হওয়া চলবে না।
- ভুল, অজানা ইউজার, নিষ্ক্রিয় বা লক, সব ক্ষেত্রেই একই বার্তা (`Invalid credentials`) ও প্রায় সমান সময়।
- পরপর ৫ বার ভুল পাসওয়ার্ডে অ্যাকাউন্ট ১৫ মিনিট লক। এক IP থেকে প্রতি মিনিটে `LOGIN_RATE_LIMIT`-এর বেশি লগইন চেষ্টা করলে 429।
- cookie-তে লগইন করা অবস্থায় বদলানোর অনুরোধে `Origin` header `CORS_ORIGIN`-এর তালিকায় না থাকলে 403 (CSRF-এর বিরুদ্ধে)।
- প্রতিটা অনুরোধের token সার্ভারে যাচাই হয় ডাটাবেসে না গিয়ে। এই ব্যবস্থা ধরে নেয় API একটাই instance-এ চলে; একাধিক হলে cache ও revoke-তালিকা Redis-এ নিতে হবে।

### ডিপ্লয়ের শর্ত: cookie কাজ করতে web আর API একই সাইটে থাকতে হবে

Token cookie-তে থাকে এবং `SameSite=Lax`। তাই ব্রাউজার cookie পাঠায় শুধু তখনই, যখন web আর API **একই সাইটের** অধীনে। দুটোর যেকোনো একটা:

1. **কাস্টম ডোমেইনের সাবডোমেইন**, যেমন `app.আপনার-ডোমেইন` (Next.js) ও `api.আপনার-ডোমেইন` (API)। API-তে `COOKIE_DOMAIN=আপনার-ডোমেইন`, `CORS_ORIGIN=https://app.আপনার-ডোমেইন`। ব্রাউজারের অনুরোধে `credentials: 'include'` লাগবে।
2. **Next.js proxy:** ব্রাউজার শুধু web-এর ডোমেইনকে ডাকে, Next.js (`rewrites`) ভেতরে ভেতরে API-কে ডাকে। তখন cookie web-এর ডোমেইনের, `COOKIE_DOMAIN` লাগে না।

**কাজ করবে না:** web `xxx.vercel.app`, API `xxx.up.railway.app` (দুটো আলাদা সাইট)। লগইন সফল দেখালেও পরের অনুরোধে cookie যাবে না, `me` 401 দেবে। `SameSite=None` দিয়ে এটা ঘোরানো হবে না, কারণ তাতে CSRF সুরক্ষা দুর্বল হয়। production-এ `NODE_ENV=production` চালু থাকলে cookie `Secure` হয়, তাই HTTPS লাগবে; API reverse proxy-র পেছনে থাকলে `TRUST_PROXY=1`।

### লোকালে cookie কাজ করা (`localhost:3000` ও `localhost:4000`)

ব্রাউজার "সাইট" ধরে স্কিম ও ডোমেইন দিয়ে, **পোর্ট ধরে না**। তাই `http://localhost:3000` আর `http://localhost:4000` একই সাইট, কোনো বাড়তি সেটিং ছাড়াই cookie যায়:

1. `.env`-এ `CORS_ORIGIN=http://localhost:3000` (এটাই ডিফল্ট)। `credentials: true` CORS-এ চালু আছে, তাই origin অবশ্যই নির্দিষ্ট হতে হবে (`*` চলে না)।
2. frontend থেকে প্রতিটা অনুরোধে `credentials: 'include'`, যেমন `fetch('http://localhost:4000/api/v1/auth/login', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier, password }) })`।
3. ডেভে (`NODE_ENV` ≠ `production`) cookie-তে `Secure` নেই, তাই `http://localhost`-এ চলে।
4. frontend ছাড়া যাচাই: `curl -i -H 'Origin: http://localhost:3000' ...` চালালে উত্তরে `Access-Control-Allow-Credentials: true` ও `Set-Cookie` দেখা যায় (নিচের উদাহরণ)।

### লগইন যাচাই (curl)

পাসওয়ার্ড টার্মিনালে লুকিয়ে নেওয়া হয়, তাই shell history-তে বা চ্যাটে যায় না। cookie রাখা হয় `/tmp`-এ (repository-র ভেতরে নয়)। অ্যাপ চালু থাকতে হবে।

1. ইমেইল ও পাসওয়ার্ড নিন:

   ```bash
   printf 'Email: '; read ID; printf 'Password: '; stty -echo; read PW; stty echo; echo; export ID PW
   ```

2. লগইন (উত্তরে `user` থাকবে, `isPlatformOwner: true`):

   ```bash
   node -e 'process.stdout.write(JSON.stringify({identifier:process.env.ID,password:process.env.PW}))' | curl -s -c /tmp/jesan-owner.txt -X POST http://localhost:4000/api/v1/auth/login -H 'content-type: application/json' --data-binary @-
   ```

3. `me` (ব্যবসা ও অনুমতিসহ):

   ```bash
   curl -s -b /tmp/jesan-owner.txt http://localhost:4000/api/v1/auth/me
   ```

4. ভুল পাসওয়ার্ডে একই বার্তা: নিচের দুটোই `{"message":"Invalid credentials",...}` দেবে (একটায় ভুল পাসওয়ার্ড, অন্যটায় যে ইমেইল নেই):

   ```bash
   curl -s -X POST http://localhost:4000/api/v1/auth/login -H 'content-type: application/json' -d '{"identifier":"nobody@example.test","password":"wrong-password-1"}'
   ```

   ```bash
   node -e 'process.stdout.write(JSON.stringify({identifier:process.env.ID,password:"wrong-password-1"}))' | curl -s -X POST http://localhost:4000/api/v1/auth/login -H 'content-type: application/json' --data-binary @-
   ```

5. ম্যানেজার বানিয়ে যাচাই: ম্যানেজারের ইমেইল ও পাসওয়ার্ড নিন, মালিক হিসেবে তাকে `akij-cement`-এ বানান, তারপর ম্যানেজার হিসেবে লগইন করুন:

   ```bash
   printf 'Manager email: '; read MID; printf 'Manager password (10+ chars): '; stty -echo; read MPW; stty echo; echo; export MID MPW
   ```

   ```bash
   node -e 'process.stdout.write(JSON.stringify({name:"Test Manager",email:process.env.MID,password:process.env.MPW,roleKey:"manager"}))' | curl -s -b /tmp/jesan-owner.txt -X POST http://localhost:4000/api/v1/b/akij-cement/users -H 'content-type: application/json' --data-binary @-
   ```

   ```bash
   node -e 'process.stdout.write(JSON.stringify({identifier:process.env.MID,password:process.env.MPW}))' | curl -s -c /tmp/jesan-manager.txt -X POST http://localhost:4000/api/v1/auth/login -H 'content-type: application/json' --data-binary @-
   ```

6. ম্যানেজার কমিশন ও লাভ পায় না: নিচের কমান্ড `manager false false true` ছাপবে (রোল, `commission.view`, `profit.view`, `sale.create`):

   ```bash
   curl -s -b /tmp/jesan-manager.txt http://localhost:4000/api/v1/auth/me | node -e 'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{const b=JSON.parse(s).businesses[0];console.log(b.role.key,b.permissions.includes("commission.view"),b.permissions.includes("profit.view"),b.permissions.includes("sale.create"))})'
   ```

7. মালিকের তালিকায় সব আছে: নিচের কমান্ড `owner true true` ছাপবে (platform owner-এর রোল ও কমিশন-লাভ দুটোই আছে):

   ```bash
   curl -s -b /tmp/jesan-owner.txt http://localhost:4000/api/v1/auth/me | node -e 'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{const b=JSON.parse(s).businesses[0];console.log(b.role.key,b.permissions.includes("commission.view"),b.permissions.includes("profit.view"))})'
   ```

8. ম্যানেজার ব্যবস্থাপনার API পায় না (`403` ছাপবে):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/jesan-manager.txt http://localhost:4000/api/v1/b/akij-cement/roles/permissions
   ```

9. মালিকও ম্যানেজারকে কমিশন দিতে পারেন না (`400` ছাপবে এবং কিছু বদলায় না):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/jesan-owner.txt -X PUT http://localhost:4000/api/v1/b/akij-cement/roles/manager/permissions -H 'content-type: application/json' -d '{"permissions":["stock.view","commission.view"]}'
   ```

10. শেষে: logout ও cookie-র ফাইল মুছুন:

    ```bash
    curl -s -b /tmp/jesan-owner.txt -X POST http://localhost:4000/api/v1/auth/logout -o /dev/null -w '%{http_code}\n'
    ```

    ```bash
    rm -f /tmp/jesan-owner.txt /tmp/jesan-manager.txt; unset ID PW MID MPW
    ```

### macOS 12-এ পাসওয়ার্ড লাইব্রেরি

> macOS 12.7.6-এ `npm ci`, `admin:create` ও লগইন চলে বলে যাচাই হয়েছে (২০২৬-১১-১৭)।

পাসওয়ার্ড hashing `@node-rs/argon2` দিয়ে। এর macOS (Intel) বাইনারি আগে থেকে তৈরি (macOS 10.13 বা নতুনে চলে), তাই `npm install`-এ কিছু compile করতে হয় না। তবু `npm install` বা লগইনে এই লাইব্রেরি নিয়ে সমস্যা হলে `DECISIONS.md`-র "পাসওয়ার্ড লাইব্রেরি" অংশে বিকল্প (বিশুদ্ধ WebAssembly, একই hash ফরম্যাট) লেখা আছে।

## কমান্ড

| কমান্ড | কাজ |
|---|---|
| `npm run db:deploy` | বাকি থাকা migration ডাটাবেসে প্রয়োগ করে (নিরাপদ, কিছু মোছে না) |
| `npm run db:seed` | ভিত্তি ডেটা: ৪টা ডিফল্ট রোল, প্রথম ব্যবসা ও তার প্রিন্সিপাল সরবরাহকারী। বারবার চালানো নিরাপদ, বিদ্যমান সারি বদলায় না। কোনো ইউজার বা পাসওয়ার্ড বানায় না |
| `npm run db:seed:dev` | শুধু ডেভে: নমুনা ক্যাটাগরি, পণ্য ও গ্রাহক (নকল ফোন নম্বর)। `NODE_ENV=production`-এ চলতে অস্বীকার করে |
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

### সংশোধনের অনুরোধ ও অনুমোদন

দাম, শুরুর বাকি, ক্রেডিট সীমা আর নিষ্ক্রিয় করা স্টাফ সরাসরি বদলাতে পারেন না; `POST /b/:businessSlug/change-requests` দিয়ে কারণসহ অনুরোধ পাঠান। `change.approve` আছে এমন কেউ (ডিফল্টে মালিক-স্তর) প্রভাব দেখে অনুমোদন বা প্রত্যাখ্যান (নোটসহ) করেন।

- নিজের অনুরোধ নিজে অনুমোদন করা যায় না, মালিক হলেও। অনুমোদনকারীর ওই বদলের সরাসরি-অনুমতিও লাগে।
- একটা রেকর্ডে একসাথে একটাই অপেক্ষমাণ অনুরোধ। অনুরোধের পরে রেকর্ড অন্যভাবে বদলালে অনুমোদনের সময় অনুরোধ `stale` হয়, পুরনো মান কখনো চাপানো হয় না।
- প্রয়োগ, অবস্থা বদল ও audit এক transaction-এ; কোথাও ত্রুটি হলে কিছুই বদলায় না।
- কেনা-দাম বা বাকির মতো লুকানো ফিল্ড অনুরোধের তালিকা ও বিস্তারিতেও দর্শকের অনুমতি অনুযায়ী লুকানো।
- কাঠামো সাধারণ (`src/core/approvals`); প্রতিটা module শুধু নিজের handler ঘোষণা করে। Step 5-এ বিক্রি ও কেনার সংশোধন ও বাতিল (উল্টো এন্ট্রিসহ) এভাবেই বসবে। কিছুই সত্যিই মোছা হয় না।

পুরো API, নমুনা ও ত্রুটি [docs/API.md](./docs/API.md#১০-সংশোধনের-অনুরোধ-ও-অনুমোদন)-তে।

### ব্যবসা-ডেটা আলাদা রাখা

ব্যবসার প্রতিটা রেকর্ডে `business_id`। কোডে ব্যবসা-ডেটা পড়া-লেখা হয় `prisma.forBusiness(businessId)` দিয়ে, যা প্রতিটা query-তে ব্যবসা নিজে বসায় এবং অন্য ব্যবসার id দিলে আটকায়। কেউ ভুল করে সাধারণ client দিয়ে `businessId` ছাড়া query লিখলে সেটা ত্রুটি দেয় (টেস্টে ধরা পড়ে)। কোড ও নম্বর (`P-0001`, `C-00001`) `document_counters` টেবিলের এক atomic SQL থেকে আসে, তাই একসাথে অনেক অনুরোধেও ডুপ্লিকেট হয় না। নাম ও ফোনের অনুসন্ধানে PostgreSQL-এর `pg_trgm` index (migration নিজে extension চালু করে; Neon-এ আছে)।

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
| `npm run admin:create` | প্রথম মালিক অ্যাকাউন্ট বানায় (একবার) |

## ফোল্ডার

```
src/
  main.ts            অ্যাপ চালু
  app.setup.ts       prefix, versioning, validation pipe, CORS (টেস্টও এটাই ব্যবহার করে)
  app.module.ts
  core/              সব ব্যবসার জন্য এক অংশ (README দেখুন)
    database/        Prisma module ও service
    auth/            লগইন, token, session
    permissions/     অনুমতির নিবন্ধন, গার্ড, ফিল্ড লুকানো
    access/          Settings API (রোলের অনুমতি, ইউজার)
    audit/           audit log
  generated/prisma/  Prisma client (git-এ নেই, `npm install`-এ তৈরি হয়)
  modules/
    dealership/      ডিলারশিপ ধরনের ব্যবসার module (README দেখুন)
test/                e2e টেস্ট
prisma/              schema, migration, seed, admin-create
prisma.config.ts     Prisma CLI-র কনফিগ
```

frontend-এর জন্য পুরো API রেফারেন্স (endpoint, request/response, ত্রুটি, cookie, অনুমতি): [docs/API.md](./docs/API.md)।

সিদ্ধান্ত ও ভার্সন তালিকা: [DECISIONS.md](./DECISIONS.md)। কাজের নিয়ম: [CLAUDE.md](./CLAUDE.md)।
