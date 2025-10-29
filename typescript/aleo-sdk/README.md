# Hyperlane Aleo SDK

To test the current implementation build the monorepo

```bash
yarn install
yarn build
cd typescript/aleo-sdk
```

To start a local aleo testnet run (needs to download 5GB image and after starting it can also take up to 5mins)

```bash
docker compose up
```

Verify the aleo node is running by visiting `http://localhost:3030/testnet/block/latest`.

Now run the aleo code

```
yarn node dist/index.js
```
