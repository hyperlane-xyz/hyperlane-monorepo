/**
 * Lint script to detect dependencies used in multiple packages that aren't using the catalog.
 *
 * This catches the scenario where:
 * 1. Developer A adds `dep-x: ^1.0.0` to package A (single use, no catalog needed)
 * 2. Developer B later adds `dep-x: ^1.0.0` to package B (now multi-use but not cataloged)
 *
 * Run with: pnpm run lint:catalog
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dependencies that are intentionally allowed to have different versions across packages.
// express: v4 in ccip-server, v5 in http-registry-server (different API compatibility needs)
// @types/express: follows express versions
// @ethersproject/*: all use "*" wildcard to match ethers version
const ALLOWED_EXCEPTIONS = ['express', '@types/express', /^@ethersproject\//];

function isAllowedException(depName: string): boolean {
  return ALLOWED_EXCEPTIONS.some((exception) =>
    typeof exception === 'string'
      ? depName === exception
      : exception.test(depName),
  );
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface DepUsage {
  version: string;
  packageName: string;
  packagePath: string;
  depType: 'dependencies' | 'devDependencies' | 'peerDependencies';
}

// Find all package.json files in the monorepo
function findPackageJsonFiles(dir: string, files: string[] = []): string[] {
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);

    // Skip node_modules, hidden directories, and vendored dependencies
    if (
      entry === 'node_modules' ||
      entry.startsWith('.') ||
      entry === 'dist' ||
      entry === 'cache' ||
      entry === 'bundle' ||
      entry === 'dependencies' // Vendored third-party contracts in solidity/dependencies
    ) {
      continue;
    }

    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      findPackageJsonFiles(fullPath, files);
    } else if (entry === 'package.json') {
      files.push(fullPath);
    }
  }

  return files;
}

// Parse dependencies from a package.json
function parseDependencies(
  packagePath: string,
  includePeerDeps: boolean,
): Map<string, DepUsage> | undefined {
  try {
    const content = readFileSync(packagePath, 'utf-8');
    const pkg: PackageJson = JSON.parse(content);
    const deps = new Map<string, DepUsage>();

    const depTypes = includePeerDeps
      ? (['dependencies', 'devDependencies', 'peerDependencies'] as const)
      : (['dependencies', 'devDependencies'] as const);

    for (const depType of depTypes) {
      const depsObj = pkg[depType];
      if (!depsObj) continue;

      for (const [name, version] of Object.entries(depsObj)) {
        // Skip workspace dependencies
        if (version.startsWith('workspace:')) continue;

        deps.set(`${depType}:${name}`, {
          version,
          packageName: pkg.name || packagePath,
          packagePath,
          depType,
        });
      }
    }

    return deps;
  } catch {
    return undefined;
  }
}

function main() {
  const monorepoRoot = join(__dirname, '..');
  const includePeerDeps = process.argv.includes('--include-peer-deps');

  console.log('Scanning for package.json files...\n');

  const packageJsonFiles = findPackageJsonFiles(monorepoRoot);

  // Map of dep name -> list of usages (across all dep types combined)
  const depUsages = new Map<string, DepUsage[]>();

  for (const packagePath of packageJsonFiles) {
    const deps = parseDependencies(packagePath, includePeerDeps);
    if (!deps) continue;

    for (const [key, usage] of deps) {
      // Extract just the dep name (without depType prefix)
      const depName = key.split(':').slice(1).join(':');

      if (!depUsages.has(depName)) {
        depUsages.set(depName, []);
      }
      depUsages.get(depName)!.push(usage);
    }
  }

  // Find multi-package deps not using catalog
  const violations: Array<{ depName: string; usages: DepUsage[] }> = [];

  for (const [depName, usages] of depUsages) {
    // Only care about deps used in 2+ packages
    if (usages.length < 2) continue;

    // Skip allowed exceptions
    if (isAllowedException(depName)) continue;

    // Check if any usage is NOT using catalog:
    const nonCatalogUsages = usages.filter(
      (u) => !u.version.startsWith('catalog:'),
    );

    if (nonCatalogUsages.length > 0) {
      violations.push({ depName, usages });
    }
  }

  if (violations.length === 0) {
    console.log(
      '✅ All multi-package dependencies are using the catalog protocol.\n',
    );
    process.exit(0);
  }

  console.log(
    `❌ Found ${violations.length} dependencies used in multiple packages without catalog:\n`,
  );

  for (const { depName, usages } of violations.sort((a, b) =>
    a.depName.localeCompare(b.depName),
  )) {
    console.log(`  ${depName}:`);

    // Group by version
    const byVersion = new Map<string, DepUsage[]>();
    for (const usage of usages) {
      if (!byVersion.has(usage.version)) {
        byVersion.set(usage.version, []);
      }
      byVersion.get(usage.version)!.push(usage);
    }

    for (const [version, versionUsages] of byVersion) {
      const isCatalog = version.startsWith('catalog:');
      const marker = isCatalog ? '✓' : '✗';
      console.log(`    ${marker} ${version}:`);
      for (const usage of versionUsages) {
        const relativePath = usage.packagePath.replace(monorepoRoot + '/', '');
        console.log(`      - ${relativePath} (${usage.depType})`);
      }
    }
    console.log();
  }

  console.log(
    'To fix: Add these dependencies to the catalog in pnpm-workspace.yaml',
  );
  console.log(
    'and update the package.json files to use "catalog:" as the version.\n',
  );

  process.exit(1);
}

main();
