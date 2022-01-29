import { deleteAgentGCPKeys } from '../../src/agents';

deleteAgentGCPKeys('dev').then(console.log).catch(console.error);
