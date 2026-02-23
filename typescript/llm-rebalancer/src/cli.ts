#!/usr/bin/env node
import { resolve } from 'node:path';

import { pino } from 'pino';

import { loadConfig } from './config/schema.js';
import { SkillFirstLoop } from './loop/SkillFirstLoop.js';
import { PiOpenClawRuntime } from './runtime/PiOpenClawRuntime.js';
import { SkillRegistry } from './skills/SkillRegistry.js';
import { createSqlAdapter } from './sql/factory.js';
import { StateStore } from './state/StateStore.js';
import { LlmRebalancerService } from './service.js';

async function main(): Promise<void> {
  const configPath = process.env.LLM_REBALANCER_CONFIG_FILE;
  if (!configPath) {
    throw new Error('LLM_REBALANCER_CONFIG_FILE is required');
  }

  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
  });

  const resolvedConfigPath = resolve(configPath);
  const config = loadConfig(resolvedConfigPath);

  const skillRegistry = new SkillRegistry(config.skills.profile, resolvedConfigPath);
  const profile = await skillRegistry.resolveProfile();

  const sql = await createSqlAdapter(config.db.url);
  const stateStore = new StateStore(sql);
  await stateStore.initialize();

  const runtime = new PiOpenClawRuntime(config.runtime);

  const loop = new SkillFirstLoop(
    config,
    profile,
    runtime,
    stateStore,
    logger.child({ module: 'skill-first-loop' }),
  );

  const service = new LlmRebalancerService(
    loop,
    config.intervalMs,
    logger.child({ module: 'llm-rebalancer-service' }),
  );

  process.on('SIGINT', async () => {
    await service.stop();
    await stateStore.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await service.stop();
    await stateStore.close();
    process.exit(0);
  });

  await service.start();
  logger.info({ configPath: resolvedConfigPath }, 'LLM rebalancer started');
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
