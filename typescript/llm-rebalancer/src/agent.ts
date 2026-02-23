/**
 * Pi agent session creation and cycle execution.
 *
 * Creates a fresh Pi session per rebalancer cycle.
 * Context continuity via ContextStore (replaces SQLite).
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
import type {
  AgentSession,
  ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { pino } from 'pino';
import { assert } from 'console';

import type { RebalancerAgentEvent } from './events.js';

const logger = pino({ name: 'llm-rebalancer-agent', level: 'info' });

export interface CreateSessionOptions {
  workDir: string;
  provider?: string;
  model?: string;
  agentsPrompt: string;
  customTools?: ToolDefinition<any>[];
  onEvent?: (e: RebalancerAgentEvent) => void;
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
    customTools: opts.customTools,
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

const CYCLE_PROMPT = `New rebalancing cycle. Follow your invocation loop:
1. Read previous context (if available — it's in your system prompt).
2. Check pending actions — verify delivery of any inflight transfers.
3. Check current balances using get_balances.
4. Assess surplus/deficit (subtract inflight amounts).
5. Execute rebalances if needed (use appropriate skill).
6. ALWAYS call save_context at the end with your status and summary.

Be concise. Execute actions, don't just describe them.`;

export interface CycleResult {
  status: 'balanced' | 'pending' | 'unknown';
}

/**
 * Run a single rebalancer cycle using a fresh Pi session.
 * Returns cycle status extracted from save_context tool call.
 */
export async function runRebalancerCycle(
  opts: CreateSessionOptions,
): Promise<CycleResult> {
  let session: AgentSession | undefined;
  let cycleStatus: CycleResult['status'] = 'unknown';

  try {
    session = await createRebalancerSession(opts);

    const emit =
      opts.onEvent ??
      ((e: RebalancerAgentEvent) => {
        if (e.type === 'error') logger.error({ error: e.error }, 'Agent error');
        else if (e.type === 'tool_call')
          logger.info({ tool: e.tool, args: e.args }, 'Tool call');
        else if (e.type === 'tool_result')
          logger.info({ tool: e.tool }, 'Tool result');
      });

    emit({ type: 'cycle_start', timestamp: Date.now() });

    // Subscribe to Pi session events and map to our event types
    session.subscribe((event) => {
      switch (event.type) {
        case 'message_update':
          if (event.assistantMessageEvent.type === 'text_delta') {
            emit({
              type: 'text',
              timestamp: Date.now(),
              text: event.assistantMessageEvent.delta,
            });
          }
          break;
        case 'tool_execution_start':
          emit({
            type: 'tool_call',
            timestamp: Date.now(),
            tool: event.toolName,
            args: event.args,
          });
          // Extract status from save_context args directly
          if (event.toolName === 'save_context') {
            const status = event.args?.status;
            if (status === 'balanced' || status === 'pending') {
              cycleStatus = status;
            }
          }
          break;
        case 'tool_execution_end':
          emit({
            type: 'tool_result',
            timestamp: Date.now(),
            tool: event.toolName,
            result:
              typeof event.result === 'string'
                ? event.result
                : JSON.stringify(event.result),
          });
          break;
      }
    });

    logger.info('Starting rebalancer cycle');
    await session.prompt(CYCLE_PROMPT);
    logger.info({ status: cycleStatus }, 'Rebalancer cycle completed');

    emit({
      type: 'cycle_end',
      timestamp: Date.now(),
      status: cycleStatus === 'unknown' ? 'pending' : cycleStatus,
    });
  } catch (error) {
    logger.error({ error }, 'Rebalancer cycle failed');
    opts.onEvent?.({
      type: 'error',
      timestamp: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    session?.dispose();
  }

  return { status: cycleStatus };
}
