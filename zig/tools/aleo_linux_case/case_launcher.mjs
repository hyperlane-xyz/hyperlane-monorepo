// Not executed for real cases without separate Root approval.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { install } from './bootstrap.mjs';
const [policyFile,policySha,manifestFile,driverFile]=process.argv.slice(2);
const context=install(policyFile,policySha);
const {parseAleoManifest,runAleoProcess}=await import(pathToFileURL(driverFile).href);
const manifest=parseAleoManifest(JSON.parse(fs.readFileSync(manifestFile,'utf8')));
if(manifest.proxyPorts.join(',')!=='23033,23034')throw new Error('closed declared proxy tuple differs');
for(const p of [...manifest.domains.map(d=>d.port),...manifest.proxyPorts,...manifest.metricsPorts.validators,manifest.metricsPorts.relayer,manifest.metricsPorts.scraper])if(!context.policy.rpc_ports.includes(p))throw new Error('case port missing from policy');
context.check();await runAleoProcess(manifest);context.check();
