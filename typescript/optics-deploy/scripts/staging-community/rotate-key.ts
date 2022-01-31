import { KEY_ROLE_ENUM } from "../../src/agents";
import { AwsKey } from "../../src/agents/aws";
import { agentConfig } from "./agentConfig";

async function main() {
  const key = new AwsKey(agentConfig, KEY_ROLE_ENUM.ProcessorSigner, 'fantomtest')
  await key.fetchFromAws()
  console.log(`Current key: ${key.address()}`)
  await key.rotate()
  console.log(`Key was rotated to ${key.address()}. `)
}

main().then(console.log).catch(console.error)
