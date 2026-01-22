import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = '.tronbox-build';

// Only copy these dependencies to avoid copying the entire node_modules
// Add more as needed based on your imports
const REQUIRED_DEPS = [
  '@arbitrum/nitro-contracts',
  '@chainlink/contracts-ccip',
  '@openzeppelin/contracts',
  '@openzeppelin/contracts-upgradeable',
];

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function copyRequiredNodeModules(srcNodeModules, destNodeModules) {
  await fs.mkdir(destNodeModules, { recursive: true });

  for (const dep of REQUIRED_DEPS) {
    const srcPath = path.join(srcNodeModules, dep);
    const destPath = path.join(destNodeModules, dep);

    try {
      await fs.access(srcPath);
      console.log(`  Copying: ${dep}`);
      await copyDir(srcPath, destPath);
    } catch (e) {
      console.warn(`  Skipping (not found): ${dep}`);
    }
  }
}

async function processFile(filePath) {
  if (!filePath.endsWith('.sol')) return;

  let content = await fs.readFile(filePath, 'utf8');

  // Replace .isContract() pattern with address(...).code.length > 0
  const regex = /(\b\w+(?:\.\w+)*)\s*\.isContract\(\)/g;
  const newContent = content.replace(regex, '(address($1).code.length > 0)');

  if (content !== newContent) {
    console.log(`  Patched: ${path.relative(process.cwd(), filePath)}`);
    await fs.writeFile(filePath, newContent);
  }
}

async function processDir(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await processDir(fullPath);
    } else {
      await processFile(fullPath);
    }
  }
}

async function copyTronboxConfig(srcDir, destDir) {
  const configFiles = ['tronbox.js', 'tronbox-config.js', 'tronbox.json'];

  for (const configFile of configFiles) {
    const src = path.join(srcDir, configFile);
    const dest = path.join(destDir, configFile);
    try {
      await fs.copyFile(src, dest);
      console.log(`  Copied: ${configFile}`);
    } catch (e) {
      // Config file doesn't exist, skip
    }
  }
}

async function copyBuildArtifacts(tempDir) {
  console.log('\nCopying build artifacts to artifacts-tron...');
  const buildSrc = path.join(tempDir, 'build');
  const artifactsDest = path.join(__dirname, 'artifacts-tron');

  // Clean artifacts-tron folder
  await fs.rm(artifactsDest, { recursive: true, force: true });
  await fs.mkdir(artifactsDest, { recursive: true });

  // Copy only non-Mock and non-Test files
  async function copySelectiveDir(src, dest) {
    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      // Skip files/folders containing 'Mock' or 'Test'
      if (entry.name.includes('Mock') || entry.name.includes('Test')) {
        continue;
      }

      if (entry.isDirectory()) {
        await fs.mkdir(destPath, { recursive: true });
        await copySelectiveDir(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  await copySelectiveDir(buildSrc, artifactsDest);
  console.log('  Done.');
}

async function main() {
  const tempDir = path.join(__dirname, TEMP_DIR);

  console.log('=== TronBox Preprocessing Build ===\n');

  // Clean up any previous build
  console.log('Cleaning previous build...');
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });

  // Copy contracts
  console.log('\nCopying contracts...');
  const contractsSrc = path.join(__dirname, 'contracts');
  const contractsDest = path.join(tempDir, 'contracts');
  await copyDir(contractsSrc, contractsDest);
  console.log('  Done.');

  // Copy required node_modules
  console.log('\nCopying node_modules dependencies...');
  const nodeModulesSrc = path.join(__dirname, 'node_modules');
  const nodeModulesDest = path.join(tempDir, 'node_modules');
  await copyRequiredNodeModules(nodeModulesSrc, nodeModulesDest);

  // Copy tronbox config files
  console.log('\nCopying tronbox configuration...');
  await copyTronboxConfig(__dirname, tempDir);

  // Patch all .sol files in contracts
  console.log('\nPatching .isContract() calls in contracts...');
  await processDir(contractsDest);

  // Patch all .sol files in node_modules
  console.log('\nPatching .isContract() calls in node_modules...');
  await processDir(nodeModulesDest);

  // Change module type for build folder
  await fs.writeFile(`${TEMP_DIR}/package.json`, '{"type": "commonjs"}');

  // Run tronbox compile from temp directory
  console.log('\n=== Running tronbox compile ===\n');
  execSync('npx tronbox compile', {
    cwd: tempDir,
    stdio: 'inherit',
  });

  console.log('\n=== Compilation complete! ===');
  console.log(`Build artifacts are in ${TEMP_DIR}/build/`);

  // Copy build artifacts to artifacts-tron
  await copyBuildArtifacts(tempDir);
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
