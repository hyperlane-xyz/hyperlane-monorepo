---
'@hyperlane-xyz/aleo-sdk': minor
---

The Aleo SDK e2e test infrastructure was refactored to use testcontainers and expose reusable testing utilities for client packages. A new testing module (`@hyperlane-xyz/aleo-sdk/testing`) exports test chain metadata, node management functions, and signer creation helpers following the Cosmos SDK pattern. The testcontainers library replaced docker-compose for automatic container lifecycle management with proper port binding and environment configuration. A global test setup file handles before/after hooks for starting and stopping the devnode. All 54 e2e tests pass with the new infrastructure, and the shell script was simplified to only set environment variables while testcontainers manages the container.
