// Clients
export { SvmProviderClient } from './clients/provider.js';
export { SvmInstructionEnvelope } from './clients/protocol.js';
export { SvmSignerClient } from './clients/signer.js';

// Types
export type {
  SvmInstruction,
  SvmRpc,
  SvmTransaction,
  SvmReceipt,
  AnnotatedSvmTransaction,
  SvmProgramTarget,
  SvmDeployedIsm,
  SvmDeployedHook,
  SvmDeployedIgpHook,
} from './types.js';
export type { SvmSigner } from './signer.js';
export type { SolanaRpcClient } from './rpc.js';

// RPC + Signer
export { createRpc } from './rpc.js';
export { createSigner } from './signer.js';

// Artifact managers
export { SvmIsmArtifactManager } from './ism/ism-artifact-manager.js';
export { SvmHookArtifactManager } from './hook/hook-artifact-manager.js';

// ISM readers/writers
export {
  SvmMessageIdMultisigIsmReader,
  SvmMessageIdMultisigIsmWriter,
} from './ism/multisig-ism.js';
export { SvmTestIsmReader, SvmTestIsmWriter } from './ism/test-ism.js';

// Hook readers/writers
export { SvmIgpHookReader, SvmIgpHookWriter } from './hook/igp-hook.js';
export {
  SvmMerkleTreeHookReader,
  SvmMerkleTreeHookWriter,
} from './hook/merkle-tree-hook.js';

// Deploy
export {
  createDeployProgramPlan,
  createUpgradeProgramPlan,
  executeDeployPlan,
} from './deploy/program-deployer.js';
export type {
  DeployProgramPlan,
  DeployStage,
  DeployProgramPlanArgs,
  UpgradeProgramPlanArgs,
} from './deploy/program-deployer.js';
export { resolveProgram } from './deploy/resolve-program.js';

// Transaction utilities
export { getComputeBudgetInstructions, buildTransactionMessage } from './tx.js';

// PDA derivation
export {
  deriveMultisigIsmAccessControlPda,
  deriveMultisigIsmDomainDataPda,
  deriveTestIsmStoragePda,
  deriveHyperlaneTokenPda,
  deriveAtaPayerPda,
  deriveIgpProgramDataPda,
  deriveIgpAccountPda,
  deriveOverheadIgpAccountPda,
} from './pda.js';

// Account decoders
export {
  decodeHyperlaneTokenAccount,
  decodeIgpProgramDataAccount,
  decodeIgpAccount,
  decodeOverheadIgpAccount,
} from './accounts/token.js';
export {
  decodeMultisigIsmAccessControlAccount,
  decodeMultisigIsmDomainDataAccount,
} from './accounts/multisig-ism-message-id.js';
export { decodeTestIsmStorageAccount } from './accounts/test-ism.js';
