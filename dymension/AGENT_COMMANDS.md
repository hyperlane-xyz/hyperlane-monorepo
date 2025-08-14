# Hyperlane Agent Commands Guide

This guide documents all HTTP endpoints exposed by Hyperlane relayer and validator agents on their metrics server (default port 9090).

## Table of Contents
- [Common Endpoints](#common-endpoints)
- [Relayer Endpoints](#relayer-endpoints)
- [Validator Endpoints](#validator-endpoints)

## Common Endpoints

### Metrics
- **Endpoint**: `GET /metrics`
- **Description**: Returns Prometheus metrics in OpenMetrics format
- **Example**:
  ```bash
  curl http://localhost:9090/metrics
  ```

## Relayer Endpoints

### 1. Message Retry
- **Endpoint**: `POST /message_retry`
- **Description**: Retry messages based on matching criteria
- **Parameters**: JSON array of matching criteria
  - `messageid`: Specific message ID to retry
  - `origindomain`: Filter by origin domain ID
  - `destinationdomain`: Filter by destination domain ID
  - `senderaddress`: Filter by sender address
  - `recipientaddress`: Filter by recipient address
- **Example**:
  ```bash
  # Retry by message ID
  curl http://localhost:9090/message_retry -X POST \
    -H "Content-Type: application/json" \
    -d '[{"messageid": "0x842010253b156c22709f098e3a99b5af4048f0f5cab0e0db493fd864f5b05f94"}]'
  
  # Retry by destination domain
  curl http://localhost:9090/message_retry -X POST \
    -H "Content-Type: application/json" \
    -d '[{"destinationdomain": 42161}]'
  
  # Retry by multiple criteria
  curl http://localhost:9090/message_retry -X POST \
    -H "Content-Type: application/json" \
    -d '[{"origindomain": 1}, {"destinationdomain": 42161}]'
  ```

### 2. List Operations
- **Endpoint**: `GET /list_operations`
- **Description**: List pending operations for a specific destination domain
- **Query Parameters**:
  - `destination_domain`: Domain ID (required)
- **Example**:
  ```bash
  curl "http://localhost:9090/list_operations?destination_domain=42161"
  ```

### 3. List Messages
- **Endpoint**: `GET /messages`
- **Description**: Retrieve messages by nonce range
- **Query Parameters**:
  - `domain_id`: Domain ID (required)
  - `nonce_start`: Starting nonce (required)
  - `nonce_end`: Ending nonce (required)
- **Example**:
  ```bash
  curl "http://localhost:9090/messages?domain_id=1&nonce_start=100&nonce_end=120"
  ```

### 4. Insert Messages
- **Endpoint**: `POST /messages`
- **Description**: Insert messages into the database
- **Parameters**: JSON body with message data

### 5. List Merkle Tree Insertions
- **Endpoint**: `GET /merkle_tree_insertions`
- **Description**: List merkle tree insertions
- **Query Parameters**: Varies by implementation

### 6. Insert Merkle Tree Insertions
- **Endpoint**: `POST /merkle_tree_insertions`
- **Description**: Insert merkle tree data
- **Parameters**: JSON body with insertion data

### 7. Add IGP Rule
- **Endpoint**: `POST /igp_rules`
- **Description**: Add a new interchain gas payment enforcement rule
- **Parameters**: JSON body with:
  - `policy`: Gas payment enforcement policy
    - `"None"`: No enforcement
    - `{"Minimum": {"payment": "0x64"}}`: Minimum payment requirement
  - `matching_list`: Array of matching criteria
- **Example**:
  ```bash
  curl http://localhost:9090/igp_rules -X POST \
    -H "Content-Type: application/json" \
    -d '{
      "policy": {
        "Minimum": {
          "payment": "0x64"
        }
      },
      "matching_list": [
        {
          "origindomain": 100
        }
      ]
    }'
  ```

### 8. List IGP Rules
- **Endpoint**: `GET /igp_rules`
- **Description**: List all configured IGP rules
- **Example**:
  ```bash
  curl http://localhost:9090/igp_rules
  ```

### 9. Remove IGP Rule
- **Endpoint**: `DELETE /igp_rules/{index}`
- **Description**: Remove an IGP rule by index
- **Parameters**:
  - `index`: Rule index in path
- **Example**:
  ```bash
  curl -X DELETE http://localhost:9090/igp_rules/0
  ```

### 10. Environment Variables (Optional)
- **Endpoint**: `GET/POST /environment_variable`
- **Description**: Get or set environment variables
- **Note**: Only enabled when `HYPERLANE_RELAYER_ENVIRONMENT_VARIABLE_ENDPOINT_ENABLED=true`
- **Parameters**: JSON body with:
  - `name`: Variable name
  - `value`: Variable value (optional, omit to unset)
- **Example**:
  ```bash
  # Get environment variable
  curl http://localhost:9090/environment_variable \
    -H "Content-Type: application/json" \
    -d '{"name": "MY_VAR"}'
  
  # Set environment variable
  curl http://localhost:9090/environment_variable -X POST \
    -H "Content-Type: application/json" \
    -d '{"name": "MY_VAR", "value": "my_value"}'
  
  # Unset environment variable
  curl http://localhost:9090/environment_variable -X POST \
    -H "Content-Type: application/json" \
    -d '{"name": "MY_VAR"}'
  ```

## Validator Endpoints

### 1. EigenLayer Node Info
- **Endpoint**: `GET /eigen/node`
- **Description**: Returns node information
- **Response**:
  ```json
  {
    "node_name": "Hyperlane Validator",
    "spec_version": "0.1.0",
    "node_version": "0.1.0"
  }
  ```
- **Example**:
  ```bash
  curl http://localhost:9090/eigen/node
  ```

### 2. EigenLayer Node Health
- **Endpoint**: `GET /eigen/node/health`
- **Description**: Returns node health status
- **Response Codes**:
  - `200`: Healthy (checkpoint delta ≤ 1)
  - `206`: Partially healthy (checkpoint delta ≤ 10)
  - `503`: Unhealthy (checkpoint delta > 10)
- **Example**:
  ```bash
  curl http://localhost:9090/eigen/node/health
  ```

### 3. EigenLayer Node Services
- **Endpoint**: `GET /eigen/node/services`
- **Description**: List validator services
- **Response**:
  ```json
  [
    {
      "id": "hyperlane-validator-indexer",
      "name": "indexer",
      "description": "indexes the messages from the origin chain mailbox",
      "status": "Up"
    },
    {
      "id": "hyperlane-validator-submitter",
      "name": "submitter",
      "description": "signs messages indexed from the indexer",
      "status": "Up"
    }
  ]
  ```
- **Example**:
  ```bash
  curl http://localhost:9090/eigen/node/services
  ```

### 4. EigenLayer Service Health
- **Endpoint**: `GET /eigen/node/services/{service_id}/health`
- **Description**: Check health of a specific service
- **Parameters**:
  - `service_id`: Service identifier in path
- **Response Codes**:
  - `200`: Service healthy
  - `503`: Service unhealthy
- **Example**:
  ```bash
  curl http://localhost:9090/eigen/node/services/hyperlane-validator-indexer/health
  ```

## Usage Notes

1. **Default Port**: Both relayer and validator agents expose their HTTP server on port 9090 by default. This can be configured via agent settings.

2. **Authentication**: These endpoints are not authenticated by default. Ensure proper network security if exposing to public networks.

3. **Response Format**: Most endpoints return JSON responses. Check the `Content-Type` header in responses.

4. **Error Handling**: Failed requests typically return appropriate HTTP status codes:
   - `400`: Bad Request (invalid parameters)
   - `404`: Not Found (resource doesn't exist)
   - `500`: Internal Server Error

5. **Matching Lists**: When using matching lists in endpoints like `/message_retry` or `/igp_rules`, you can combine multiple criteria. All specified criteria must match for the rule to apply.

## Common Use Cases

### Retry Failed Messages
```bash
# Retry all messages to a specific destination
curl http://localhost:9090/message_retry -X POST \
  -H "Content-Type: application/json" \
  -d '[{"destinationdomain": 137}]'
```

### Monitor Validator Health
```bash
# Check if validator is healthy
curl -s -o /dev/null -w "%{http_code}" http://localhost:9090/eigen/node/health
```

### Debug Pending Operations
```bash
# View all pending operations for Arbitrum
curl "http://localhost:9090/list_operations?destination_domain=42161" | jq
```

### Configure Gas Payment Rules
```bash
# Require minimum gas payment for messages from Ethereum
curl http://localhost:9090/igp_rules -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "policy": {
      "Minimum": {
        "payment": "0x3B9ACA00"
      }
    },
    "matching_list": [
      {
        "origindomain": 1
      }
    ]
  }'
```