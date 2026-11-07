"""Verify the exact public gzip payloads without restoring or importing fixtures."""
from pathlib import Path
import gzip,hashlib,json,re
B=Path(__file__).resolve().parent
index=json.loads((B/'hashes.json').read_text())
def joined(chunks):
    assert len(chunks)==2 and all(re.fullmatch('[0-9a-f]{32}',x) for x in chunks)
    return ''.join(chunks)
for row in index['payloads']:
    rel=Path(row['canonical']['path'])
    assert not rel.is_absolute() and '..' not in rel.parts
    p=B/rel
    assert p.is_file() and not p.is_symlink() and p.resolve().is_relative_to(B)
    compressed=p.read_bytes()
    assert len(compressed)==row['canonical']['bytes']
    assert hashlib.sha256(compressed).hexdigest()==joined(row['canonical']['sha256_chunks'])
    assert compressed[:3]==b'\x1f\x8b\x08' and compressed[3]==0 and compressed[4:8]==bytes(4)
    raw=gzip.decompress(compressed)
    assert len(raw)==row['original']['bytes']
    assert hashlib.sha256(raw).hexdigest()==joined(row['original']['sha256_chunks'])
    json.loads(raw)
print('Verified 11 deterministic gzip payloads and exact original byte hashes; no files restored.')
