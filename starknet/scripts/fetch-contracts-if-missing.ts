import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

const CONTRACTS_DIR = join(process.cwd(), 'src', 'contracts');

try {
  if (existsSync(CONTRACTS_DIR)) {
    const files = readdirSync(CONTRACTS_DIR);
    if (files.length > 0) {
      console.log(
        '[INFO] Contracts already present in src/contracts, skipping fetch',
      );
      process.exit(0);
    }
  }

  console.log('[INFO] Fetching contracts...');
  execSync('./scripts/fetch-contracts.sh', {
    stdio: 'inherit',
    cwd: join(process.cwd()),
  });
} catch (error) {
  console.error('[ERROR]', (error as Error).message);
  process.exit(1);
}
