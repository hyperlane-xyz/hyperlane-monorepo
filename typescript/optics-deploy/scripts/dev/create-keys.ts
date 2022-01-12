import { createAgentGCPKeys } from "../../src/agents"

createAgentGCPKeys('dev').then(console.log).catch(console.error)