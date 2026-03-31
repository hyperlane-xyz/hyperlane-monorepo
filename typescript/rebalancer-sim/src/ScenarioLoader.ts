import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { assert } from '@hyperlane-xyz/utils';
import type { Address } from '@hyperlane-xyz/utils';

import type { ScenarioFile, TransferScenario } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCENARIOS_DIR = path.join(__dirname, '..', 'scenarios');
const SCENARIOS_DIR_ENV = 'SCENARIOS_DIR';

function resolveScenariosDir(): string {
  const envValue = process.env[SCENARIOS_DIR_ENV]?.trim();
  if (!envValue) {
    return DEFAULT_SCENARIOS_DIR;
  }

  if (path.isAbsolute(envValue)) {
    return envValue;
  }

  return path.resolve(process.cwd(), envValue);
}

/**
 * Load a scenario file (full format with metadata and defaults)
 */
export function loadScenarioFile(name: string): ScenarioFile {
  assert(
    !name.includes('..') && !path.isAbsolute(name),
    `Invalid scenario name: ${name}`,
  );
  const scenariosDir = resolveScenariosDir();
  const filePath = path.join(scenariosDir, `${name}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Scenario not found: ${name} in ${scenariosDir}. Run 'pnpm generate-scenarios' first.`,
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
  const scenariosDir = resolveScenariosDir();
  if (!fs.existsSync(scenariosDir)) {
    return [];
  }

  return fs
    .readdirSync(scenariosDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .sort();
}

/**
 * Get the scenarios directory path
 */
export function getScenariosDir(): string {
  return resolveScenariosDir();
}
