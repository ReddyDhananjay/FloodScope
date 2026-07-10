/**
 * Build verification script.
 * Checks that all required server/frontend files exist and that
 * the Python analysis script is at least syntactically valid.
 * Run via: npm run build
 */
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const checks = [
  ['./server/index.js', 'Server entry point'],
  ['./server/auth.js', 'Authentication'],
  ['./server/db.js', 'DB connection'],
  ['./server/routes/flood.js', 'Flood API routes'],
  ['./server/routes/import.js', 'Import API routes'],
  ['./server/routes/gee.js', 'GEE API routes'],
  ['./server/models/FloodPoint.js', 'FloodPoint model'],
  ['./server/models/User.js', 'User model'],
  ['./server/models/Settings.js', 'Settings model'],
  ['./server/models/Dataset.js', 'Dataset model'],
  ['./server/gee.py', 'Earth Engine script'],
  ['./public/flood-explorer.html', 'Frontend app'],
  ['./public/login.html', 'Login page'],
  ['./public/index.html', 'Index redirect'],
  ['./package.json', 'package.json'],
];

console.log('\n  FloodScope Build Verification');
console.log('  ========================================\n');

let passed = 0;
let failed = 0;

for (const [rel, label] of checks) {
  const full = path.join(ROOT, rel);
  if (existsSync(full)) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label} — missing: ${rel}`);
    failed++;
  }
}

// Validate Python syntax without requiring the earthengine-api package to be installed
try {
  execFileSync('python3', ['-m', 'py_compile', path.join(ROOT, 'server', 'gee.py')], { stdio: 'pipe' });
  console.log('  ✅ Python syntax valid');
  passed++;
} catch (e) {
  console.log('  ❌ Python syntax invalid:', e.stderr ? e.stderr.toString().slice(-400) : e.message);
  failed++;
}

console.log('\n  ========================================');
console.log(`  Result: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
