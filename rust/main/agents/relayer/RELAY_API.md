# Relay API Documentation

## Overview

The Relay API provides HTTP endpoints for fast-tracking Hyperlane message relay without waiting for contract indexing. This bypasses the 20-60 second delay from scraper and relayer indexing in production environments.

**Key Benefits:**
- ⚡ **20-60 seconds faster** in production (bypasses scraper + relayer indexing)
- 🌍 **Protocol-agnostic**: Works with EVM, Cosmos, Sealevel, and all other chain types
- 🔒 **ISM-agnostic**: Works with MultisigISM, AggregationISM, RoutingISM, etc.
- 🔄 **Additive**: Coexists with normal indexing as a fast path

## Endpoints

### POST /relay

Create a new relay job by providing a transaction hash containing a Hyperlane Dispatch event.

**Request:**
```http
POST /relay
Content-Type: application/json

{
  "origin_chain": "ethereum",
  "tx_hash": "0x1234567890abcdef..."
}
```

**Request Fields:**
- `origin_chain` (string, required): Chain name where the message was dispatched
- `tx_hash` (string, required): Transaction hash containing the Hyperlane Dispatch event
  - **EVM chains**: Hex string with or without `0x` prefix (e.g., `"0x1234..."`)
  - **Sealevel (Solana)**: Base58 string (e.g., `"5J7Zw3..."`)
  - **Cosmos chains**: Hex or base64 string (e.g., `"A1B2C3..."`)

**Response:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Status Codes:**
- `200 OK`: Job created successfully
- `400 Bad Request`: Invalid request (empty chain name, malformed tx_hash)
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

---

### GET /relay/:id

Get the status of a relay job.

