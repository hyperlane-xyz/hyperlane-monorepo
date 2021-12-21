import { runKeymasterHelmCommand } from "../../src/agents"
import { agentConfig, configs } from './agentConfig';

async function main() {
return  runKeymasterHelmCommand('install', agentConfig, configs)
}

main().then(console.log).catch(console.error)