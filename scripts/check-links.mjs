import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const srcDir = path.join(root, 'src');
const publicDir = path.join(root, 'public');

const LINK_PATTERN = /(?:src|href|url)\s*=\s*["']([^"']+)["']/g;
const CSS_URL_PATTERN = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g;
const IMAGE_IMPORT_PATTERN = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const STATIC_IMPORT_PATTERN = /import\s+.*\s+from\s+['"]([^'"]+)['"]/g;
const ASSET_EXTENSIONS = new Set([
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.webm', '.mp3',
  '.pdf',
]);

const IGNORE_PATTERNS = [
  /^https?:\/\//,
  /^data:/,
  /^#/,
  /^\//,          // absolute paths resolve from public
  /^mailto:/,
  /^tel:/,
  /^javascript:/,
  /^blob:/,
  /^node:/,
];

function isAssetReference(ref) {
  return ASSET_EXTENSIONS.has(path.extname(ref).toLowerCase());
}

function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}

async function walkSource(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkSource(fullPath));
    } else if (/\.(tsx?|jsx?|css|scss)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function checkPublicAssets() {
  let entries;
  try {
    entries = await fs.readdir(publicDir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }

  const assets = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      const fullPath = path.join(entry.parentPath ?? entry.path, entry.name);
      assets.push(fullPath);
    }
  }
  return assets;
}

async function main() {
  const issues = [];

  const sourceFiles = await walkSource(srcDir);
  const publicAssets = await checkPublicAssets();
  const publicPaths = new Set(
    publicAssets.map((a) => path.relative(publicDir, a).replaceAll(path.sep, '/')),
  );

  console.log(`Scanning ${sourceFiles.length} source files...`);
  console.log(`Found ${publicAssets.length} assets in /public\n`);

  for (const file of sourceFiles) {
    let content;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    const relFile = path.relative(root, file).replaceAll(path.sep, '/');

    // Check HTML attributes (src=, href=)
    for (const match of content.matchAll(LINK_PATTERN)) {
      const ref = match[1];
      if (IGNORE_PATTERNS.some((p) => p.test(ref))) continue;
      if (!isAssetReference(ref)) continue;

      const cleanRef = ref.split('?')[0].split('#')[0];
      const publicRelative = cleanRef.startsWith('/') ? cleanRef.slice(1) : cleanRef;
      if (!publicPaths.has(publicRelative)) {
        issues.push({
          file: relFile,
          reference: ref,
          message: `Missing asset: ${publicRelative}`,
        });
      }
    }

    // Check CSS url() references
    for (const match of content.matchAll(CSS_URL_PATTERN)) {
      const ref = match[1];
      if (IGNORE_PATTERNS.some((p) => p.test(ref))) continue;
      if (!isAssetReference(ref)) continue;

      const cleanRef = ref.split('?')[0].split('#')[0];
      if (cleanRef.startsWith('~') || cleanRef.startsWith('@')) continue;
      const publicRelative = cleanRef.startsWith('/') ? cleanRef.slice(1) : cleanRef;
      if (!publicPaths.has(publicRelative)) {
        issues.push({
          file: relFile,
          reference: ref,
          message: `Missing asset in CSS: ${publicRelative}`,
        });
      }
    }
  }

  if (issues.length > 0) {
    console.error('Link/asset issues found:\n');
    for (const issue of issues) {
      console.error(`  ${issue.file}`);
      console.error(`    ${issue.message} (ref: ${issue.reference})`);
    }
    console.error(`\n${issues.length} issue(s) found.`);
    process.exit(1);
  }

  console.log('All internal links and assets are valid.');
}

main().catch((err) => {
  console.error('Link check failed:', err);
  process.exit(1);
});
