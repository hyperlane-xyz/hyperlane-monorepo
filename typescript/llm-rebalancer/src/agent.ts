/**
 * Pi agent session creation and cycle execution.
 *
 * RebalancerAgent holds a persistent Pi session across cycles.
 * The agent accumulates conversation history, so skill discovery,
 * command templates, and chain metadata carry over between cycles.
 *
 * Context store (save_context) is still used for crash recovery.
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

import type { RebalancerAgentEvent } from './events.js';

const logger = pino({ name: 'llm-rebalancer-agent', level: 'info' });

export interface CreateSessionOptions {
  workDir: string;
  provider?: string;
  model?: string;
  agentsPrompt: string;
  customTools?: ToolDefinition<any>[];
  onEvent?: (e: RebalancerAgentEvent) => void;
  /** Max time (ms) for a single cycle before aborting (default: 120000) */
  cycleTimeoutMs?: number;
  /** Max tool calls per cycle before aborting (default: 25) */
  maxToolCallsPerCycle?: number;
}

/**
 * Create a Pi agent session.
 */
export async function createRebalancerSession(
  opts: CreateSessionOptions,
): Promise<AgentSession> {
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  const provider = opts.provider ?? 'opencode';
  const modelId = opts.model ?? 'gpt-5.1-codex-mini';
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Model not found: ${provider}/${modelId}`);
  }

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

const CYCLE_PROMPT = `New cycle. Execute your loop — do NOT narrate or explain. Call tools immediately, no preamble.
ALWAYS start with get_balances — it returns BOTH balances AND pending user transfers.
If pendingUserTransfers exist: check the DESTINATION ASSET has sufficient collateral on the destination chain. If not, act to supply it.
If balanced AND no pending transfers: save_context with status=balanced.
If imbalanced OR pending transfers blocked: rebalance/supply, then save_context with status=pending.
Minimal text output. When you need multiple independent checks (e.g. check_hyperlane_delivery + get_balances), call them in parallel.`;

export interface CycleResult {
  status: 'balanced' | 'pending' | 'unknown';
}

const defaultEmitter = (e: RebalancerAgentEvent): void => {
  if (e.type === 'error') logger.error({ error: e.error }, 'Agent error');
  else if (e.type === 'tool_call')
    logger.info({ tool: e.tool, args: e.args }, 'Tool call');
  else if (e.type === 'tool_result')
    logger.info({ tool: e.tool }, 'Tool result');
  else if (e.type === 'text') process.stdout.write(e.text);
  else if (e.type === 'cycle_start') logger.info('Cycle started');
  else if (e.type === 'cycle_end')
    logger.info({ status: e.status }, 'Cycle ended');
};

/**
 * Persistent rebalancer agent that reuses a single Pi session across cycles.
 * Conversation history accumulates, so the agent remembers skills, templates, etc.
 */
export class RebalancerAgent {
  private session: AgentSession;
  private unsubscribe: () => void;
  private cycleStatus: CycleResult['status'] = 'unknown';
  private emit: (e: RebalancerAgentEvent) => void;
  private cycleTimeoutMs: number;
  private maxToolCallsPerCycle: number;
  private toolCallCount = 0;

  private constructor(
    session: AgentSession,
    onEvent?: (e: RebalancerAgentEvent) => void,
    cycleTimeoutMs?: number,
    maxToolCallsPerCycle?: number,
  ) {
    this.session = session;
    this.emit = onEvent ?? defaultEmitter;
    this.cycleTimeoutMs = cycleTimeoutMs ?? 120_000;
    this.maxToolCallsPerCycle = maxToolCallsPerCycle ?? 25;

    // Subscribe once — stays active across all cycles
    this.unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case 'message_update':
          if (event.assistantMessageEvent.type === 'text_delta') {
            this.emit({
              type: 'text',
              timestamp: Date.now(),
              text: event.assistantMessageEvent.delta,
            });
          }
          break;
        case 'tool_execution_start':
          this.toolCallCount++;
          this.emit({
            type: 'tool_call',
            timestamp: Date.now(),
            tool: event.toolName,
            args: event.args,
          });
          if (event.toolName === 'save_context') {
            const status = event.args?.status;
            if (status === 'balanced' || status === 'pending') {
              this.cycleStatus = status;
            }
          }
          // Guardrail: abort if too many tool calls
          if (this.toolCallCount >= this.maxToolCallsPerCycle) {
            logger.warn(
              { count: this.toolCallCount, max: this.maxToolCallsPerCycle },
              'Max tool calls reached, aborting cycle',
            );
            this.session.abort().catch(() => {});
          }
          break;
        case 'tool_execution_end':
          this.emit({
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
  }

  static async create(opts: CreateSessionOptions): Promise<RebalancerAgent> {
    const session = await createRebalancerSession(opts);
    return new RebalancerAgent(
      session,
      opts.onEvent,
      opts.cycleTimeoutMs,
      opts.maxToolCallsPerCycle,
    );
  }

  /**
   * Run a single rebalancer cycle on the persistent session.
   * The session accumulates history — no skill re-discovery needed after first cycle.
   * Protected by timeout and max tool call guardrails.
   */
  async runCycle(): Promise<CycleResult> {
    this.cycleStatus = 'unknown';
    this.toolCallCount = 0;
    this.emit({ type: 'cycle_start', timestamp: Date.now() });

    logger.info('Starting rebalancer cycle');

    // Timeout guardrail
    const timeoutId = setTimeout(() => {
      logger.warn(
        { timeoutMs: this.cycleTimeoutMs },
        'Cycle timeout reached, aborting',
      );
      this.session.abort().catch(() => {});
    }, this.cycleTimeoutMs);

    try {
      await this.session.prompt(CYCLE_PROMPT);
    } finally {
      clearTimeout(timeoutId);
    }

    logger.info({ status: this.cycleStatus }, 'Rebalancer cycle completed');

    this.emit({
      type: 'cycle_end',
      timestamp: Date.now(),
      status: this.cycleStatus === 'unknown' ? 'pending' : this.cycleStatus,
    });

    return { status: this.cycleStatus };
  }

  dispose(): void {
    this.unsubscribe();
    this.session.dispose();
  }
}

/**
 * Run a single rebalancer cycle using a fresh Pi session (legacy API).
 * For session reuse, prefer RebalancerAgent.create() + agent.runCycle().
 */
export async function runRebalancerCycle(
  opts: CreateSessionOptions,
): Promise<CycleResult> {
  const agent = await RebalancerAgent.create(opts);
  try {
    return await agent.runCycle();
  } catch (error) {
    logger.error({ error }, 'Rebalancer cycle failed');
    opts.onEvent?.({
      type: 'error',
      timestamp: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    agent.dispose();
  }
}
