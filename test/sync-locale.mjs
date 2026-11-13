import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

function grab(lang) {
  const baseMatch = src.match(new RegExp(`const ${lang} = (\\{[\\s\\S]*?\\});`));
  const addMatch = src.match(new RegExp(`Object\\.assign\\(${lang}, (\\{[\\s\\S]*?\\})\\);`));
  if (!baseMatch || !addMatch) throw new Error(`无法从 client.js 提取 ${lang} 字典`);
  return { ...JSON.parse(baseMatch[1]), ...new Function(`return ${addMatch[1]}`)() };
}

const dryRun = process.argv.includes('--dry-run');
for (const [lang, file] of [['zh', 'locale/zh.json'], ['en', 'locale/en.json']]) {
  const merged = grab(lang);
  const abs = path.join(root, file);
  const cur = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const missingMeta = Object.keys(merged.meta || {}).filter((key) => !(key in (cur.meta || {})));
  const missing = Object.keys(merged).filter((key) => key !== 'meta' && !(key in cur));
  for (const key of missing) cur[key] = merged[key];
  if (cur.meta) for (const key of missingMeta) cur.meta[key] = merged.meta[key];
  if (!dryRun && (missing.length || missingMeta.length)) fs.writeFileSync(abs, `${JSON.stringify(cur, null, 2)}\n`);
  console.log(`${file}: +${missing.length} 键, +${missingMeta.length} meta 键${dryRun ? '（试运行）' : ''}`);
}
