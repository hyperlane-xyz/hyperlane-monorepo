CREATE ROLE repair_test_writer LOGIN PASSWORD 'test';
INSERT INTO domain(id,time_updated,name,native_token,chain_id,is_test_net,is_deprecated)
VALUES(2,now(),'repair-other','ETH',2,true,false);
INSERT INTO scraper_head(domain,start_height,indexed_height,indexed_hash,head_height,confirmed_height,mailbox,merkle_tree_hook,interchain_gas_paymaster,halted)
VALUES(1,0,10,decode(repeat('08',32),'hex'),10,8,decode(repeat('01',20),'hex'),decode(repeat('02',20),'hex'),decode(repeat('03',20),'hex'),true);
INSERT INTO block(id,domain,height,hash,timestamp) VALUES
 (101,1,5,decode(repeat('05',32),'hex'),to_timestamp(1000)),
 (102,1,8,decode(repeat('08',32),'hex'),to_timestamp(1001)),
 (103,2,8,decode(repeat('07',32),'hex'),to_timestamp(1001));
INSERT INTO scraper_checkpoint(domain,height,hash,timestamp) VALUES
 (1,8,decode(repeat('08',32),'hex'),to_timestamp(1001)),
 (1,10,decode(repeat('08',32),'hex'),to_timestamp(1001));
INSERT INTO "transaction"(id,hash,block_id,gas_limit,nonce,sender,gas_used,cumulative_gas_used)
VALUES(101,decode(repeat('11',32),'hex'),102,1,0,decode(repeat('01',20),'hex'),1,1);
INSERT INTO raw_message_dispatch(msg_id,origin_tx_hash,origin_block_hash,origin_block_height,nonce,origin_domain,destination_domain,sender,recipient,origin_mailbox)
VALUES(decode(repeat('aa',32),'hex'),decode(repeat('11',32),'hex'),decode(repeat('08',32),'hex'),8,0,1,2,decode(repeat('01',20),'hex'),decode(repeat('01',20),'hex'),decode(repeat('01',20),'hex'));
INSERT INTO message(msg_id,origin,destination,nonce,sender,recipient,origin_mailbox,origin_tx_id) VALUES
 (decode(repeat('aa',32),'hex'),1,2,0,decode(repeat('01',20),'hex'),decode(repeat('01',20),'hex'),decode(repeat('01',20),'hex'),NULL),
 (decode(repeat('bb',32),'hex'),1,1,0,decode(repeat('01',20),'hex'),decode(repeat('01',20),'hex'),decode(repeat('04',20),'hex'),101);
INSERT INTO delivered_message(msg_id,domain,destination_mailbox,destination_tx_id,block_number) VALUES
 (decode(repeat('aa',32),'hex'),1,decode(repeat('01',20),'hex'),NULL,8),
 (decode(repeat('bb',32),'hex'),1,decode(repeat('04',20),'hex'),101,NULL);
INSERT INTO gas_payment(domain,origin,destination,msg_id,payment,gas_amount,tx_id,log_index,interchain_gas_paymaster,block_number) VALUES
 (1,1,2,decode(repeat('aa',32),'hex'),123456789012345678901234567890123456789,1,101,0,decode(repeat('03',20),'hex'),8),
 (2,2,1,decode(repeat('cc',32),'hex'),1,1,NULL,0,decode(repeat('03',20),'hex'),8);
SELECT assign_confirmed_gas_payment_cursors(1,0,8);
INSERT INTO merkle_tree_insertion(domain,merkle_tree_hook,leaf_index,message_id,block_number)
VALUES(1,decode(repeat('02',20),'hex'),0,decode(repeat('aa',32),'hex'),8);
INSERT INTO cursor(domain,height,event_type) VALUES(1,10,'ccr_swap');
