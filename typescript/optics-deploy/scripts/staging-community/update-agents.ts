import { runHelmCommand } from "../../src/agents"
import { agentConfig, configs } from "./agentConfig"

async function deploy() {
  for (const config in configs) {
    await runHelmCommand('upgrade', agentConfig, configs[config], configs), { depth: null }
  }
}

deploy().then(console.log).catch(console.error)