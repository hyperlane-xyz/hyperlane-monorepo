import { deleteAgentGCPKeys } from '../../src/agents/gcp';
import { configs } from './agentConfig';

deleteAgentGCPKeys('dev', Object.keys(configs))
  .then(console.log)
  .catch(console.error);
