const { Pool } = require('pg');
const os = require('os');

const CONCURRENCY = parseInt(process.env.SEED_CONCURRENCY, 10) || os.cpus().length;

const pool = new Pool({
  user: process.env.DB_USER || 'admin',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  port: parseInt(process.env.DB_PORT || '5432'),
  max: CONCURRENCY,
});

const categories = [
  'Food & Dining',
  'Transportation',
  'Shopping',
  'Entertainment',
  'Bills & Utilities',
  'Healthcare',
  'Travel',
  'Education',
  'Other'
];

const descriptions = {
  'Food & Dining': [
    'Lunch at cafe', 'Grocery shopping', 'Coffee', 'Dinner out', 'Pizza delivery',
    'Fast food', 'Restaurant meal', 'Breakfast', 'Snacks', 'Takeout'
  ],
  'Transportation': [
    'Gas station', 'Uber ride', 'Bus fare', 'Train ticket', 'Parking fee',
    'Car maintenance', 'Taxi', 'Metro card', 'Bridge toll', 'Airport shuttle'
  ],
  'Shopping': [
    'Clothing', 'Electronics', 'Home goods', 'Books', 'Shoes',
    'Online purchase', 'Gift', 'Tools', 'Furniture', 'Accessories'
  ],
  'Entertainment': [
    'Movie tickets', 'Concert', 'Streaming service', 'Video games', 'Sports event',
    'Theater show', 'Museum', 'Amusement park', 'Mini golf', 'Bowling'
  ],
  'Bills & Utilities': [
    'Electric bill', 'Internet', 'Phone bill', 'Water bill', 'Insurance',
    'Rent', 'Credit card payment', 'Loan payment', 'Subscription', 'Bank fee'
  ],
  'Healthcare': [
    'Doctor visit', 'Pharmacy', 'Dental checkup', 'Eye exam', 'Prescription',
    'Hospital', 'Physical therapy', 'Medical test', 'Vitamins', 'First aid'
  ],
  'Travel': [
    'Hotel', 'Flight', 'Car rental', 'Travel insurance', 'Luggage',
    'Tourist attraction', 'Travel guide', 'Currency exchange', 'Visa fee', 'Vacation'
  ],
  'Education': [
    'Course fee', 'Books', 'School supplies', 'Tuition', 'Online class',
    'Workshop', 'Certification', 'Training', 'Educational software', 'Seminar'
  ],
  'Other': [
    'Miscellaneous', 'Cash withdrawal', 'ATM fee', 'Charity donation', 'Pet expenses',
    'Home repair', 'Cleaning supplies', 'Personal care', 'Garden supplies', 'Storage'
  ]
};

const amountRanges = {
  'Food & Dining': [5, 145],
  'Transportation': [3, 197],
  'Shopping': [10, 490],
  'Entertainment': [8, 292],
  'Bills & Utilities': [25, 775],
  'Healthcare': [20, 980],
  'Travel': [50, 1950],
  'Education': [30, 1170],
  'Other': [5, 245]
};

// Precompute date range
const now = Date.now();
const twoYearsAgo = now - 2 * 365.25 * 24 * 60 * 60 * 1000;
const dateRange = now - twoYearsAgo;

function generateRow() {
  const category = categories[(Math.random() * categories.length) | 0];
  const descs = descriptions[category];
  const description = descs[(Math.random() * descs.length) | 0];
  const [min, span] = amountRanges[category];
  const amount = Math.round((min + Math.random() * span) * 100) / 100;
  const date = new Date(twoYearsAgo + Math.random() * dateRange).toISOString().slice(0, 10);
  return [description, amount, category, date];
}

// Build a multi-row INSERT for a chunk of rows
const CHUNK_SIZE = 250; // 250 rows × 4 params = 1000 params, well within PG limit

function buildInsert(rows) {
  const values = new Array(rows.length * 4);
  const placeholders = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const o = i * 4;
    values[o] = rows[i][0];
    values[o + 1] = rows[i][1];
    values[o + 2] = rows[i][2];
    values[o + 3] = rows[i][3];
    placeholders[i] = `($${o + 1},$${o + 2},$${o + 3},$${o + 4})`;
  }
  return {
    text: `INSERT INTO expenses (description, amount, category, date) VALUES ${placeholders.join(',')}`,
    values
  };
}

async function seedDatabase() {
  const DEFAULT_TARGET_ROWS = 10000000;
  const targetRows = parseInt(process.env.SEED_EXPENSE_ROWS, 10) || DEFAULT_TARGET_ROWS;
  const batchSize = 5000;
  const totalBatches = Math.ceil(targetRows / batchSize);

  console.log(`Starting database seeding: ${targetRows.toLocaleString()} rows (${CONCURRENCY} workers)`);

  try {
    const countResult = await pool.query('SELECT COUNT(*) FROM expenses');
    const currentCount = parseInt(countResult.rows[0].count);
    console.log(`Current expense count: ${currentCount.toLocaleString()}`);

    if (currentCount >= targetRows) {
      console.log('Database already has sufficient data. Skipping seed.');
      return;
    }

    const rowsToInsert = targetRows - currentCount;
    const batchesToInsert = Math.ceil(rowsToInsert / batchSize);

    console.log(`Inserting ${rowsToInsert.toLocaleString()} rows in ${batchesToInsert.toLocaleString()} batches...`);

    const startTime = Date.now();
    let completedBatches = 0;

    async function insertBatch(batchIndex) {
      const currentBatchSize = Math.min(batchSize, rowsToInsert - (batchIndex * batchSize));
      const rows = new Array(currentBatchSize);
      for (let i = 0; i < currentBatchSize; i++) {
        rows[i] = generateRow();
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
          const chunk = rows.slice(i, i + CHUNK_SIZE);
          const query = buildInsert(chunk);
          await client.query(query);
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      completedBatches++;
      if (completedBatches % 100 === 0 || completedBatches === batchesToInsert) {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const rowsDone = completedBatches * batchSize;
        const progress = ((completedBatches / batchesToInsert) * 100).toFixed(1);
        const rate = Math.round(rowsDone / elapsedSec).toLocaleString();
        const remaining = batchesToInsert - completedBatches;
        const eta = remaining > 0 ? Math.round(remaining * (elapsedSec / completedBatches)) : 0;
        console.log(`Progress: ${progress}% - ${rowsDone.toLocaleString()} rows - ${rate} rows/s - ${elapsedSec.toFixed(1)}s elapsed - ETA: ${eta}s`);
      }
    }

    const batches = Array.from({ length: batchesToInsert }, (_, i) => i);
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const chunk = batches.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(insertBatch));
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalResult = await pool.query('SELECT COUNT(*) FROM expenses');
    const finalCount = parseInt(finalResult.rows[0].count);

    console.log(`Seeding completed!`);
    console.log(`Total rows: ${finalCount.toLocaleString()}`);
    console.log(`Time taken: ${totalTime}s (${(totalTime / 60).toFixed(1)} min)`);
    console.log(`Average: ${(rowsToInsert / totalTime).toFixed(0)} rows/second`);

  } catch (error) {
    console.error('Error seeding database:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  seedDatabase();
}

module.exports = { seedDatabase };
