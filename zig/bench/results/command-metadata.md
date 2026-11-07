# Historical command metadata

The command records are published as [relayer JSON gzip](relayer-final-commands.json.gz)
and [validator JSON gzip](validator-final-commands.json.gz). The [split hash index](command-metadata-hashes.json)
binds their exact decoded bytes to the unchanged local raw mirrors.

These are historical recipes/provenance. They are not current build acceptance,
proof acceptance, a fresh deadline, or execution approval. No command is run by
opening or decoding either file.

Read them directly with the existing bounded `zig.tools.fixture_pack.unpack`
and `json.loads`, or inspect the small public gzip with a standard gzip reader.
No implicit raw/gzip fallback or new command-loader module is needed. The helper
rejects corrupt gzip and excessive decoded size; JSON decoding remains strict.

The old raw paths remain unchanged locally for historical protected descriptors.
An index-only removal publishes the gzip siblings while preserving every raw
byte and inode. Sealed historical manifests retain their original paths/hashes.
A fresh checkout can consume `.json.gz` directly; restoring a raw mirror is
optional and should use a new private destination when inspecting old evidence.
