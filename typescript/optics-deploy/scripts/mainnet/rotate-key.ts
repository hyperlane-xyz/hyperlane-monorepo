import { KEY_ROLE_ENUM } from '../../src/agents';
import { AgentAwsKey } from '../../src/agents/aws';
import { agentConfig } from './agentConfig';

async function rotateKey() {
  const key = new AgentAwsKey(
    agentConfig,
    KEY_ROLE_ENUM.UpdaterAttestation,
    'polygon',
  );
  await key.fetch();
  console.log(`Current key: ${key.address}`);
  await key.rotate();
  console.log(`Key was rotated to ${key.address}. `);
}

rotateKey().then(console.log).catch(console.error);
