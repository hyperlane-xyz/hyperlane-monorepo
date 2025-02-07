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
cargo run --package migration --bin init-db
```

To re-create the database, run from `rust` dir

```bash
cargo run --package migration --bin recreate-db
```

To re-generate the sea-orm entity code, when no database is running in docker and from the `rust` dir, run

```bash
cargo run --package migration --bin generate-entities
```

_Note:_ This will install sea-orm-cli, start a docker container for postgresql, and then replace the existing entities.
It will not work if docker is not setup or if anything is already bound on port 5432.
