import { KEY_ROLE_ENUM, rotateGCPKey } from "../../src/agents"

rotateGCPKey('dev', KEY_ROLE_ENUM.UpdaterAttestation, 'kovan').then(console.log).catch(console.error)