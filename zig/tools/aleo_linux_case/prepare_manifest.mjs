// Metadata only. Importing the TS driver does not import its SDK or run its main.
// This entry point is authorized only as the reviewed CI preparation command.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const need=(value,message)=>{if(!value)throw new Error(message);};
const sha=(bytes)=>createHash('sha256').update(bytes).digest('hex');
function checked(pin) {
  need(Number.isSafeInteger(pin.bytes)&&pin.bytes>=0&&pin.bytes<=32*1024**2,'bounded metadata input required');
  const info=fs.lstatSync(pin.path);
  need(info.isFile()&&!info.isSymbolicLink()&&fs.realpathSync(pin.path)===pin.path&&info.size===pin.bytes,'metadata input type/path/size changed');
  const raw=fs.readFileSync(pin.path);need(sha(raw)===pin.sha256,'metadata input hash changed');return raw;
}
function write(file,value) {
  const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return {path:file,bytes:bytes.length,sha256:sha(bytes)};
}
need(process.argv.length===5&&process.argv[2]==='--finalize','inert: exact reviewed metadata finalization required');
const bindingPath=fs.realpathSync(process.argv[3]);const raw=fs.readFileSync(bindingPath);
need(sha(raw)===process.argv[4],'authorization input changed');const binding=JSON.parse(raw);
need(binding.root_approved===true&&binding.purpose==='aleo-linux-fullcase-authorization-v1','explicit full-case metadata authority required');
need(Object.keys(binding).sort().join('\0')===['root_approved','purpose','pending_spec','manifest_input','capacity'].sort().join('\0'),'closed metadata authority required');
const pending=JSON.parse(checked(binding.pending_spec));const input=JSON.parse(checked(binding.manifest_input));
need(pending.root_approved===false&&pending.purpose==='actual-aleo-linux-case-v1'&&pending.original_deadline_ns===undefined,'unminted pending full case required');
const driver=pathToFileURL(pending.driver.path);checked(pending.driver);
const {parseAleoManifest,approvalManifestDigest}=await import(driver.href);
const manifest=parseAleoManifest(input);const directory=path.dirname(binding.manifest_input.path);
need(directory===path.dirname(binding.pending_spec.path),'exact metadata directory differs');
const capacity=binding.capacity;
need(capacity.reviewed===true&&Number.isSafeInteger(capacity.observed_unix_ms)&&Date.now()>=capacity.observed_unix_ms&&Date.now()-capacity.observed_unix_ms<300000,'fresh actual reviewed capacity required');
need(capacity.minimum_free_bytes===6*1024**3&&capacity.docker_free_bytes>=12*1024**3&&capacity.host_free_bytes>=12*1024**3&&capacity.memory_available_bytes>=20.5*1024**3,'exact full-case headroom and combined reservation required');
const digest=approvalManifestDigest(manifest);
const approval=write(path.join(directory,'approval.json'),{root_approved:true,scenario:'aleo',runtime_source_commit:manifest.runtimeSourceCommit,mode:manifest.mode,manifest_sha256:digest,confirm_seconds:600,finality_grace_seconds:30,capacity,case_service_required:true,performance_credit:false});
manifest.approval=approval;const manifestPin=write(path.join(directory,'manifest.json'),manifest);
need(approvalManifestDigest(parseAleoManifest(JSON.parse(checked(manifestPin))))===digest,'typed approval digest changed');
pending.manifest=manifestPin;pending.manifest_digest=digest;pending.root_approved=true;
pending.pins.push(manifestPin,approval,{path:bindingPath,bytes:raw.length,sha256:sha(raw)});
write(path.join(directory,'case.json'),pending);
