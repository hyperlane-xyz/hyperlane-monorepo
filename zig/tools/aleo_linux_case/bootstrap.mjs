// Private Aleo fixture transport guard. No SDK import, key construction or proving.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, urlToHttpOptions } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import threads from 'node:worker_threads';
const SELF = fs.realpathSync(fileURLToPath(import.meta.url));
const SYMBOL = Symbol.for('ziggy.aleo.closed-cache.v1');
const GRANT_SHA = '50edaa4a75ce4657d3c163e5bf644f1f'+'b90e101d5c879acb06f84e3028e87742';
const XHR_PREFIX = "'use strict';var http = require('http'), https = require('https'), fs = require('fs');";
function requireValue(v, message) { if (!v) throw new Error(message); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function verify(pin, maximum = 128 * 1024 ** 2) {
  requireValue(pin && typeof pin.path === 'string' && path.isAbsolute(pin.path) && /^[0-9a-f]{64}$/.test(pin.sha256), 'invalid pin');
  const st = fs.lstatSync(pin.path);
  requireValue(st.isFile() && !st.isSymbolicLink() && fs.realpathSync(pin.path) === pin.path && st.size === pin.bytes && st.size <= maximum, 'pin type/size/path differs');
  requireValue(sha(fs.readFileSync(pin.path)) === pin.sha256, 'pin SHA differs');
}
function privateDir(root, sub) {
  const p = path.join(root, sub);
  requireValue(p.startsWith(root + path.sep), 'private path escape');
  let current=root;
  for (const piece of sub.split('/')) {
    requireValue(/^[a-zA-Z0-9_-]+$/.test(piece),'unsafe private component');
    current=path.join(current,piece);
    try { const st=fs.lstatSync(current);requireValue(st.isDirectory() && !st.isSymbolicLink(),'private parent symlink'); }
    catch(error) { if(error.code !== 'ENOENT')throw error;fs.mkdirSync(current,{mode:0o700}); }
    requireValue(fs.realpathSync(current) === current,'private directory symlink');
  }
  return p;
}
export function install(policyPath, expectedSha) {
  const previous = globalThis[SYMBOL];
  if (previous) { requireValue(previous.policySha === expectedSha, 'conflicting bootstrap'); return previous; }
  requireValue(fs.realpathSync(policyPath) === policyPath && sha(fs.readFileSync(policyPath)) === expectedSha, 'policy changed');
  const policy = JSON.parse(fs.readFileSync(policyPath,'utf8'));
  requireValue(policy.schema === 1 && fs.realpathSync(policy.root) === policy.root && fs.statSync(policy.root).isDirectory() && (fs.statSync(policy.root).mode & 0o077) === 0, 'private root required');
  requireValue(policy.grant.sha256 === GRANT_SHA, 'unaccepted alias grant'); verify(policy.grant);
  for (const pin of policy.code_pins) verify(pin);
  verify(policy.node, 160 * 1024 ** 2); verify(policy.diagnostic_ps); requireValue(fs.realpathSync(process.execPath) === policy.node.path, 'Node differs');
  const grant = JSON.parse(fs.readFileSync(policy.grant.path,'utf8'));
  const expected = new Map(grant.assets.map(row => [row.url,row.file]));
  requireValue(expected.size === 17 && Array.isArray(policy.assets) && policy.assets.length === 17, 'exact17 aliases required');
  const assets = new Map();
  for (const row of policy.assets) {
    const approved = expected.get(row.url);
    requireValue(approved && approved.sha256 === row.file.sha256 && approved.bytes === row.file.bytes && !assets.has(row.url), 'foreign asset/altered checksum');
    requireValue(fs.realpathSync(row.file.path) === row.file.path && fs.lstatSync(row.file.path).isFile(), 'asset path differs');
    assets.set(row.url,row.file);
  }
  const errorDir = privateDir(policy.root,'errors');
  const registry = privateDir(policy.root,'registry');
  const slots = privateDir(policy.root,'worker-slots');
  const capability=process.env.ZIGGY_ALEO_CAPABILITY ?? 'main';
  requireValue(['main','sdk','xhr'].includes(capability),'invalid capability');
  const tmp = privateDir(policy.root,`sdk-tmp/${process.pid}-${threads.threadId}`);
  process.env.TMPDIR = tmp;
  const deadline = BigInt(policy.deadline_monotonic_ns);
  let failed;
  function record(kind, data) {
    const file = path.join(registry,`${process.pid}-${threads.threadId}-${kind}-${randomBytes(8).toString('hex')}.json`);
    fs.writeFileSync(file,JSON.stringify({kind,pid:process.pid,threadId:threads.threadId,monotonic_ns:String(process.hrtime.bigint()),...data}),{flag:'wx',mode:0o600});
  }
  function deny(message) {
    failed ??= new Error(message);
    if (fs.readdirSync(errorDir).length < 128) fs.writeFileSync(path.join(errorDir,`${process.pid}-${threads.threadId}-${randomBytes(8).toString('hex')}.json`),JSON.stringify({pid:process.pid,threadId:threads.threadId,error:message,monotonic_ns:String(process.hrtime.bigint())}),{flag:'wx',mode:0o600});
    throw failed;
  }
  function check() {
    if (failed) throw failed;
    if (fs.readdirSync(errorDir).length) throw new Error('latched policy violation in owned isolate');
    if (process.hrtime.bigint() >= deadline) deny('absolute fixture deadline');
  }
  const ports = new Set(policy.rpc_ports);
  requireValue([...ports].every(n => Number.isInteger(n) && n > 1024 && n < 65536), 'invalid ports');
  const cacheOrigin = `http://127.0.0.1:${policy.cache_port}`;
  function route(raw, method='GET', headers) {
    check();
    const u = new URL(raw);
    if (u.username || u.password || u.hash) deny('credential/fragment URL');
    if (headers) for (const [k] of new Headers(headers)) if (['authorization','proxy-authorization','cookie','range'].includes(k)) deny('unapproved credential/range header');
    const asset = assets.get(u.href);
    if (asset) {
      if (method !== 'GET') deny('parameter method');
      record('asset-route',{url:u.href,sha256:asset.sha256});
      return `${cacheOrigin}/sha256/${asset.sha256}`;
    }
    if (u.protocol === 'http:' && u.hostname === '127.0.0.1' && ports.has(Number(u.port)) && ['GET','POST'].includes(method)) return u.href;
    deny(`foreign transport:${u.protocol}//${u.host}${u.pathname}`);
  }
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (resource, init) => {
    const req = new Request(resource,init);
    if (req.url === 'file:///') throw new TypeError('native Node fetch rejects file:'); // SDK capability probe.
    const target = route(req.url,req.method,req.headers);
    const remaining = Number((deadline-process.hrtime.bigint())/1000000n);
    if (remaining <= 0) deny('owner deadline before fetch');
    const response = await nativeFetch(target === req.url ? req : target, { ...(target === req.url ? {} : {method:'GET'}), redirect:'manual', signal:AbortSignal.any([req.signal,AbortSignal.timeout(remaining)]) });
    if (response.status >= 300 && response.status < 400) deny('redirect forbidden');
    return response;
  };
  const nativeHttpRequest = http.request;
  const nativeHttpsRequest = https.request;
  function request(protocol,args) {
    let opts; let callback;
    if (typeof args[0] === 'string' || args[0] instanceof URL) {
      opts = urlToHttpOptions(new URL(args[0]));
      if (args[1] && typeof args[1] === 'object') opts = {...opts,...args[1]};
      callback = typeof args[1] === 'function' ? args[1] : args[2];
    } else { opts = {...args[0]}; callback = args[1]; }
    if (opts.auth) deny('request auth');
    const scheme = opts.protocol ?? protocol;
    requireValue(scheme === protocol,'request protocol differs');
    const host = opts.hostname ?? opts.host;
    const port = opts.port ? `:${opts.port}` : '';
    const original = `${scheme}//${host}${port}${opts.path ?? '/'}`;
    const target = route(original,opts.method ?? 'GET',opts.headers);
    if (target !== new URL(original).href) {
      const u = new URL(target); opts = {...opts,protocol:'http:',hostname:u.hostname,host:u.hostname,port:u.port,path:u.pathname,headers:{...opts.headers,host:u.host}};
      return nativeHttpRequest.call(http,opts,callback);
    }
    return (scheme === 'http:' ? nativeHttpRequest : nativeHttpsRequest).call(scheme === 'http:' ? http : https,opts,callback);
  }
  http.request = (...args) => request('http:',args); https.request = (...args) => request('https:',args);
  http.get = (...args) => { const req=http.request(...args);req.end();return req; };
  https.get = (...args) => { const req=https.request(...args);req.end();return req; };
  const nativeConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function(...args) {
    check(); let first = args[0]; if (Array.isArray(first)) first=first[0];
    const o = typeof first === 'object' ? first : {port:first,host:typeof args[1] === 'string' ? args[1] : undefined};
    if (o?.path) deny('Node Unix socket forbidden; native capped Docker CLI only');
    if (!o || o.host !== '127.0.0.1' || ![...ports,policy.cache_port].includes(Number(o.port))) deny('raw socket escape');
    return nativeConnect.apply(this,args);
  };
  tls.connect = () => deny('raw TLS forbidden');
  const nativeLookup = dns.lookup;
  dns.lookup = function(hostname, ...args) {
    check();if (hostname !== '127.0.0.1') deny('DNS escape');
    return nativeLookup.call(dns,hostname,...args);
  };
  for (const key of ['resolve','resolve4','resolve6']) dns[key] = () => deny('DNS escape');
  requireValue(Number.isInteger(policy.max_threads_total) && policy.max_threads_total>0 && policy.max_threads_total<=8 && Number.isInteger(policy.max_threads_per_parent) && policy.max_threads_per_parent>0 && policy.max_threads_per_parent<=8 && policy.max_old_space_mb>0 && policy.max_old_space_mb<=3072,'finite Worker caps required');
  const OriginalWorker = threads.Worker;
  const allowedFiles = new Map(policy.allowed_worker_files.map(p => [p.path,p]));
  const sdkFiles = new Map(policy.allowed_sdk_worker_files.map(p => [p.path,p]));
  requireValue(sdkFiles.size === 4 && [...sdkFiles.keys()].every(p => allowedFiles.has(p)), 'closed SDK Worker target set required');
  if (capability === 'sdk' && !threads.isMainThread) {
    // Both pinned network polyfills install these accessors without setting
    // configurable. On an existing property omission retains its original flag.
    // Admit the actual Source contract before touching any worker globals.
    const groups = new Map();
    for (const pin of sdkFiles.values()) {
      verify(pin);
      const wire = fs.readFileSync(pin.path);
      requireValue(wire.length === pin.bytes && sha(wire) === pin.sha256, 'captured SDK worker Source differs');
      const network = path.basename(path.dirname(pin.path));
      const name = path.basename(pin.path);
      requireValue(['mainnet','testnet'].includes(network) && ['node-polyfill.js','worker.js'].includes(name), 'SDK worker Source layout differs');
      const key = `${network}/${name}`;
      requireValue(!groups.has(key), 'duplicate SDK worker Source role');
      groups.set(key, wire.toString('utf8'));
    }
    requireValue(groups.size === 4 && ['mainnet','testnet'].every(network => ['node-polyfill.js','worker.js'].every(name => groups.has(`${network}/${name}`))), 'exact SDK Source network pairs required');
    for (const network of ['mainnet','testnet']) {
      const source = groups.get(`${network}/node-polyfill.js`);
      const marker = '    const makeSetter = (prop, event) => {';
      const start = source.indexOf(marker);
      const end = source.indexOf('    };', start);
      requireValue(start >= 0 && source.indexOf(marker, start + 1) === -1 && end > start &&
        sha(Buffer.from(source.slice(start,end + 6))) === '5a9221b3a6b5884387b7871b75d88348'+'5dcadf850fffa1704f1641a9e7036c8e' &&
        source.includes('if (!$worker.isMainThread) {\n    const globals = globalThis;') &&
        source.includes('    makeSetter("onmessage", "message");\n    makeSetter("onmessageerror", "messageerror");\n    makeSetter("onerror", "error");'), 'exact SDK worker handler Source contract required');
    }
    const handlers = ['onmessage','onmessageerror','onerror'];
    for (const name of handlers) if (Object.getOwnPropertyDescriptor(globalThis,name) !== undefined) deny('unexpected SDK worker global handler');
    for (const name of handlers) Object.defineProperty(globalThis,name,{configurable:true});
  }

  let workers=0;
  threads.Worker = class extends OriginalWorker {
    constructor(entry, options={}) {
      check();
      if (options.env === threads.SHARE_ENV) deny('shared Worker env');
      if (options.eval) {
        if (typeof entry !== 'string' || !policy.allowed_eval_sha256.includes(sha(entry))) deny('unknown Worker eval');
        // The admitted SDK eval template dynamically imports these two fields.
        // Admit both real pinned files before constructing any Worker.
        if (!options.workerData || Object.getPrototypeOf(options.workerData) !== Object.prototype || Object.keys(options.workerData).sort().join(',') !== 'polyfill,url') deny('unknown SDK Worker data');
        for (const name of ['url','polyfill']) {
          const href = options.workerData[name];
          if (typeof href !== 'string') deny('unknown SDK Worker target');
          let target;
          try { const url = new URL(href);if(url.protocol !== 'file:' || url.search || url.hash)deny('unknown SDK Worker target');target=fs.realpathSync(fileURLToPath(url)); }
          catch (error) { deny('invalid SDK Worker target'); }
          const allowed = sdkFiles.get(target);if(!allowed)deny('unadmitted SDK Worker target');verify(allowed);
        }

      } else {
        const p = fs.realpathSync(entry instanceof URL ? fileURLToPath(entry) : entry);
        const allowed = allowedFiles.get(p); if (!allowed) deny('unknown Worker module'); verify(allowed);
      }
      if (capability === 'xhr') deny('XHR helper cannot create Workers');
      if (++workers > policy.max_threads_per_parent) deny('Worker cap');
      let slot;
      for(let i=0;i<policy.max_threads_total;i++) {
        const candidate=path.join(slots,String(i));
        try { const fd=fs.openSync(candidate,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,parentThreadId:threads.threadId}));fs.closeSync(fd);slot=candidate;break; }
        catch(error) { if(error.code !== 'EEXIST')throw error; }
      }
      if(!slot)deny('total Worker cap');
      const execArgv = options.execArgv ?? process.execArgv;
      const flags=[];
      for (let i=0;i<execArgv.length;i++) {
        if (execArgv[i] === '--import' && execArgv[i+1] === SELF) { i++;continue; }
        if (!['--experimental-strip-types','--no-warnings'].includes(execArgv[i])) deny('foreign Worker loader');
        flags.push(execArgv[i]);
      }
      const env = {...(options.env ?? process.env)};
      if (env.NODE_OPTIONS) deny('ambient child loader');
      Object.assign(env,{ZIGGY_ALEO_BOOTSTRAP_CHILD:'1',ZIGGY_ALEO_CAPABILITY:'sdk',ZIGGY_ALEO_POLICY:policyPath,ZIGGY_ALEO_POLICY_SHA:expectedSha});
      const limits=options.resourceLimits ?? {};
      try { super(entry,{...options,env,execArgv:[...flags,'--import',SELF],resourceLimits:{...limits,maxOldGenerationSizeMb:Math.min(limits.maxOldGenerationSizeMb ?? policy.max_old_space_mb,policy.max_old_space_mb)}}); } catch(error) { fs.unlinkSync(slot);throw error; }
      record('worker-start',{childThreadId:this.threadId});
      this.once('exit',code=>{workers--;fs.unlinkSync(slot);record('worker-wait',{code});});
    }
  };
  let syncChildren=0;
  const nativeSpawn = childProcess.spawn;
  const nativeExecFile = childProcess.execFile;
  const nativeExecFileSync = childProcess.execFileSync;
  function retainNative(child,file) {
    let identity=null,identityError=null;try{identity=nativeExecFileSync(policy.diagnostic_ps.path,['-p',String(child.pid),'-o','pid=,pgid=,lstart=,comm='],{encoding:'utf8',timeout:2000}).trim().replace(/\s+/g,' ');}catch(error){identityError={message:String(error),status:error.status,signal:error.signal,stdout:error.stdout,stderr:error.stderr};}
    record('native-child-start',{childPid:child.pid,executable:file,identity,identityError});
    child.once('close',(code,signal)=>record('native-child-wait',{childPid:child.pid,code,signal,waitReturned:true}));
    return child;
  }
  const nativeFiles=new Map((policy.allowed_native_executables ?? []).map(p=>[p.path,p]));
  function nativeAllowed(file) {
    check();if(capability !== 'main')deny('isolate native process escape');
    const allowed=nativeFiles.get(file);if(!allowed)deny('unapproved native executable');verify(allowed);
  }
  childProcess.spawn = function(file,args=[],options) {
    if (file === process.execPath && args[0] === '-e') {
      check();
      if (capability === 'xhr') deny('recursive XHR helper');
      if (args.length !== 2 || typeof args[1] !== 'string' || !args[1].startsWith(XHR_PREFIX)) deny('unknown Node-e helper');
      const code=args[1];const marker='var options = ';const start=code.indexOf(marker);
      if(start<0)deny('XHR options missing');
      let end=start+marker.length,depth=0,quoted=false,escape=false;
      for(;end<code.length;end++) {const ch=code[end];if(quoted){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')quoted=false;}else if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&--depth===0){end++;break;}}
      let opts;try{opts=JSON.parse(code.slice(start+marker.length,end));}catch{deny('XHR options malformed');}
      const proto=code.includes('var isSsl = true;')?'https:':'http:';
      route(`${proto}//${opts.hostname ?? opts.host}${opts.port ? ':'+opts.port : ''}${opts.path ?? '/'}`,opts.method ?? 'GET',opts.headers);
      const sync=path.join(process.env.TMPDIR,`.node-xmlhttprequest-sync-${process.pid}`),content=path.join(process.env.TMPDIR,`.node-xmlhttprequest-content-${process.pid}`);
      if(!code.includes("'"+sync+"'")||!code.includes("'"+content+"'"))deny('XHR private temp paths differ');
      const env={...(options?.env ?? process.env)};if(env.NODE_OPTIONS)deny('ambient helper loader');
      Object.assign(env,{ZIGGY_ALEO_BOOTSTRAP_CHILD:'1',ZIGGY_ALEO_CAPABILITY:'xhr',ZIGGY_ALEO_POLICY:policyPath,ZIGGY_ALEO_POLICY_SHA:expectedSha});
      if(syncChildren>=2)deny('sync helper cap');
      syncChildren++;
      const child=nativeSpawn.call(childProcess,file,['--import',SELF,...args],{...options,env});
      retainNative(child,file);
      record('sync-child-start',{childPid:child.pid,executable:file});
      child.once('close',(code,signal)=>{syncChildren--;record('sync-child-wait',{childPid:child.pid,code,signal,waitReturned:true});});
      return child;
    }
    nativeAllowed(file);return retainNative(nativeSpawn.call(childProcess,file,args,options),file);
  };
  childProcess.execFile=function(file,...args){nativeAllowed(file);return retainNative(nativeExecFile.call(childProcess,file,...args),file);};
  for(const key of ['exec','execSync','execFileSync','spawnSync','fork'])childProcess[key]=()=>deny('unapproved process API:'+key);
  syncBuiltinESMExports();
  record('bootstrap-ready',{tmpdir:tmp,policySha:expectedSha});
  const context={check,route,policySha:expectedSha,policy};globalThis[SYMBOL]=context;return context;
}
if (process.env.ZIGGY_ALEO_BOOTSTRAP_CHILD === '1') install(process.env.ZIGGY_ALEO_POLICY,process.env.ZIGGY_ALEO_POLICY_SHA);
