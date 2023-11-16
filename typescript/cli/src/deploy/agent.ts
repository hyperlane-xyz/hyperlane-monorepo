import { getContextWithSigner } from '../context.js';

export async function runKustosisAgentDeploy({
  key,
  agentConfigPath,
  chainConfigPath,
  skipConfirmation,
}: {
  key: string;
  agentConfigPath: string;
  chainConfigPath: string;
  skipConfirmation: boolean;
}) {
  const { customChains, multiProvider, signer } = getContextWithSigner(
    key,
    chainConfigPath,
  );
  console.log(
    agentConfigPath,
    customChains,
    multiProvider,
    signer,
    skipConfirmation,
  );
}
