import { deleteAgentGCPKeys } from '../../src/agents/gcp';
import { chains } from '../../config/environments/dev/chains';

deleteAgentGCPKeys(
  'dev',
  chains.map((c) => c.name),
)
  .then(console.log)
  .catch(console.error);
