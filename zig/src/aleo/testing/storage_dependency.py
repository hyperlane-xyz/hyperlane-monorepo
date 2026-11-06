"""Reconstruct a narrow non-crypto SDK resource-path patch from a pinned crate."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

BASE = Path(__file__).resolve().parents[1]
def prepare():
    record = json.loads((BASE / "testing/storage_dependency.json").read_text())
    digest = "".join(record["sha256_chunks"])
    archive = BASE / "native-vm/vendor/aleo-std-storage.crate"
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        with urllib.request.urlopen("https://static.crates.io/crates/aleo-std-storage/aleo-std-storage-1.0.3.crate", timeout=30) as response:
            data = response.read(1024 * 1024)
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("Upstream storage crate checksum mismatch")
        archive.write_bytes(data)
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Stored upstream storage crate checksum mismatch")
    destination = archive.parent / "aleo-std-storage-1.0.3"
    if destination.exists():
        # Validate every generated file against the original archive+exact patch.
        pass
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as source:
        for item in source.getmembers():
            if not item.isfile():
                raise ValueError("Unexpected non-regular crate archive member")
            path = Path(item.name)
            if path.is_absolute() or ".." in path.parts or path.parts[0] != "aleo-std-storage-1.0.3":
                raise ValueError("Unexpected crate archive path")
            wire = source.extractfile(item).read()
            if path.as_posix() == "aleo-std-storage-1.0.3/src/lib.rs":
                text = wire.decode().replace("use dirs::home_dir;\n", "").replace('const ALEO_DIRECTORY: &str = ".aleo";\n', "")
                start = text.index("pub fn aleo_dir() -> PathBuf {")
                end = text.index("\n}\n", start) + 2
                text = text[:start] + '''pub fn aleo_dir() -> PathBuf {
    // Zig worker injects an explicit public-parameter directory. No ambient HOME.
    std::env::var_os("HYPERLANE_ALEO_PARAMETER_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/nonexistent/ziggy-aleo-parameters-unconfigured"))
}''' + text[end:]
                wire = text.encode()
            target = archive.parent / path
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() and target.read_bytes() != wire:
                raise ValueError("Generated SDK dependency changed unexpectedly")
            target.write_bytes(wire)
    return destination

if __name__ == "__main__":
    print(prepare())
