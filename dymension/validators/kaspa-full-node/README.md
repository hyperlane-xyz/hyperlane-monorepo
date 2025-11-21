This document describes how to run a Kaspa full node on a remote machine. Assume the execution of all commands on the remote machine.

- [Running a Kaspa full node as a Docker container](#running-a-kaspa-full-node-as-a-docker-container)
- [Running a Kaspa full node as a Kubernetes deployment](#running-a-kaspa-full-node-as-a-kubernetes-deployment)


## Running a Kaspa full node as a Docker container

1. Install Docker

```bash
sudo apt-get update
sudo apt-get install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository to Apt sources:
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  
sudo apt-get update

sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin -y

docker version
sudo usermod -aG docker $USER
sudo service docker restart
```

2. Download the `simply-kaspa-indexer` repository

```bash
cd $HOME
git clone https://github.com/supertypo/simply-kaspa-indexer
cd simply-kaspa-indexer
#git checkout 0e33b5
git checkout v1.6.0-beta1
```

3. Create a `docker-compose.yaml` file

```yaml
volumes:
  kaspa_db_data:

services:
  kaspa_explorer:
    container_name: kaspa_explorer
    image: supertypo/kaspa-explorer:latest
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      API_URI: http://localhost:8000
      API_WS_URI: ws://localhost:8001

  kaspa_rest_server:
    container_name: kaspa_rest_server
    image: kaspanet/kaspa-rest-server:latest
    restart: unless-stopped
    environment:
      KASPAD_HOST_1: kaspad:16210
      SQL_URI: postgresql+asyncpg://postgres:postgres@kaspa_db:5432/postgres
      NETWORK_TYPE: testnet
    ports:
      - "0.0.0.0:8000:8000"

  simply_kaspa_socket_server:
    container_name: simply_kaspa_socket_server
    image: supertypo/simply-kaspa-socket-server:unstable
    restart: unless-stopped
    environment:
      NETWORK_TYPE: testnet
    ports:
      - "0.0.0.0:8001:8000"
    command: -x 20 -s ws://kaspad:17210 --network testnet-10

  simply_kaspa_indexer:
    container_name: simply_kaspa_indexer
    image: supertypo/simply-kaspa-indexer:latest
    restart: unless-stopped
    command: -u -s ws://kaspad:17210 -d postgresql://postgres:postgres@kaspa_db:5432/postgres --network testnet-10

  kaspad:
    container_name: kaspad
    image: supertypo/rusty-kaspad:latest
    restart: unless-stopped
    ports:
      - "0.0.0.0:16210:16210"
      - "0.0.0.0:17210:17210"
    volumes:
      - /var/kaspad:/app/data/
    command: kaspad --yes --nologfiles --disable-upnp --utxoindex --rpclisten=0.0.0.0:16210 --rpclisten-borsh=0.0.0.0:17210  --testnet --netsuffix=10

  kaspa_db:
    container_name: kaspa_db
    image: postgres:16-alpine
    restart: unless-stopped
    shm_size: 10G
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: postgres
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - kaspa_db_data:/var/lib/postgresql/data
```

4. Start the full node

```bash
docker compose up -d
```

## Running a Kaspa full node as a Kubernetes deployment

`kubernetes` contains a kustomize configuration to deploy a Kaspa full node as a Kubernetes deployment. It assumes a deployment to a GCP K8s, adjust the persistent volume claims depending on your needs.

the overlay's `kaspad-patch.yaml` patch controls which network the full node deployment will target. Specifically:

```
  - --testnet
  - --netsuffix=10
```

After updating the `kubernetes/base` to meet your needs, things to update according to your needs are:

- The Storage Class for postgres statefulset
- The Storage Class for kaspad statefulset

you can deploy the full node to your K8s cluster by running:

```bash
kubectl apply -k kubernetes/overlays/testnet/
```

or

```bash
kubectl apply -k kubernetes/overlays/mainnet/
```