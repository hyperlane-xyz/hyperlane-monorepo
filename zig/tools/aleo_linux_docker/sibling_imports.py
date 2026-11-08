"""Only two exact reviewed sibling modules; never trust another search directory."""
import hashlib,sys,types
from pathlib import Path
SHARED=Path(__file__).resolve().parent.parent/'aleo_linux'
SDK=Path(__file__).resolve().parent.parent/'aleo_linux_sdk'
CLI_SHA=('9dec423bac0fec4a7bd681a59dda5c29' '9abe36da01f02a7b4797b54f03aaf69b')
EXPECTED={'receipts':('a0dbe1ce96080a0f614605673994727a' '85fa946b49632f27e70223a0afe917a6'),'loopback_bridge':('6fbba59dd601c731cab4d86876a9f2d9b' '66d3a7687d3b354e8a3888d10ccbd6e'),'docker_gate':('3542e89975f7a7022e5027b8ae9233d7' 'c08552fecfa5b35712b77af921f1d924')}
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
