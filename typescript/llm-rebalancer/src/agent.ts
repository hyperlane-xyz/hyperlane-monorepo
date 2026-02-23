/**
 * Pi agent session creation and cycle execution.
 *
 * Creates a fresh Pi session per rebalancer cycle (stateless — SQLite provides continuity).
 */

import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import type { AgentSession } from '@mariozechner/pi-coding-agent';
import { pino } from 'pino';
import { assert } from 'console';

const logger = pino({ name: 'llm-rebalancer-agent', level: 'info' });

export interface CreateSessionOptions {
  workDir: string;
  provider?: string;
  model?: string;
  agentsPrompt: string;
}

/**
 * Create a fresh Pi agent session for a single rebalancer cycle.
 */
export async function createRebalancerSession(
  opts: CreateSessionOptions,
): Promise<AgentSession> {
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  const provider = opts.provider ?? 'anthropic';
  const modelId = opts.model ?? 'claude-sonnet-4-5';
  const model = modelRegistry.find(provider, modelId);
  assert(model, `Model not found: ${provider}/${modelId}`);

  // Load skills from the working directory's .pi/skills/
  const resourceLoader = new DefaultResourceLoader({
    agentsFilesOverride: (current) => ({
      agentsFiles: [
        ...current.agentsFiles,
        {
          path: `${opts.workDir}/AGENTS.md`,
          content: opts.agentsPrompt,
        },
      ],
    }),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: opts.workDir,
    model,
    tools: createCodingTools(opts.workDir),
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
    }),
    authStorage,
    modelRegistry,
    resourceLoader,
  });

  return session;
}

const CYCLE_PROMPT = `New rebalancing cycle. Follow your workflow:
1. Check the action log for pending actions and verify their delivery status.
2. Check current balances on all chains.
3. Calculate surplus/deficit per chain (accounting for inflight amounts).
4. If any chain is outside its tolerance band, execute the appropriate rebalance action.
5. Update the action log with any new actions taken.

Be concise. Execute actions, don't just describe them.`;

/**
 * Run a single rebalancer cycle using a fresh Pi session.
 */
export async function runRebalancerCycle(
  opts: CreateSessionOptions,
): Promise<void> {
  let session: AgentSession | undefined;
  try {
    session = await createRebalancerSession(opts);

    logger.info('Starting rebalancer cycle');

    await session.prompt(CYCLE_PROMPT);

    logger.info('Rebalancer cycle completed');
  } catch (error) {
    logger.error({ error }, 'Rebalancer cycle failed');
    throw error;
  } finally {
    session?.dispose();
  }
}
