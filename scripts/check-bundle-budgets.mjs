import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const BUDGETS = {
  initialJS: 200 * 1024,   // 200 KB gzipped
  totalJS: 500 * 1024,     // 500 KB gzipped
  totalCSS: 50 * 1024,     // 50 KB gzipped
};

const root = process.cwd();
const buildDir = path.join(root, '.next');

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileIfExists(filePath) {
  return fs.readFile(filePath, 'utf8').catch(() => null);
}

async function parseBuildManifest() {
  const manifestPath = path.join(buildDir, '_buildManifest.js');
  const manifestRaw = await readFileIfExists(manifestPath);
  if (!manifestRaw) return null;

  const pages = {};
  const routeMatch = /self\.__BUILD_MANIFEST\s*=\s*({[\s\S]*?});/.exec(manifestRaw);
  if (!routeMatch) return null;

  try {
    const manifest = new Function(`return ${routeMatch[1]}`)();
    return manifest;
  } catch {
    return null;
  }
}

async function collectGzippedSizes() {
  const jsFiles = [];
  const cssFiles = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith('.js')) {
        jsFiles.push(fullPath);
      } else if (entry.name.endsWith('.css')) {
        cssFiles.push(fullPath);
      }
    }
  }

  const chunksDir = path.join(buildDir, 'static');
  await walk(chunksDir);

  return { jsFiles, cssFiles };
}

async function measureGzip(filePath) {
  const { createGzip } = await import('node:zlib');
  const { pipeline } = await import('node:stream/promises');

  const content = await fs.readFile(filePath);
  const gz = createGzip();
  const chunks = [];
  const { Readable, Writable } = await import('node:stream');

  const readable = Readable.from(content);
  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });

  await pipeline(readable, gz, writable);
  return Buffer.concat(chunks).length;
}

async function main() {
  if (!buildDir) {
    console.error('No .next directory found. Run `next build` first.');
    process.exit(1);
  }

  const { jsFiles, cssFiles } = await collectGzippedSizes();

  if (jsFiles.length === 0 && cssFiles.length === 0) {
    console.warn('No JS or CSS bundles found in .next/static. Skipping budget check.');
    return;
  }

  const sizes = await Promise.all(
    [...jsFiles, ...cssFiles].map(async (f) => ({
      file: f,
      gzipped: await measureGzip(f),
      name: path.relative(buildDir, f),
    })),
  );

  const jsSizes = sizes.filter((s) => s.file.endsWith('.js'));
  const cssSizes = sizes.filter((s) => s.file.endsWith('.css'));

  const totalJS = jsSizes.reduce((sum, s) => sum + s.gzipped, 0);
  const totalCSS = cssSizes.reduce((sum, s) => sum + s.gzipped, 0);

  // Heuristic: the largest initial chunk is typically the main bundle
  const initialJS = jsSizes.length > 0
    ? Math.max(...jsSizes.map((s) => s.gzipped))
    : 0;

  const violations = [];

  if (initialJS > BUDGETS.initialJS) {
    violations.push({
      metric: 'Initial JS bundle',
      actual: initialJS,
      budget: BUDGETS.initialJS,
    });
  }

  if (totalJS > BUDGETS.totalJS) {
    violations.push({
      metric: 'Total JS',
      actual: totalJS,
      budget: BUDGETS.totalJS,
    });
  }

  if (totalCSS > BUDGETS.totalCSS) {
    violations.push({
      metric: 'Total CSS',
      actual: totalCSS,
      budget: BUDGETS.totalCSS,
    });
  }

  console.log('\nBundle Size Budget Report');
  console.log('========================\n');
  console.log(`JS files: ${jsSizes.length}`);
  console.log(`CSS files: ${cssSizes.length}`);
  console.log('');
  console.log(`Largest initial JS: ${formatBytes(initialJS)} (budget: ${formatBytes(BUDGETS.initialJS)})`);
  console.log(`Total JS:           ${formatBytes(totalJS)} (budget: ${formatBytes(BUDGETS.totalJS)})`);
  console.log(`Total CSS:          ${formatBytes(totalCSS)} (budget: ${formatBytes(BUDGETS.totalCSS)})`);

  if (violations.length > 0) {
    console.error('\nBudget violations:');
    for (const v of violations) {
      console.error(`  ${v.metric}: ${formatBytes(v.actual)} exceeds budget of ${formatBytes(v.budget)}`);
    }
    process.exit(1);
  }

  console.log('\nAll bundle budgets passed.');
}

main().catch((err) => {
  console.error('Bundle budget check failed:', err);
  process.exit(1);
});
