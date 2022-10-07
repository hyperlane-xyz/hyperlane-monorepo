import { ChainName } from '@hyperlane-xyz/sdk';

import { AgentConfig } from '../config';
import { HelmCommand } from '../utils/helm';

export async function runAgentHelmCommand<Chain extends ChainName>(
  action: HelmCommand,
  agentConfig: AgentConfig<Chain>,
) {}
