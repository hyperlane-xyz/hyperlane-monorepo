// Fixed capability probe only: no SDK, proofs, agents or child-container wait credit.
import fs from 'node:fs';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
const [configPath,configHash]=process.argv.slice(2);
const bytes=fs.readFileSync(configPath);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),configHash);
const c=JSON.parse(bytes);assert.equal(process.version,'v26.12.1');assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.pid,1);
const check=()=>assert.ok(BigInt(process.hrtime.bigint())<BigInt(c.deadline_ns),'Original Docker probe deadline');
check();assert.equal(fs.existsSync('/var/run/docker.sock'),false);assert.equal(fs.existsSync('/run/docker.sock'),false);
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'),c.host_net);assert.equal(fs.readlinkSync('/proc/self/ns/time'),c.host_time);
const routeRows=fs.readFileSync('/proc/net/route','utf8').trim().split('\n').slice(1).filter(Boolean);
assert.ok(routeRows.every(r=>r.trim().split(/\s+/)[0]==='lo'));
const ipv6=fs.readFileSync('/proc/net/ipv6_route','utf8').trim().split('\n').filter(Boolean);
assert.ok(ipv6.every(r=>r.trim().split(/\s+/).at(-1)==='lo'));
fs.mkdirSync(c.task_root,{recursive:true,mode:0o700});fs.writeFileSync(c.task_root+'/owner.json',JSON.stringify({marker:'ziggy-aleo-owned-v1',pid:process.pid,manifest:c.manifest_digest}),{flag:'wx',mode:0o600});
let attempt=0;
function progress(stage){const file=c.task_root+'/probe-progress.json';const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify({schema:1,phase:c.phase,stage,attempt:attempt++,observed_monotonic_ns:process.hrtime.bigint().toString()}),{flag:'w',mode:0o600});fs.renameSync(temp,file)}
progress('starting');
const waits=[];
function docker(args,expectedFailure=false){
 progress('docker.'+args[0]);check();const remaining=Number((BigInt(c.deadline_ns)-process.hrtime.bigint())/1000000n);
 const argv=['-I',c.shim,'--host','unix://'+c.socket,...args];
 const result=cp.spawnSync(c.python,argv,{env:{PATH:'/usr/bin:/bin',HOME:c.task_root,TMPDIR:c.task_root,LC_ALL:'C.UTF-8',DOCKER_HOST:'unix://'+c.socket,DOCKER_CONFIG:c.task_root+'/docker-cli'},timeout:Math.max(1,Math.min(15000,remaining)),maxBuffer:1024*1024,encoding:'utf8'});
 waits.push({phase:args[0],pid:result.pid,actual_spawnSync_return:true,status:result.status,signal:result.signal,output_sha256:crypto.createHash('sha256').update(result.stdout??'').update(result.stderr??'').digest('hex')});
 assert.equal(result.signal,null);assert.equal(result.error,undefined);check();
 if(expectedFailure){assert.notEqual(result.status,0);return '';}
 assert.equal(result.status,0);return result.stdout.trim();
}
async function height(){
 progress('native.height');check();return await new Promise((resolve,reject)=>{
 const request=http.get('http://127.0.0.1:23030/testnet/block/height/latest',response=>{let size=0,body='';response.on('data',v=>{size+=v.length;if(size>128){request.destroy(new Error('bounded height'));return;}body+=v});response.on('end',()=>{try{assert.equal(response.statusCode,200);const v=JSON.parse(body);assert.ok(Number.isSafeInteger(v)&&v>=0);resolve(v);}catch(e){reject(e)}})});
 const timer=setTimeout(()=>request.destroy(new Error('whole readonly height timeout')),1000);request.once('close',()=>clearTimeout(timer));request.once('error',reject);
 });
}
const selected=c.selected;const command=['run','--detach','--pull=never','--name',selected.name];
if(selected.kind==='postgres')command.push('--publish','127.0.0.1::5432');else command.push('--publish','127.0.0.1:23030:3030','--platform','linux/amd64');
for(const value of selected.create_body.Env)command.push('--env',value);
command.push(selected.reference);if(selected.kind!=='postgres')command.push(...selected.create_body.Cmd);
docker(['info','--format','{{json .}}']);docker(['image','inspect',selected.reference]);
let bridge=null;const bridgeSockets=new Set();
if(selected.kind!=='postgres'&&!c.inject_lost_create_reply){
 bridge=net.createServer(client=>{if(bridgeSockets.size>=8){client.destroy();return;}const target=net.connect(c.socket.replace('/docker.sock','/23030.sock'));for(const socket of [client,target]){bridgeSockets.add(socket);socket.setTimeout(1500,()=>socket.destroy());socket.on('error',()=>{client.destroy();target.destroy()});socket.on('close',()=>bridgeSockets.delete(socket));}client.pipe(target);target.pipe(client);});
 await new Promise((resolve,reject)=>{bridge.once('error',reject);bridge.listen(23030,'127.0.0.1',resolve)});
}
let cid=null,ready=null;
if(c.inject_lost_create_reply)docker(command,true);
else{
 cid=docker(command);assert.match(cid,/^[0-9a-f]{64}$/);
 while(true){check();try{if(selected.kind==='postgres'){docker(['exec',cid,'pg_isready','-U','ziggy','-d','ziggy']);ready={postgres:true};}else{ready={height:await height()};}break;}catch{await new Promise(r=>setTimeout(r,250));}}
 docker(['exec',cid,'df','-Pk','/']);docker(['stop','--time','10',cid]);
}
if(bridge){await Promise.all([...bridgeSockets].map(socket=>new Promise(resolve=>{socket.once('close',resolve);socket.destroy()})));await new Promise(resolve=>bridge.close(resolve));assert.equal(bridgeSockets.size,0);}
progress('finished');check();console.log(JSON.stringify({schema:1,phase:c.phase,passed:true,node_version:process.version,namespace_pid:process.pid,private_net_namespace:fs.readlinkSync('/proc/self/ns/net'),no_raw_docker_socket:true,no_outside_namespace_routes:true,external_TCP_attempted:false,selected_kind:selected.kind,cid,actual_readonly_API:ready,controlled_lost_create_reply:c.inject_lost_create_reply,shim_parent_waits:waits,container_child_wait_credit:false,SDK_or_proof_or_agent_execution:false}));
