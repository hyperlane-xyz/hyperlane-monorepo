"""Only two exact reviewed sibling modules; never trust another search directory."""
import hashlib,sys,types
from pathlib import Path
SHARED=Path(__file__).resolve().parent.parent/'aleo_linux'
SDK=Path(__file__).resolve().parent.parent/'aleo_linux_sdk'
CLI_SHA=('7e53d7cdef0217b1da3201e55a2abc41' 'd6be7aeb8078e5d22c48cb28fcf2157b')
EXPECTED={'receipts':('9330fa9b32fec3c37f1fc121c18054dc' 'f2d8354c14f997be1731836170fa8706'),'loopback_bridge':('ca2a8372d7f25db7a16dc7636da34585' '5d979004ea9f3290dc88a0ae8ac9fdbd'),'docker_gate':('a3a14dbd57dbaefdbc57a1b3af2f3124' '7824e973ce08d09efe8affc37b800a91')}
_OWNED={}
def load_exact_source(path,digest,name):
 path=Path(path)
 if path.resolve(strict=True)!=path or any(p.is_symlink()for p in [path,*path.parents]):raise ValueError('fixed sibling alias forbidden')
 raw=path.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=digest:raise ValueError('reviewed sibling Source changed')
 if name in sys.modules:
  owned=_OWNED.get(name)
  if owned is None or owned!=(sys.modules[name],digest):raise ValueError('foreign preloaded sibling module')
  return owned[0]
 module=types.ModuleType(name);module.__file__=str(path);module.__package__='';sys.modules[name]=module
 try:exec(compile(raw,str(path),'exec'),module.__dict__)
 except BaseException:sys.modules.pop(name,None);raise
 _OWNED[name]=(module,digest);return module

def load_shared():
 for name,digest in EXPECTED.items():
  path=(SDK if name=='docker_gate'else SHARED)/(name+'.py')
  load_exact_source(path,digest,name)
