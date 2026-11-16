# core

সব ব্যবসার জন্য এক ও অভিন্ন অংশ। প্রপোজাল সেকশন ৩ অনুযায়ী এখানে থাকবে: auth ও রোল, businesses registry, module manifest, ledger/accounts ইঞ্জিন, document numbering, audit log, settings, report/export কাঠামো।

## নিয়ম

- core কোনো ব্যবসার নাম বা নিয়ম জানে না। এখানে `akij` বা `bsrm` শব্দ থাকলে সেটা ভুল।
- core কখনো `src/modules/*` থেকে কিছু import করে না। module-রা core ব্যবহার করে, উল্টোটা নয়।
- পাস-ফেল পরীক্ষা: নতুন ব্যবসা যোগ করতে core-এর কোনো ফাইল বদলাতে হলে স্থাপত্য ঠিক হয়নি।

## এখন যা আছে

- `config/`: environment variable ভ্যালিডেশন।
- `database/`: `DatabaseModule` (global) ও `PrismaService`। একটাই Prisma client ও connection pool। অন্য service-এ `PrismaService` inject করে `prisma.client` ব্যবহার করো।
- `health/`: `GET /api/v1/health` (liveness, কোনো I/O নয়) ও `GET /api/v1/health/ready` (ডাটাবেস চেক)।
- `auth/`: লগইন (email বা phone + পাসওয়ার্ড), refresh, logout, `me`, পাসওয়ার্ড বদল। argon2id, httpOnly cookie, refresh token rotation, লক ও rate limit।
- `permissions/`: অনুমতির নিবন্ধন (`PermissionRegistry`), গার্ড (`BusinessAccessGuard`, `PermissionGuard`), `@RequirePermission`, `AccessResolver` (cache সহ), এবং সার্ভারে ফিল্ড লুকানোর ব্যবস্থা (`@VisibleWith`, `@SerializeWith`)।
- `access/`: Settings API: রোলের অনুমতি, ইউজার তৈরি ও ব্যবস্থাপনা।
- `audit/`: শুধু-যোগ-হয় audit log।

Core টেবিল (`prisma/schema.prisma`): `businesses`, `users`, `roles`, `user_business_access`, `permissions`, `role_permissions`, `sessions`, `audit_logs`।

## নতুন route লেখার নিয়ম

- সব route ডিফল্টে লগইন-সুরক্ষিত। `@Public()` শুধু health ও sign-in endpoint-এ।
- ব্যবসার route-এর পথ `b/:businessSlug/...`। প্রতিটায় `@RequirePermission('...')` বা (ইচ্ছা করে) `@AnyBusinessMember()` লাগবে; কিছু না লিখলে সবার জন্য 403 (ভুলে খুলে যাওয়া আটকাতে)।
- টাকার সংবেদনশীল ফিল্ড (কমিশন, লাভ, কেনা-দাম, মোট আয়) response DTO-তে `@VisibleWith('অনুমতি')` দিয়ে ঘোষণা করো এবং handler-এ `@SerializeWith(Dto)` দাও। ঘোষণা ছাড়া কোনো ফিল্ড বের হয় না।
- নতুন module নিজের অনুমতি `PermissionRegistry.register(...)` দিয়ে ঘোষণা করবে (`src/modules/dealership/dealership.permissions.ts` দেখো)। `commission.` বা `profit.` দিয়ে শুরু অনুমতি অবশ্যই `ownerOnly`।
