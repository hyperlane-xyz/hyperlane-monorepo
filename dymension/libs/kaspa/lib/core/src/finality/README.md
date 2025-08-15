Here is my suggestion:
Iterate get_virtual_chain_from_block(start_hash) - contains accepted_transaction_ids(block hash, txids), as well as removed_chain_block_hashes. Keep track of the accepting_block_hash for each txid and consider txs rejected whenever their accepting_block_hash is in removed_chain_block_hashes. (Make sure to process removed before accepted)
subscribe to SinkBlueScoreChanged (or pull get_sink_blue_score()) - to keep track of the current blue score
look up blue score of accepting block using get_block(accepting block hash) compare it to sink blue score for confirmation counter.
Re: the actual number of confirmations (blue score diff) you should require, it's up to you to decide. Go for some number above 120. Expect the diff to increase by ~10 for each second.

The above will give you an accurate view of tx acceptance. To get block and tx details you will also need to iterate get_blocks(low_hash).
You can take a look at https://github.com/supertypo/simply-kaspa-indexer it keeps track of all block/tx details as well as acceptance data in a sql database. 
