const { createDatabase, seedDummyStores } = require("./server");

const count = process.argv[2] === undefined ? 100000 : Number(process.argv[2]);
const batchSize = process.argv[3] === undefined ? 2000 : Number(process.argv[3]);

try {
  const db = createDatabase();
  try {
    const result = seedDummyStores(db, count, batchSize, (inserted, total) => {
      console.log(`Seeded ${inserted.toLocaleString()} / ${total.toLocaleString()} demo stores`);
    });
    console.log(`Done. Inserted ${result.inserted.toLocaleString()} demo stores (IDs ${result.firstId}-${result.lastId}).`);
  } finally {
    db.close();
  }
} catch (error) {
  console.error(`Store seed failed: ${error.message}`);
  process.exitCode = 1;
}