const { spawnSync } = require('child_process');
const path = require('path');

const tests = [
  'test_url_parser.js',
  'test_cookie_security.js',
  'test_api_metadata_quality.js',
  'test_download_ffmpeg.js',
  'test_concurrent_and_edge.js'
];

for (const file of tests) {
  const full = path.join(__dirname, file);
  console.log(`\n▶ Running ${file}...`);
  const r = spawnSync(process.execPath, [full], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    console.error(`❌ Suite failed at ${file} (exit ${r.status})`);
    process.exit(r.status || 1);
  }
}

console.log('\n🎉 ALL TEST SUITES PASSED!');
