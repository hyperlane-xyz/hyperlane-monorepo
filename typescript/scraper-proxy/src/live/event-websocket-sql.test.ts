import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  gasPaymentColumns,
  gasPaymentMetadataJoins,
} from './event-websocket.js';

void describe('gas payment SQL helpers', () => {
  void it('qualifies payment columns and aliases transaction and block metadata', () => {
    assert.equal(
      gasPaymentColumns({
        columns: ['id', 'tx_id', 'payment'],
        domain: 'domain',
        projection: 'unused unqualified projection',
        table: 'gas_payment',
      }),
      '"event_row"."id", "event_row"."tx_id", "event_row"."payment", ' +
        '"event_transaction"."hash" AS "origin_tx_hash", ' +
        '"event_block"."hash" AS "origin_block_hash", ' +
        '"event_block"."height" AS "origin_block_height"',
    );
  });

  void it('uses inner joins by default', () => {
    assert.equal(
      gasPaymentMetadataJoins(),
      ' INNER JOIN "transaction" AS "event_transaction" ON "event_transaction"."id" = "event_row"."tx_id"' +
        ' INNER JOIN "block" AS "event_block" ON "event_block"."id" = "event_transaction"."block_id"',
    );
  });

  void it('uses left joins for both optional metadata relations', () => {
    assert.equal(
      gasPaymentMetadataJoins('LEFT JOIN'),
      ' LEFT JOIN "transaction" AS "event_transaction" ON "event_transaction"."id" = "event_row"."tx_id"' +
        ' LEFT JOIN "block" AS "event_block" ON "event_block"."id" = "event_transaction"."block_id"',
    );
  });
});
