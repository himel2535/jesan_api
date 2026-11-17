// Sample master data for development only: `npm run db:seed:dev`.
// Refuses to run when NODE_ENV=production. Generic sample names and fake phone
// numbers (+88010000000xx is not a real Bangladeshi operator range), no real
// business data. Idempotent: rows that already exist are left alone.
import { connect, formatCode, nextNumber, prefixFor, uuidv7 } from './seed-helpers.mjs';

if (process.env.NODE_ENV === 'production') {
  console.error('db:seed:dev is for development only and refuses to run in production.');
  process.exit(1);
}

const BUSINESS_SLUG = 'akij-cement';

const categories = [
  { nameEn: 'OPC', nameBn: 'ওপিসি', sortOrder: 1 },
  { nameEn: 'PCC', nameBn: 'পিসিসি', sortOrder: 2 },
];

const products = [
  {
    category: 'OPC',
    nameEn: 'Sample OPC 50kg',
    nameBn: 'নমুনা ওপিসি ৫০ কেজি',
    cost: '540.00',
    sale: '560.00',
  },
  {
    category: 'OPC',
    nameEn: 'Sample OPC Premium 50kg',
    nameBn: 'নমুনা ওপিসি প্রিমিয়াম ৫০ কেজি',
    cost: '555.00',
    sale: '575.00',
  },
  {
    category: 'PCC',
    nameEn: 'Sample PCC 50kg',
    nameBn: 'নমুনা পিসিসি ৫০ কেজি',
    cost: '520.00',
    sale: '545.00',
  },
  {
    category: 'PCC',
    nameEn: 'Sample PCC Plus 50kg',
    nameBn: 'নমুনা পিসিসি প্লাস ৫০ কেজি',
    cost: '530.00',
    sale: '550.00',
  },
];

const customers = [
  {
    nameEn: 'Sample Store One',
    nameBn: 'নমুনা স্টোর এক',
    phone: '+8801000000001',
    area: 'Sample Area',
    opening: '0.00',
  },
  {
    nameEn: 'Sample Store Two',
    nameBn: 'নমুনা স্টোর দুই',
    phone: '+8801000000002',
    area: 'Sample Area',
    opening: '12500.00',
  },
  {
    nameEn: 'Sample Traders',
    nameBn: 'নমুনা ট্রেডার্স',
    phone: '+8801000000003',
    area: 'Sample Market',
    opening: '-2000.00',
  },
  {
    nameEn: 'Sample Hardware',
    nameBn: 'নমুনা হার্ডওয়্যার',
    phone: '+8801000000004',
    area: 'Sample Market',
    opening: '4800.00',
  },
  {
    nameEn: 'Sample Builders',
    nameBn: 'নমুনা বিল্ডার্স',
    phone: '+8801000000005',
    area: 'Sample Road',
    opening: '0.00',
  },
];

const client = await connect('Dev seed');
try {
  await client.query('BEGIN');
  const found = await client.query('SELECT id, config FROM businesses WHERE slug = $1', [
    BUSINESS_SLUG,
  ]);
  if (found.rowCount === 0) {
    throw new Error(`Business "${BUSINESS_SLUG}" not found: run npm run db:seed first.`);
  }
  const { id: businessId, config } = found.rows[0];
  let created = 0;

  const categoryIds = new Map();
  for (const category of categories) {
    await client
      .query(
        `INSERT INTO product_categories (id, business_id, name_en, name_bn, sort_order, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT DO NOTHING`,
        [uuidv7(), businessId, category.nameEn, category.nameBn, category.sortOrder],
      )
      .then((result) => (created += result.rowCount ?? 0));
    const row = await client.query(
      'SELECT id FROM product_categories WHERE business_id = $1 AND lower(name_en) = lower($2)',
      [businessId, category.nameEn],
    );
    categoryIds.set(category.nameEn, row.rows[0].id);
  }

  for (const product of products) {
    const exists = await client.query(
      'SELECT 1 FROM products WHERE business_id = $1 AND lower(name_en) = lower($2)',
      [businessId, product.nameEn],
    );
    if (exists.rowCount) continue;
    const number = await nextNumber(client, businessId, 'product');
    await client.query(
      `INSERT INTO products (id, business_id, code, category_id, name_en, name_bn, unit_key,
                             purchase_price, default_sale_price, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'bag', $7, $8, now())`,
      [
        uuidv7(),
        businessId,
        formatCode(prefixFor(config, 'product', 'P'), number, 4),
        categoryIds.get(product.category),
        product.nameEn,
        product.nameBn,
        product.cost,
        product.sale,
      ],
    );
    created += 1;
  }

  for (const customer of customers) {
    const exists = await client.query(
      'SELECT 1 FROM customers WHERE business_id = $1 AND phone = $2',
      [businessId, customer.phone],
    );
    if (exists.rowCount) continue;
    const number = await nextNumber(client, businessId, 'customer');
    await client.query(
      `INSERT INTO customers (id, business_id, code, name_en, name_bn, phone, area,
                              opening_balance, current_balance, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, now())`,
      [
        uuidv7(),
        businessId,
        formatCode(prefixFor(config, 'customer', 'C'), number, 5),
        customer.nameEn,
        customer.nameBn,
        customer.phone,
        customer.area,
        customer.opening,
      ],
    );
    created += 1;
  }

  await client.query('COMMIT');
  console.log(`Dev seed finished: ${String(created)} sample row(s) created.`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
