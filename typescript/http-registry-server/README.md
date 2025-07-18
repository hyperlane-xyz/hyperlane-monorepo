# Hyperlane HTTP Registry Server

An HTTP server that provides a RESTful API for accessing data from the Hyperlane V3 registry. This server acts as a wrapper around the `@hyperlane-xyz/registry` package, making registry data available over the network.

## Features

- **RESTful API**: Exposes Hyperlane registry data (chains, addresses, warp routes) via a simple and consistent API.
- **Auto-Refresh**: Periodically fetches the latest registry data to stay up-to-date.
- **Configurable**: Easily configure the server's port, host, and data refresh interval via environment variables.
- **Structured Logging**: Uses `pino` for structured, performant logging, with pretty-printing for development environments.
- **Health Checks**: Includes standard `/health` and `/readiness` endpoints for container orchestration systems.
- **Standalone**: Can be run as a standalone service

## Installation

This server is part of the Hyperlane monorepo. Ensure you have installed the root dependencies.

```bash
# From the monorepo root
yarn install
```

## Configuration

The server is configured using environment variables. You can place these in a `.env` file in the package root (`typescript/http-registry-server/.env`).

| Variable           | Description                                      | Default              |
| ------------------ | ------------------------------------------------ | -------------------- |
| `PORT`             | The port for the server to listen on.            | `3000`               |
| `HOST`             | The host address to bind to.                     | `0.0.0.0`            |
| `REFRESH_INTERVAL` | The interval (in ms) to refresh registry data.   | `60000` (60 seconds) |
| `LOG_LEVEL`        | The minimum log level to output.                 | `info`               |
| `LOG_FORMAT`       | The log format. Set to `pretty` for development. | `json`               |

## Usage

### Running the Server

- **Development:**
  To run the server in development mode with hot-reloading and human-readable logs:
  ```bash
  # From typescript/http-registry-server
  yarn dev -- --registry path/to/registry
  ```
  In a separate terminal:
  ```bash
  # From typescript/http-registry-server
  yarn start:dev -- --registry path/to/registry
  ```

### Other Scripts

- `yarn test`: Run unit tests.
- `yarn lint`: Lint the codebase.
- `yarn clean`: Remove the compiled output directory.

## API Endpoints

### Health Checks

- **`GET /health`**
  - Returns a `200 OK` status if the server is running.
- **`GET /readiness`**
  - Returns a `200 OK` status if the server is ready to accept traffic.

### Root

- **`GET /`**
  - Provides a list of all available endpoints.
- **`GET /metadata`**
  - Retrieves all chain metadata from the registry.
- **`GET /addresses`**
  - Retrieves all deployed contract addresses from the registry.
- **`GET /chains`**
  - Retrieves a list of all chain names in the registry.
- **`GET /list-registry-content`**
  - Retrieves the entire content of the registry.
- **`GET /warp-routes`**
  - Retrieves a list of all warp routes, with optional filtering.
  - **Query Parameters**: Based on `WarpRouteFilterSchema` from `@hyperlane-xyz/registry`.

### Chains

- **`GET /chain/:chain/metadata`**
  - Retrieves the metadata for a specific chain.
  - **URL Parameters**:
    - `chain`: The name of the chain (e.g., `ethereum`).
- **`GET /chain/:chain/addresses`**
  - Retrieves the deployed contract addresses for a specific chain.
  - **URL Parameters**:
    - `chain`: The name of the chain (e.g., `ethereum`).
- **`POST /chain/:chain`**
  - Adds or updates the configuration for a specific chain. This endpoint is intended for dynamic, local registries and may not be available for all registry types.
  - **URL Parameters**:
    - `chain`: The name of the chain to update.
  - **Request Body**: A JSON object matching the `UpdateChainSchema` from `@hyperlane-xyz/registry`.

### Warp Routes

- **`GET /warp-route/*id`**
  - Retrieves a specific warp route by its ID. The ID can be a complex path.
  - **URL Parameters**:
    - `id`: The unique identifier of the warp route.
