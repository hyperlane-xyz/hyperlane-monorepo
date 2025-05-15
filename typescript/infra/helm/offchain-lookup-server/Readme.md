# Offchain-Lookup-Server

Deploys the offchain-lookup-server which is needed for the ccip-read ISM
to the Kubernetes Cluster.
It provides two environments:

- testnet -> `hyperlane-testnet`
- prod -> `hyperlane-mainnet`

The SSL Certificate is managed by Google. The public IP addresses are globally
reserved using the CloudConsole.

The Ip addresses need to be added to Cloudflare manually.

For server documentation look at: `/typescript/ccip-server`

## Structure

- `deployment.yaml`: Contains the container with the typescript offchain lookup server
- `ingress.yaml`: Google Ingress for loadbalancing and https
- `managed-cert.yaml`: Configuring SSL certificate
- `service.yaml`: Forwarding from the Ingress to the deployment

## Testnet

The testnet deployment can be found at: \
https://testnet-offchain-lookup.services.hyperlane.xyz

## Mainnet

_Not deployed yet_
