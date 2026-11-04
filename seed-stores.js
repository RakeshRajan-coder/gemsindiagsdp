const fs = require('fs')
const { createDatabase, seedDummyStores } = require("./server");

async function main() {
  const count = process.argv[2] === undefined ? 100000 : Number(process.argv[2]);
  const batchSize = process.argv[3] === undefined ? 2000 : Number(process.argv[3]);

  try {
    const db = createDatabase();
    try {
      const result = await seedDummyStores(db, count, batchSize, (inserted, total) => {
        console.log(`Seeded ${inserted.toLocaleString()} / ${total.toLocaleString()} demo stores`);
      });
      fs.writeFileSync('stores-data.json', JSON.stringify(result, null, 2));
      console.log(`${count.toLocaleString()} demo stores written to stores-data.json`);
    } finally {
      if (db && typeof db.close === 'function') {
        db.close();
      }
    }
  } catch (error) {
    console.error(`Store seed failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
