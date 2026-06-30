/**
 * Set a setting value in the database.
 * Usage:
 *   node scripts/set-key.js GOOGLE_MAPS_KEY AIzaSyXXXXXX
 *   node scripts/set-key.js NVIDIA_API_KEY nvapi-XXXXXX
 */
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const key = process.argv[2];
  const value = process.argv[3];

  if (!key || !value) {
    console.log('\n  Usage: node scripts/set-key.js <KEY_NAME> <VALUE>');
    console.log('\n  Examples:');
    console.log('    node scripts/set-key.js GOOGLE_MAPS_KEY AIzaSyXXXXXXX');
    console.log('    node scripts/set-key.js NVIDIA_API_KEY nvapi-XXXXXXX\n');
    process.exit(1);
  }

  const { connectDB } = await import('../server/db.js');
  await connectDB();

  const { setSetting } = await import('../server/models/Settings.js');
  await setSetting(key, value);

  console.log('\n  ✅ Saved "' + key + '" to database\n');
  process.exit(0);
}

main().catch(err => { console.error('  ❌ Error:', err.message); process.exit(1); });
