export type ExecutionPath = 'movableCollateral' | 'inventory';
export type InflightMode = 'rpc' | 'explorer' | 'hybrid';
export type InventoryBridge = 'lifi';

export type LlmProvider = 'codex' | 'claude';

export interface SkillProfile {
  observe: string;
  inflightRpc: string;
  inflightExplorer: string;
  inflightHybrid: string;
  executeMovable: string;
  executeInventoryLifi: string;
  reconcile: string;
  globalNetting: string;
}

export interface RuntimeConfig {
  type: 'pi-openclaw';
  command: string;
  // Use placeholders {skillPath} and {inputPath}
  argsTemplate: string[];
  timeoutMs: number;
}

export interface DbConfig {
  url: string;
}

export interface LlmRebalancerConfig {
  warpRouteIds: string[];
  registryUri: string;
  llmProvider: LlmProvider;
  llmModel: string;
  intervalMs: number;
  db: DbConfig;
  inflightMode: InflightMode;
  skills: { profile: SkillProfile };
  signerEnv: string;
  inventorySignerEnv?: string;
  executionPaths: ExecutionPath[];
  inventoryBridge: InventoryBridge;
  runtime: RuntimeConfig;
}

export interface RouterBalance {
  routeId: string;
  chain: string;
  symbol: string;
  router: string;
  collateral: string;
  inventory?: string;
}

export interface Observation {
  observedAt: number;
  routerBalances: RouterBalance[];
  metadata?: Record<string, unknown>;
}

export interface InflightMessage {
  messageId: string;
  type: 'user' | 'self';
  routeId: string;
  origin: string;
  destination: string;
  sourceRouter: string;
  destinationRouter: string;
  amount: string;
  status: 'in_progress' | 'delivered';
  source: InflightMode;
  txHash?: string;
}

export interface PlannedAction {
  actionFingerprint: string;
  executionType: ExecutionPath;
  routeId: string;
  origin: string;
  destination: string;
  sourceRouter: string;
  destinationRouter: string;
  amount: string;
  reason?: string;
  bridge?: InventoryBridge;
}

export interface PlannerOutput {
  summary: string;
  actions: PlannedAction[];
}

export interface ActionExecutionResult {
  actionFingerprint: string;
  success: boolean;
  txHash?: string;
  messageId?: string;
  error?: string;
}

export interface PriorContext {
  openIntents: unknown[];
  openActions: unknown[];
  recentReconciliations: unknown[];
  recentPlannerTranscripts: unknown[];
}

export interface LoopContext {
  config: LlmRebalancerConfig;
  observation: Observation;
  inflight: InflightMessage[];
  priorContext: PriorContext;
}
