import { Server } from '@chainlink/ccip-read-server';

import {
  HyperlaneCore,
  commitmentFromIcaCalls,
  encodeIcaCalls,
  normalizeCalls,
} from '@hyperlane-xyz/sdk';

const server = new Server();

// TODO
// 1. Extract modules
// 2. Authenticate relayer
// 3. check commitment was dispatched to avoid ddosing the db
interface StoredCommitment {
  calls: { to: string; data: string; value?: string }[];
  salt: string;
  relayers: string[];
}

const commitments = new Map<string, StoredCommitment>();

const app = server.makeApp('/');
app.post('/calls', (req, res) => {
  const { calls, relayers, salt } = req.body;
  const commitmentKey = commitmentFromIcaCalls(calls, salt);
  commitments.set(commitmentKey, { calls, relayers, salt });
  console.log('Stored commitment', commitmentKey);
  res.sendStatus(200);
});

app.post('/getCallsFromCommitment', (req, res) => {
  // message is in the data
  const { data } = req.body;
  // TODO: Fix this after we fix it in the ISM
  // For now parse it from the wrong signature, treat bytes32 as bytes in getCallsFromCommitment(bytes32)
  const message = HyperlaneCore.parseDispatchedMessage(
    '0x' + data.slice(2 + 8 + 128),
  );
  const body = message.parsed.body;
  // Parse the commitment after skipping the first 32 bytes and the leading 0x
  const commitment = '0x' + body.slice(68, 132);

  const entry = commitments.get(commitment);
  if (!entry) {
    console.log('Commitment not found', commitment);
    res.status(404).json({ error: 'Commitment not found' });
    return;
  }
  const { calls, salt } = entry;
  const encoded = encodeIcaCalls(normalizeCalls(calls), salt);
  console.log('Serving calls for commitment', commitment);
  res.status(200).json({ data: encoded });
});

// Log and handle undefined endpoints
app.use((req, res) => {
  console.log(`Undefined request: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(3000, () => console.log(`Listening on port ${3000}`));
