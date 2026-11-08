"""Only two exact reviewed sibling modules; never trust another search directory."""
import hashlib,sys,types
from pathlib import Path
SHARED=Path(__file__).resolve().parent.parent/'aleo_linux'
SDK=Path(__file__).resolve().parent.parent/'aleo_linux_sdk'
CLI_SHA=('575c250416ab1a1b812c4b7cd1e8fa0c' 'a1f557ebc2b7938e0308b32fe25c6100')
EXPECTED={'receipts':('a0dbe1ce96080a0f614605673994727a' '85fa946b49632f27e70223a0afe917a6'),'loopback_bridge':('6fbba59dd601c731cab4d86876a9f2d9b' '66d3a7687d3b354e8a3888d10ccbd6e'),'docker_gate':('5f366f27fb5699f0c111ffaa24c825b4' '643053b25f9be49bd2fdfeaddd5ce28d')}
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
