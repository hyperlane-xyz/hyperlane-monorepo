import * as alfajores from '../../config/testnets/alfajores';
import * as kovan from '../../config/testnets/kovan';
import * as gorli from '../../config/testnets/gorli';
import * as fuji from '../../config/testnets/fuji';
import * as mumbai from '../../config/testnets/mumbai';
import { updateProviderDomain } from '../../src/provider';
import { configPath } from './agentConfig';
import { makeAllConfigs } from '../../src/config';
import { addAgentGCPAddresses } from '../../src/agents';

async function updateProviderDomains() {
  updateProviderDomain('dev', configPath, await Promise.all([
    makeAllConfigs(alfajores, (_) => addAgentGCPAddresses('dev', _.devConfig)),
    makeAllConfigs(kovan, (_) => addAgentGCPAddresses('dev', _.devConfig)),
    makeAllConfigs(gorli, (_) => addAgentGCPAddresses('dev', _.devConfig)),
    makeAllConfigs(fuji, (_) => addAgentGCPAddresses('dev', _.devConfig)),
    makeAllConfigs(mumbai, (_) => addAgentGCPAddresses('dev', _.devConfig)),
  ]));
}

updateProviderDomains().then(console.log).catch(console.error)