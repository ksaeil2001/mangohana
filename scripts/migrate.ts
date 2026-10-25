import { Database } from '../packages/storage/src/database.js';
import { migrate } from '../packages/storage/src/migrations.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must explicitly select the intended database.');
const db = new Database(process.env.DATABASE_URL);
try { console.log(JSON.stringify({ applied: await migrate(db.pool) })); }
finally { await db.close(); }
