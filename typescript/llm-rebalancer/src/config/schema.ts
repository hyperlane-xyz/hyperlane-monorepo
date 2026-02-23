import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

import { readFileAtPath } from '@hyperlane-xyz/utils/fs';

import type { LlmRebalancerConfig } from '../types.js';

const SkillProfileSchema = z.object({
  observe: z.string(),
  inflightRpc: z.string(),
  inflightExplorer: z.string(),
  inflightHybrid: z.string(),
  executeMovable: z.string(),
  executeInventoryLifi: z.string(),
  reconcile: z.string(),
  globalNetting: z.string(),
});

const RuntimeConfigSchema = z.object({
  type: z.literal('pi-openclaw').default('pi-openclaw'),
  command: z.string().default('openclaw'),
  argsTemplate: z
    .array(z.string())
    .default(['skills', 'run', '--skill', '{skillPath}', '--input', '{inputPath}']),
  timeoutMs: z.number().int().positive().default(120000),
});

const ConfigSchema = z.object({
  warpRouteIds: z.array(z.string()).min(1),
  registryUri: z.string(),
  llmProvider: z.enum(['codex', 'claude']),
  llmModel: z.string(),
  intervalMs: z.number().int().positive().default(60000),
  db: z.object({ url: z.string() }),
  inflightMode: z.enum(['rpc', 'explorer', 'hybrid']).default('hybrid'),
  skills: z.object({ profile: SkillProfileSchema }),
  signerEnv: z.string().default('HYP_REBALANCER_KEY'),
  inventorySignerEnv: z.string().optional(),
  executionPaths: z.array(z.enum(['movableCollateral', 'inventory'])).min(1),
  inventoryBridge: z.literal('lifi').default('lifi'),
  runtime: RuntimeConfigSchema.default({
    type: 'pi-openclaw',
    command: 'openclaw',
    argsTemplate: ['skills', 'run', '--skill', '{skillPath}', '--input', '{inputPath}'],
    timeoutMs: 120000,
  }),
});

export function parseFrontmatter(markdown: string): string {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) {
    throw new Error('Missing markdown frontmatter');
  }

  const match = trimmed.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    throw new Error('Invalid markdown frontmatter format');
  }

  return match[1];
}

export function loadConfig(configPath: string): LlmRebalancerConfig {
  const markdown = readFileAtPath(configPath);
  const frontmatter = parseFrontmatter(markdown);
  const raw = parseYaml(frontmatter) as unknown;

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }

  return parsed.data;
}
