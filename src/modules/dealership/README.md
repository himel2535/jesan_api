# modules/dealership

"ডিলারশিপ" ধরনের (template) ব্যবসার generic module: নির্দিষ্ট প্রিন্সিপাল সাপ্লায়ার থেকে নগদে কেনা, দোকানে বেচা, stock, বাকি ও commission।

## দায়িত্ব (পরের Phase-গুলোতে আসবে)

Product ও Category, Customer, Supplier, Buy, Sell, Stock, Due collection, Commission (পাওয়া টাকা ও কারণ), এবং এই module-এর manifest (sidebar মেনু, permission, dashboard summary provider)।

## নিয়ম

- একটাই module সব ডিলারশিপ ব্যবসার জন্য; কপি-পেস্ট নয়। ব্যবসা-নির্দিষ্ট পার্থক্য (নাম, প্রিন্সিপাল সাপ্লায়ার, একক, product, commission নিয়ম, লেবেল) আসে `businesses` table-এর config থেকে, কোডে হার্ড-কোড নয়।
- শুধু `src/core` ব্যবহার করে; অন্য কোনো module সরাসরি ডাকে না (দরকারে core-এর service বা event)।
- প্রতিটা query `businessId` দিয়ে ফিল্টার হয়; টাকায় Decimal; delete নয়, void।

## এখন যা আছে

- `dealership.permissions.ts`: এই module-এর অনুমতি (কোনটা owner-only, কোন রোল ডিফল্টে পায়) এবং ব্যবসা-ডেটার মডেলের তালিকা।
- `dealership.config.ts`: ব্যবসার settings (`businesses.config`) পড়া: এককের তালিকা, প্রধান একক, কোডের prefix, প্রিন্সিপাল সরবরাহকারী। পুরনো রূপও বোঝে।
- `master-data/`: ক্যাটাগরি, পণ্য, গ্রাহক, সরবরাহকারীর API (তালিকা, অনুসন্ধান, তৈরি, সম্পাদনা, নিষ্ক্রিয়)। সব query `prisma.forBusiness(...)` দিয়ে।

কেনা, বিক্রি, স্টক, খাতা, কমিশন এখনো নেই। BSRM-এর মতো নতুন ডিলারশিপ = নতুন ব্যবসার সারি ও config; এই module-এর কোড বদলাতে হয় না (টেস্টে যাচাই করা)।
