"""Fresh loopback-only TLS identity; no committed or archived private key."""
import contextlib
import pathlib
import subprocess
import tempfile


@contextlib.contextmanager
def certificate():
    with tempfile.TemporaryDirectory(prefix="ziggy-loopback-tls-") as directory:
        root = pathlib.Path(directory)
        cert, key = root / "cert.pem", root / "key.pem"
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256",
             "-nodes", "-keyout", str(key), "-out", str(cert), "-days", "1",
             "-subj", "/CN=localhost", "-addext",
             "subjectAltName=DNS:localhost,IP:127.0.0.1"],
            check=True, capture_output=True, timeout=30,
        )
        yield cert, key
