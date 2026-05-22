#!/usr/bin/env node

import https from 'https';
import unzipper from 'unzipper';
import { Transform } from 'stream';

function get(url, redirects = 10) {
  return new Promise((resolve, reject) => {
    console.log('GET', url);
    https.get(url, res => {
      console.log('  status:', res.statusCode, '  content-length:', res.headers['content-length']);
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        if (!redirects) { res.resume(); return reject(new Error('Too many redirects')); }
        res.resume();
        return get(res.headers.location, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      resolve(res);
    }).on('error', reject);
  });
}

async function main() {
  const url = process.argv[2];
  if (!url) { console.error('Usage: node scripts/debug-download.js <url>'); process.exit(1); }

  const res = await get(url);

  let bytesIn = 0;
  const byteCounter = new Transform({
    transform(chunk, _enc, cb) {
      bytesIn += chunk.length;
      process.stdout.write(`  ${(bytesIn / 1024 / 1024).toFixed(1)} MB flowing\r`);
      cb(null, chunk);
    },
  });

  console.log('Piping to unzipper...');
  const zip = res.pipe(byteCounter).pipe(unzipper.Parse({ forceStream: true }));

  for await (const entry of zip) {
    console.log(`\n  entry: "${entry.path}"  type: ${entry.type}`);
    entry.autodrain();
  }

  console.log(`\nDone. ${(bytesIn / 1024 / 1024).toFixed(1)} MB total.`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