**Request:**
```http
GET /relay/550e8400-e29b-41d4-a716-446655440000
```

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "origin_chain": "ethereum",
  "origin_tx_hash": "0x1234567890abcdef...",
  "message_id": "0xabcdef...",
  "destination_chain": "domain-10",
  "status": "Confirmed",
  "destination_tx_hash": "0x9876543210fedcba...",
  "error": null,
  "created_at": 1710172800,
  "updated_at": 1710172815,
  "expires_at": 1710176400
}
```

**Response Fields:**
- `id`: Unique job identifier (UUID)
- `origin_chain`: Chain where message was dispatched
- `origin_tx_hash`: Transaction hash on origin chain
- `message_id`: Hyperlane message ID (H256, filled after extraction)
- `destination_chain`: Destination domain (filled after extraction)
- `status`: Current job status (see Status Values below)
- `destination_tx_hash`: Transaction hash on destination chain (filled after submission)
- `error`: Error message if status is Failed, null otherwise
- `created_at`: Unix timestamp when job was created (seconds)
- `updated_at`: Unix timestamp of last status update (seconds)
- `expires_at`: Unix timestamp when job expires (seconds, 1 hour TTL)

**Status Values:**
- `Pending`: Job created, not started
- `Extracting`: Fetching transaction receipt and extracting message
- `Preparing`: MessageProcessor preparing (building ISM metadata, estimating gas)
- `Submitting`: Submitting transaction to destination chain
- `Submitted`: Transaction submitted, waiting for confirmation
- `Confirmed`: Transaction confirmed on destination (final state)
- `Failed`: Error occurred (see `error` field)

**Status Codes:**
- `200 OK`: Job found and returned
- `404 Not Found`: Job not found or expired
- `500 Internal Server Error`: Server error

---

## Usage Examples

### JavaScript/TypeScript (fetch)

```typescript
// 1. Create relay job
async function createRelayJob(chainName: string, txHash: string): Promise<string> {
  const response = await fetch('http://localhost:3000/relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin_chain: chainName,
      tx_hash: txHash,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.job_id;
}

// 2. Poll for job status
async function waitForRelay(jobId: string, timeoutMs = 60000): Promise<any> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const response = await fetch(`http://localhost:3000/relay/${jobId}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const job = await response.json();

    if (job.status === 'Confirmed') {
      return job;
    }

    if (job.status === 'Failed') {
      throw new Error(`Relay failed: ${job.error}`);
    }

    // Poll every 2 seconds
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error('Relay timeout');
}

// 3. Complete flow
async function relayMessage(chainName: string, txHash: string) {
  console.log('Creating relay job...');
  const jobId = await createRelayJob(chainName, txHash);
  console.log(`Job created: ${jobId}`);

  console.log('Waiting for relay...');
  const result = await waitForRelay(jobId);
  console.log(`Relayed! Destination tx: ${result.destination_tx_hash}`);
}

// Example usage
await relayMessage('ethereum', '0x1234567890abcdef...');
```

### cURL

```bash
# Create relay job
curl -X POST http://localhost:3000/relay \
  -H "Content-Type: application/json" \
  -d '{
    "origin_chain": "ethereum",
    "tx_hash": "0x1234567890abcdef..."
  }'

# Response: {"job_id":"550e8400-e29b-41d4-a716-446655440000"}

# Check job status
curl http://localhost:3000/relay/550e8400-e29b-41d4-a716-446655440000

# Response:
# {
#   "id": "550e8400-e29b-41d4-a716-446655440000",
#   "status": "Confirmed",
#   ...
# }
```

### Python

```python
import requests
import time

def create_relay_job(chain_name: str, tx_hash: str) -> str:
    response = requests.post(
        'http://localhost:3000/relay',
        json={'origin_chain': chain_name, 'tx_hash': tx_hash}
    )
    response.raise_for_status()
    return response.json()['job_id']

def wait_for_relay(job_id: str, timeout_sec: int = 60):
    start_time = time.time()

    while time.time() - start_time < timeout_sec:
        response = requests.get(f'http://localhost:3000/relay/{job_id}')
        response.raise_for_status()
        job = response.json()

        if job['status'] == 'Confirmed':
            return job

        if job['status'] == 'Failed':
            raise Exception(f"Relay failed: {job['error']}")

        time.sleep(2)

    raise TimeoutError('Relay timeout')

# Example usage
job_id = create_relay_job('ethereum', '0x1234567890abcdef...')
print(f'Job created: {job_id}')

result = wait_for_relay(job_id)
print(f"Relayed! Destination tx: {result['destination_tx_hash']}")
```

---

## Configuration

### Environment Variables

Enable the relay API by setting:
```bash
export HYPERLANE_RELAYER_RELAY_API_ENABLED=true
```

For testing the API in isolation (disables normal contract indexing):
```bash
export HYPERLANE_RELAYER_DISABLE_INDEXING=true
```

**Warning**: `HYPERLANE_RELAYER_DISABLE_INDEXING=true` should only be used for testing. It disables all ContractSync and DbLoader tasks, so normal message indexing will not work.

### Rate Limiting

- Default: 100 requests per minute globally
- Configurable in code (see `handlers.rs`)
- Returns `429 Too Many Requests` when exceeded

### Job Expiration

- Jobs expire after 1 hour (3600 seconds)
- Expired jobs return `404 Not Found`
- Automatic cleanup runs periodically

---

## Protocol-Specific Examples

### EVM Chains

```json
POST /relay
{
  "origin_chain": "ethereum",
  "tx_hash": "0x742d35cc6634c0532925a3b844bc9e7595f0b3c5..."
}
```

### Sealevel (Solana)

```json
POST /relay
{
  "origin_chain": "solana",
  "tx_hash": "5J7Zw3vKXqKxZmHqRj4rHrCqJrXh3TqGxKyNk..."
}
```

### Cosmos

```json
POST /relay
{
  "origin_chain": "osmosis",
  "tx_hash": "A1B2C3D4E5F6..."
}
```

---

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Chain not found in registry` | Chain name not configured | Verify chain name matches relayer config |
| `No Hyperlane Dispatch events found` | Transaction doesn't contain dispatch | Verify correct transaction hash |
| `Failed to fetch transaction logs` | RPC error or tx not found | Check transaction is confirmed on chain |
| `No send channel for destination domain` | Destination not configured | Verify destination chain is in relayer config |
| `No message context for origin -> destination` | Route not configured | Verify route exists in relayer config |

### Error Response Format

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "Failed",
  "error": "No Hyperlane Dispatch events found in transaction",
  ...
}
```

---

## Architecture

### Flow Diagram

```
UI sends tx_hash
       ↓
POST /relay (< 1s response)
       ↓
Async extraction + injection
       ↓
MessageProcessor (prepare → submit → confirm)
       ↓
GET /relay/:id (poll for status)
```

### Integration with Normal Indexing

Fast relay is **additive** - normal indexing continues in parallel:
- Fast relay: UI-triggered, immediate feedback
- Normal indexing: Background, provides audit trail
- Deduplication: MessageProcessor handles duplicate submissions

### Supported ISMs

Works with **all ISM types**:
- MultisigISM
- AggregationISM
- RoutingISM
- TrustedRelayerISM
- Custom ISMs

All ISM metadata building is handled by the existing MessageProcessor.

---

## Testing

### Local Testing Setup

See the main README for setting up a local test environment with anvil chains.

### Example Test Flow

```bash
# 1. Send a warp transfer and get tx hash
TX_HASH=$(cast send $WARP_TOKEN "transferRemote(uint32,bytes32,uint256)" \
  $DEST_DOMAIN $RECIPIENT $AMOUNT \
  --rpc-url http://localhost:8545 \
  --private-key $PRIVATE_KEY \
  --json | jq -r .transactionHash)

# 2. Create relay job
JOB_ID=$(curl -X POST http://localhost:3000/relay \
  -H "Content-Type: application/json" \
  -d "{\"origin_chain\":\"anvil1\",\"tx_hash\":\"$TX_HASH\"}" \
  | jq -r .job_id)

echo "Job ID: $JOB_ID"

# 3. Poll for status
while true; do
  STATUS=$(curl -s http://localhost:3000/relay/$JOB_ID | jq -r .status)
  echo "Status: $STATUS"

  if [ "$STATUS" = "Confirmed" ] || [ "$STATUS" = "Failed" ]; then
    break
  fi

  sleep 2
done

# 4. Get final result
curl -s http://localhost:3000/relay/$JOB_ID | jq
```

---

## Performance

### Expected Improvements

| Environment | Normal Relay | Fast Relay | Improvement |
|-------------|--------------|------------|-------------|
| Local (no scraper) | ~11s | ~7-9s | 27-44% faster |
| Production (with scraper) | 29-78s | 6-15s | 75-85% faster |

### Bottlenecks Eliminated

- ❌ Scraper indexing (10-30s)
- ❌ Relayer indexing (10-30s)
- ❌ DB write/read cycles (1s+)
- ✅ Direct RPC fetch (< 1s)

### Fundamental Limits

- Destination block time: 6-12s (cannot be bypassed)
- ISM metadata building: 2-5s (validator signatures)
- These are blockchain/protocol limits, not relay API overhead

---

## Security Considerations

1. **Rate Limiting**: Prevents abuse, configurable per deployment
2. **No Authentication**: Designed for operator-controlled deployments
   - Use reverse proxy (nginx) for IP whitelisting if needed
   - Can add API key auth if required
3. **Input Validation**: All inputs validated before processing
4. **No Database Writes**: Jobs stored in memory only (1 hour TTL)
5. **Deduplication**: Safe to submit same message multiple times

---

## Troubleshooting

### Job Status Stuck on "Extracting"

**Cause**: RPC issues or transaction not found
**Solution**: Check origin chain RPC is accessible and transaction is confirmed

### Job Status "Failed" with "Chain not found"

**Cause**: Chain name doesn't match relayer configuration
**Solution**: Use exact chain name from relayer config (case-sensitive)

### Job Returns 404

**Cause**: Job expired (> 1 hour old) or never existed
**Solution**: Jobs expire after 1 hour; create a new job

### No Response from API

**Cause**: Relay API not enabled
**Solution**: Set `HYPERLANE_RELAYER_RELAY_API_ENABLED=true`

---

## Advanced Topics

### Custom MailboxIndexer Implementation

To add support for a new protocol type:

```rust
use hyperlane_core::{ChainResult, HyperlaneMessage};
use crate::relay_api::MailboxIndexer;

pub struct MyChainIndexer {
    // Chain-specific client/provider
    domain: u32,
}

#[async_trait::async_trait]
impl MailboxIndexer for MyChainIndexer {
    async fn fetch_logs_by_tx_hash(&self, tx_hash: &str) -> ChainResult<Vec<HyperlaneMessage>> {
        // 1. Parse tx_hash (protocol-specific format)
        // 2. Query transaction from chain
        // 3. Extract Hyperlane Dispatch events
        // 4. Parse HyperlaneMessage(s)
        // 5. Return messages
        todo!()
    }

    fn domain(&self) -> u32 {
        self.domain
    }
}
```

Then register it in the ProviderRegistry during relayer startup.

---

## Support

For issues or questions:
- Check logs for detailed error messages
- Verify chain names match relayer configuration
- Ensure transaction contains Hyperlane Dispatch event
- Test with smaller examples first

## Related Documentation

- [Fast Relay Implementation Plan](/.claude/plans/enchanted-whistling-candle.md)
- [Hyperlane Message Flow](https://docs.hyperlane.xyz/)
