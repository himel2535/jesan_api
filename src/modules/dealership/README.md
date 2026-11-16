# modules/dealership

"ডিলারশিপ" ধরনের (template) ব্যবসার generic module: নির্দিষ্ট প্রিন্সিপাল সাপ্লায়ার থেকে নগদে কেনা, দোকানে বেচা, stock, বাকি ও commission।

## দায়িত্ব (পরের Phase-গুলোতে আসবে)

Product ও Category, Customer, Supplier, Buy, Sell, Stock, Due collection, Commission scheme ও progress, এবং এই module-এর manifest (sidebar মেনু, permission, dashboard summary provider)।

## নিয়ম

- একটাই module সব ডিলারশিপ ব্যবসার জন্য; কপি-পেস্ট নয়। ব্যবসা-নির্দিষ্ট পার্থক্য (নাম, প্রিন্সিপাল সাপ্লায়ার, একক, product, commission নিয়ম, লেবেল) আসে `businesses` table-এর config থেকে, কোডে হার্ড-কোড নয়।
- শুধু `src/core` ব্যবহার করে; অন্য কোনো module সরাসরি ডাকে না (দরকারে core-এর service বা event)।
- প্রতিটা query `businessId` দিয়ে ফিল্টার হয়; টাকায় Decimal; delete নয়, void।

## এখন যা আছে

- `dealership.permissions.ts`: এই module-এর অনুমতির ঘোষণা (কোন অনুমতি, কোন রোল ডিফল্টে পায়, কোনগুলো owner-only: `commission.*`, `profit.view`)।
- `dealership.module.ts`: অনুমতিগুলো core-এর registry-তে নিবন্ধন করে।

কোনো ফিচার (পণ্য, বিক্রি, কেনা, কমিশন) এখনো নেই।
