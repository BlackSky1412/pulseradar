import fs from 'node:fs';

const results = JSON.parse(fs.readFileSync('data/live_audit_results.json', 'utf8'));

for (const platform of ['TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'X']) {
  console.log('==============================================');
  console.log('PLATFORM:', platform);
  const items = results.filter((r: any) => r.platform === platform);
  for (const it of items) {
    const issues = it.scanCapability.issues.length > 0
      ? it.scanCapability.issues.join(' | ')
      : 'Hoạt động tốt (Anonymous OK)';
    console.log(
      `- @${it.username.padEnd(22)}: Valid=${it.validation.valid} [${it.validation.status}] | Story=${it.storyCheck.status}(${it.storyCheck.itemCount}) | Post=${it.postCheck.status}(${it.postCheck.itemCount}) -> ${issues}`
    );
  }
}
