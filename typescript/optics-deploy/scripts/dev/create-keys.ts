import { createAgentGCPKeys } from "../../src/agents"
import { configs } from "./agentConfig"

createAgentGCPKeys('dev', Object.keys(configs)).then(console.log).catch(console.error)