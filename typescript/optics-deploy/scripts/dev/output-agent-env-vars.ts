import { writeFile } from "fs/promises";
import { outputAgentEnvVars } from "../../src/agents"
import { agentConfig, configs } from './agentConfig';

async function main() {
  const args = process.argv.slice(2)
  if (args.length != 3) {
    throw new Error("unknown arguments, usage: cmd network role filePath")
  }
  // @ts-ignore
  const envVars = await outputAgentEnvVars(args[0], args[1], agentConfig, configs)

  await writeFile(args[2], envVars.join('\n'))
}

main().then(console.log).catch(console.error)