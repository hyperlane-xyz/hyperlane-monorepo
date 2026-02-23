import type { Logger } from 'pino';

import { PlannerOutputSchema } from '../planner/schema.js';
import type {
  ActionExecutionResult,
  InflightMessage,
  LlmRebalancerConfig,
  Observation,
  PlannerOutput,
  SkillProfile,
} from '../types.js';
import type { AgentRuntime } from '../runtime/types.js';
import { StateStore } from '../state/StateStore.js';
import { SkillActionExecutor } from '../execution/SkillActionExecutor.js';

const PLANNER_MAX_RETRIES = 3;

export class SkillFirstLoop {
  private readonly actionExecutor: SkillActionExecutor;

  constructor(
    private readonly config: LlmRebalancerConfig,
    private readonly profile: SkillProfile,
    private readonly runtime: AgentRuntime,
    private readonly stateStore: StateStore,
    private readonly logger: Logger,
  ) {
    this.actionExecutor = new SkillActionExecutor(runtime, profile);
  }

  async runCycle(): Promise<void> {
    const runId = await this.stateStore.startRun(this.config);
    try {
      await this.stateStore.appendRunLog(runId, 'start', 'run_started', {
        warpRouteIds: this.config.warpRouteIds,
      });

      const observation = await this.observe(runId);
      await this.stateStore.saveObservation(runId, observation);

      const inflight = await this.getInflight(runId);
      await this.stateStore.replaceInflight(runId, inflight);

      // Required ordering: read persisted context BEFORE planning
      const priorContext = await this.stateStore.getPriorContext();

      const planner = await this.plan(runId, {
        config: this.config,
        observation,
        inflight,
        priorContext,
      });

      let executionError: Error | undefined;
      for (const action of planner.actions) {
        const { actionId } = await this.stateStore.upsertPlannedAction(
          runId,
          action,
        );

        let result: ActionExecutionResult;
        try {
          result = await this.actionExecutor.execute(runId, action);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result = {
            actionFingerprint: action.actionFingerprint,
            success: false,
            error: message,
          };
          if (!executionError) {
            executionError = new Error(message);
          }
        }
        await this.stateStore.recordActionAttempt(actionId, result);
      }

      if (executionError) {
        throw executionError;
      }

      const reconciliation = await this.reconcile(runId, {
        plannerOutput: planner,
        observation,
        inflight,
        priorContext,
      });
      await this.stateStore.saveReconciliation(runId, reconciliation);

      if (Array.isArray((reconciliation as any).deliveredActionFingerprints)) {
        for (const actionFingerprint of (reconciliation as any)
          .deliveredActionFingerprints as string[]) {
          await this.stateStore.markReconciled(actionFingerprint);
        }
      }

      await this.stateStore.appendRunLog(runId, 'finish', 'run_finished');
      await this.stateStore.finishRun(runId, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.stateStore.appendRunLog(runId, 'error', 'run_failed', {
        error: message,
      });
      await this.stateStore.finishRun(runId, 'failed', message);
      this.logger.error(
        { err: error, runId, message },
        'Skill-first cycle failed',
      );
      throw new Error(`run ${runId} failed: ${message}`);
    }
  }

  private async observe(runId: string): Promise<Observation> {
    const result = await this.runtime.invokeSkill({
      runId,
      skillPath: this.profile.observe,
      input: {
        warpRouteIds: this.config.warpRouteIds,
        registryUri: this.config.registryUri,
      },
    });

    const output = result.output as Observation;
    if (!output.observedAt) {
      output.observedAt = Date.now();
    }
    if (!Array.isArray(output.routerBalances)) {
      throw new Error('observe skill output missing routerBalances[]');
    }
    return output;
  }

  private async getInflight(runId: string): Promise<InflightMessage[]> {
    const skillPath = this.getInflightSkillPath();
    const result = await this.runtime.invokeSkill({
      runId,
      skillPath,
      input: {
        inflightMode: this.config.inflightMode,
        warpRouteIds: this.config.warpRouteIds,
      },
    });

    const output = result.output as { messages?: InflightMessage[] };
    return output.messages ?? [];
  }

  private getInflightSkillPath(): string {
    switch (this.config.inflightMode) {
      case 'rpc':
        return this.profile.inflightRpc;
      case 'explorer':
        return this.profile.inflightExplorer;
      case 'hybrid':
      default:
        return this.profile.inflightHybrid;
    }
  }

  private async plan(
    runId: string,
    context: unknown,
  ): Promise<PlannerOutput> {
    let lastError: Error | undefined;
    const plannerContext = this.sanitizePlannerContext(context);

    for (let attempt = 1; attempt <= PLANNER_MAX_RETRIES; attempt++) {
      try {
        const result = await this.runtime.invokeSkill({
          runId,
          skillPath: this.profile.globalNetting,
          input: {
            attempt,
            provider: this.config.llmProvider,
            model: this.config.llmModel,
            context: plannerContext,
          },
        });

        const parsed = PlannerOutputSchema.safeParse(result.output);
        if (!parsed.success) {
          throw new Error(
            `Invalid planner output: ${parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')}`,
          );
        }

        await this.stateStore.recordPlannerTranscript(
          runId,
          this.config.llmProvider,
          this.config.llmModel,
          JSON.stringify(plannerContext),
          parsed.data,
        );

        return parsed.data;
      } catch (error) {
        lastError = error as Error;
        await this.stateStore.appendRunLog(runId, 'planning', 'plan_retry', {
          attempt,
          error: lastError.message,
        });
      }
    }

    this.logger.error({ err: lastError }, 'Planner failed after retries');
    throw lastError ?? new Error('Planner failed');
  }

  private sanitizePlannerContext(context: unknown): unknown {
    const typed = context as {
      observation?: unknown;
      inflight?: unknown[];
      priorContext?: {
        openIntents?: unknown[];
        openActions?: unknown[];
        recentReconciliations?: unknown[];
        recentPlannerTranscripts?: Array<{
          provider?: string;
          model?: string;
          createdAt?: number;
        }>;
      };
    };

    const priorContext = typed?.priorContext ?? {};
    return {
      observation: typed?.observation ?? null,
      inflight: Array.isArray(typed?.inflight) ? typed.inflight.slice(0, 200) : [],
      priorContext: {
        openIntents: Array.isArray(priorContext.openIntents)
          ? priorContext.openIntents.slice(0, 50)
          : [],
        openActions: Array.isArray(priorContext.openActions)
          ? priorContext.openActions.slice(0, 50)
          : [],
        recentReconciliations: Array.isArray(priorContext.recentReconciliations)
          ? priorContext.recentReconciliations.slice(0, 20)
          : [],
        recentPlannerTranscripts: Array.isArray(
          priorContext.recentPlannerTranscripts,
        )
          ? priorContext.recentPlannerTranscripts.slice(0, 10).map((t) => ({
              provider: t?.provider,
              model: t?.model,
              createdAt: t?.createdAt,
            }))
          : [],
      },
    };
  }

  private async reconcile(runId: string, input: unknown): Promise<unknown> {
    const result = await this.runtime.invokeSkill({
      runId,
      skillPath: this.profile.reconcile,
      input,
    });
    await this.stateStore.appendRunLog(runId, 'reconcile', 'reconcile_complete');
    return result.output;
  }
}
