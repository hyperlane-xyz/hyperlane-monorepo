---
'@hyperlane-xyz/cli': major
---

CLI array input handling changed from CSV parsing to native yargs array syntax. Commands now use `--chains a --chains b` instead of `--chains a,b`. Affected options: `--chains`, `--validators`, `--targets`. Fixed a bug in chain resolver where string spreading produced individual characters instead of chain names.
