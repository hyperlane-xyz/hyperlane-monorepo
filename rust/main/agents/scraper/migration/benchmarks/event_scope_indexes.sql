CREATE TABLE delivered_message (id bigint PRIMARY KEY, domain int NOT NULL, destination_mailbox bytea NOT NULL, payload bytea NOT NULL);
CREATE INDEX delivery_scope ON delivered_message(domain,destination_mailbox);
INSERT INTO delivered_message SELECT n, CASE WHEN n<=100000 THEN 1 ELSE 2 END, decode(repeat('01',32),'hex'), decode(repeat('ab',256),'hex') FROM generate_series(1,1000000) n;
VACUUM ANALYZE delivered_message;
\echo BEFORE DELIVERY MAX
EXPLAIN (ANALYZE, BUFFERS) SELECT MAX(id) FROM delivered_message WHERE domain=1 AND destination_mailbox=decode(repeat('01',32),'hex');
\echo BEFORE DELIVERY COUNT
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM delivered_message WHERE domain=1 AND destination_mailbox=decode(repeat('01',32),'hex') AND id>99000;
CREATE INDEX CONCURRENTLY delivered_message_domain_mailbox_id_idx ON delivered_message(domain,destination_mailbox,id);
\echo AFTER DELIVERY MAX
EXPLAIN (ANALYZE, BUFFERS) SELECT MAX(id) FROM delivered_message WHERE domain=1 AND destination_mailbox=decode(repeat('01',32),'hex');
\echo AFTER DELIVERY COUNT
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM delivered_message WHERE domain=1 AND destination_mailbox=decode(repeat('01',32),'hex') AND id>99000;
SELECT relname,pg_size_pretty(pg_relation_size(oid)) FROM pg_class WHERE relname IN ('delivered_message_domain_mailbox_id_idx');
