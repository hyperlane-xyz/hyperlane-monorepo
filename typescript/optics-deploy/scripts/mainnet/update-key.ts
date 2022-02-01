import { KEY_ROLE_ENUM } from '../../src/agents';
import { AgentAwsKey } from '../../src/agents/aws';
import { agentConfig } from './agentConfig';

async function updateKey() {
  const key = new AgentAwsKey(
    agentConfig,
    KEY_ROLE_ENUM.UpdaterAttestation,
    'polygon',
  );
  await key.fetch();
  console.log(`Current key: ${key.address}`);
  const newAddress = await key.update();
  console.log(
    `Create new key with address: ${newAddress}. Run rotate-key script to actually rotate the key via the alias.`,
  );
}

updateKey().then(console.log).catch(console.error);
