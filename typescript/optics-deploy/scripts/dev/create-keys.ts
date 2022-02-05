import { createAgentGCPKeys } from '../../src/agents/gcp';
import { chains } from '../../config/environments/dev/chains';

createAgentGCPKeys('dev', chains.map((c) => c.name))
  .then(console.log)
  .catch(console.error);
