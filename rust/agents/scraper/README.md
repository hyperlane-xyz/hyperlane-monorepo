For local testing, setup a postgres database with

```bash
docker run --name scraper -e POSTGRES_PASSWORD=47221c18c610 -p 5432:5432 -d postgres

# optionally to connect
docker exec -it scraper /usr/bin/psql -U postgres

# and to shutdown
docker stop scraper
docker rm -v scraper
```

To init the database, run from `rust` dir

```bash
cargo run --package migration --bin init-db --features tracing,tracing-subscriber
```
