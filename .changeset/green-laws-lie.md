'@hyperlane-xyz/sdk': major
---

Selective runtime registration was added to `@hyperlane-xyz/sdk` through new `./runtime` and `./register/*` entrypoints. Root SDK imports stopped auto-registering the full runtime, so consumers now explicitly register the VM runtimes they need.
