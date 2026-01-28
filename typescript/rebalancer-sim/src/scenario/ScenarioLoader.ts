import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import type { Address } from '@hyperlane-xyz/utils';

import type { ScenarioFile, TransferScenario } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, '..', '..', 'scenarios');

/**
 * Load a scenario file (full format with metadata and defaults)
 */
export function loadScenarioFile(name: string): ScenarioFile {
  const filePath = path.join(SCENARIOS_DIR, `${name}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Scenario not found: ${name}. Run 'pnpm generate-scenarios' first.`,
    );
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ScenarioFile;
}

/**
 * Load just the transfer scenario (runtime format with bigints)
 */
export function loadScenario(name: string): TransferScenario {
  const file = loadScenarioFile(name);
  return deserializeTransfers(file);
}

/**
 * Convert scenario file transfers to runtime format
 */
function deserializeTransfers(file: ScenarioFile): TransferScenario {
  return {
    name: file.name,
    duration: file.duration,
    chains: file.chains,
    transfers: file.transfers.map((t) => ({
      id: t.id,
      timestamp: t.timestamp,
      origin: t.origin,
      destination: t.destination,
      amount: BigInt(t.amount),
      user: t.user as Address,
    })),
  };
}

/**
 * List all available scenarios
 */
export function listScenarios(): string[] {
  if (!fs.existsSync(SCENARIOS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));
}

/**
 * Get the scenarios directory path
 */
export function getScenariosDir(): string {
  return SCENARIOS_DIR;
}
