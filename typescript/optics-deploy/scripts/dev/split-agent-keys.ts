import { splitAgentGCPKeys } from "../../src/agents"
import { configs } from "./agentConfig"

splitAgentGCPKeys('dev', Object.keys(configs)).then(console.log).catch(console.error)