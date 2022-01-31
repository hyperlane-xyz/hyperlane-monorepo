import { KEY_ROLE_ENUM } from '../../src/agents';
import { rotateGCPKey } from '../../src/agents/gcp';

rotateGCPKey('dev', KEY_ROLE_ENUM.UpdaterAttestation, 'kovan')
  .then(console.log)
  .catch(console.error);
