import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { ScenarioGenerator } from './ScenarioGenerator.js';
import type { SerializedScenario, TransferScenario } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, '..', '..', 'scenarios');

/**
 * Load a scenario from the scenarios directory by name
 */
export function loadScenario(name: string): TransferScenario {
  const filePath = path.join(SCENARIOS_DIR, `${name}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Scenario not found: ${name}. Run 'pnpm generate-scenarios' first.`,
    );
  }

  const data = JSON.parse(
    fs.readFileSync(filePath, 'utf-8'),
  ) as SerializedScenario;
  return ScenarioGenerator.deserialize(data);
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
 * Get scenario metadata without loading full transfer data
 */
export function getScenarioMetadata(name: string): {
  name: string;
  duration: number;
  chains: string[];
  transferCount: number;
} {
  const filePath = path.join(SCENARIOS_DIR, `${name}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Scenario not found: ${name}`);
  }

  const data = JSON.parse(
    fs.readFileSync(filePath, 'utf-8'),
  ) as SerializedScenario;
  return {
    name: data.name,
    duration: data.duration,
    chains: data.chains,
    transferCount: data.transfers.length,
  };
}

/**
 * Load all scenarios
 */
export function loadAllScenarios(): TransferScenario[] {
  return listScenarios().map(loadScenario);
}
