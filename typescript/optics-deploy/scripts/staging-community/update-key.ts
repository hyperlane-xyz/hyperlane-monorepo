import { KEY_ROLE_ENUM } from "../../src/agents";
import { AwsKey } from "../../src/agents/aws";
import { agentConfig } from "./agentConfig";

async function main() {
  const key = new AwsKey(agentConfig, KEY_ROLE_ENUM.ProcessorSigner, 'fantomtest')
  await key.fetchFromAws()
  console.log(`Current key: ${key.address()}`)
  const newAddress = await key.update()
  console.log(`Create new key with address: ${newAddress}. Run rotate-key script to actually rotate the key via the alias.`)
}

main().then(console.log).catch(console.error)