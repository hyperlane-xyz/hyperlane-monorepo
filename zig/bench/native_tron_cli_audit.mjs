// Static AST + actual ESM/CJS export resolution. Never evaluate CLI/SDK modules.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire,builtinModules} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const [workspace,parserFile,out]=process.argv.slice(2);
if(!fs.realpathSync(parserFile).startsWith(fs.realpathSync(workspace)+path.sep))throw Error('compiler parser outside exact owned Linux graph');
const require=createRequire(import.meta.url),ts=require(parserFile);
const allowed=[fs.realpathSync(workspace)];
const entry=path.join(workspace,'typescript/cli/dist/cli.js');
const queue=[entry],visited=new Set(),edges=[],missing=[],opaque=[];
const builtins=new Set([...builtinModules,...builtinModules.map(n=>'node:'+n)]);
const inside=p=>allowed.some(root=>p===root||p.startsWith(root+path.sep));
function regular(p){try{return fs.statSync(p).isFile()}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;throw error}}
while(queue.length){
 const file=fs.realpathSync(queue.shift());if(visited.has(file))continue;
 if(!inside(file)||visited.size>=12000)throw Error('static closure escaped/bound');visited.add(file);
 const text=fs.readFileSync(file,'utf8');if(Buffer.byteLength(text)>32*1024**2)throw Error('module read bound');
 const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),specs=[];
 function visit(n){
  if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)&&!n.importClause?.isTypeOnly)specs.push({specifier:n.moduleSpecifier.text,kind:'import'});
  else if(ts.isExportDeclaration(n)&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier)&&!n.isTypeOnly)specs.push({specifier:n.moduleSpecifier.text,kind:'export'});
  else if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(n.expression)&&n.expression.text==='require'))){
   if(n.arguments.length===1&&ts.isStringLiteral(n.arguments[0]))specs.push({specifier:n.arguments[0].text,kind:n.expression.kind===ts.SyntaxKind.ImportKeyword?'dynamic-import':'require'});
   else opaque.push({from:file,kind:'nonliteral import/require; not executed'});
  }
  ts.forEachChild(n,visit);
 }
 visit(ast);
 for(const row of specs){
  if(builtins.has(row.specifier)){edges.push({from:file,...row,builtin:true});continue;}
  try{
   const resolved=row.kind==='require'?createRequire(file).resolve(row.specifier):fileURLToPath(import.meta.resolve(row.specifier,pathToFileURL(file).href));
   if(!regular(resolved))throw Error('resolved target absent');const real=fs.realpathSync(resolved);if(!inside(real))throw Error('resolved outside admitted workspaces');
   edges.push({from:file,...row,canonical:real});
   // Registry dependencies are exhaustively payload-pinned by the install snapshot,
   // not evaluated. Traverse actual current Linux internal compiled SDKs and new CLI code.
   if(!real.includes('/node_modules/')&&/\.[cm]?js$/.test(real))queue.push(real);
  }catch(error){missing.push({from:file,...row,error:error.code||error.message});}
 }
}
const files=[...visited].sort().map(p=>({path:p,bytes:fs.statSync(p).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}));
const tronDynamic=edges.some(e=>e.from.endsWith('/typescript/sdk/dist/providers/MultiProvider.js')&&e.specifier==='@hyperlane-xyz/tron-sdk'&&e.canonical?.startsWith(workspace+'/typescript/tron-sdk/dist/'));
const actualTVMFactories=files.some(f=>f.path.startsWith(workspace+'/solidity/dist/tron/typechain/factories/'));
const result={schema:1,passed:missing.length===0&&opaque.length===0&&tronDynamic&&actualTVMFactories,scope:'Static emitted CLI/current Linux internal SDK AST and ESM/CJS exports only; no target module evaluation or CLI main',entry,files,edges,missing,opaque,tronDynamic,actualTVMFactories,external_payloads_pinned_separately:true};
fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:result.passed,files:files.length,edges:edges.length,missing:missing.length,opaque:opaque.length,tronDynamic,actualTVMFactories}));if(!result.passed)process.exitCode=1;
