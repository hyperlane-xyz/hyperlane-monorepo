"""Data-only catalog of the pinned SDK eval template and four Worker modules."""
import hashlib
import re
from pathlib import Path
from receipts import checked, need


def catalog(polyfills,workers):
    need(len(polyfills)==len(workers)==2,'exact testnet/mainnet Worker Source pairs required')
    hashes=[]
    for pin in polyfills:
        path=checked(pin);source=path.read_text()
        need(path.name=='node-polyfill.js'and path.parent.name in {'testnet','mainnet'},'actual SDK node polyfill required')
        templates=re.findall(r'const code = `([^`]+)`;',source)
        need(len(templates)==1,'one exact SDK eval template required')
        code=templates[0]
        need('${'not in code and 'import(workerData.polyfill)'in code and 'import(workerData.url)'in code,'SDK Worker template changed')
        hashes.append(hashlib.sha256(code.encode()).hexdigest())
    for pin in workers:
        path=checked(pin);need(path.name=='worker.js'and path.parent.name in {'testnet','mainnet'},'actual WASM Worker file required')
    need({Path(row['path']).parent.name for row in polyfills}=={'testnet','mainnet'}and{Path(row['path']).parent.name for row in workers}=={'testnet','mainnet'},'exact Source network pair required')
    return {'allowed_worker_files':polyfills+workers,'allowed_eval_sha256':sorted(set(hashes)),'SDK_or_Worker_execution':False}
