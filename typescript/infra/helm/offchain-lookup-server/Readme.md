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
- `env-var-external-secret.yaml`: Fetches all required secrets from Google Cloud Secrets.

### Secret Management

All secret variables are stored in a Google Cloud Secret. The format of this
Secret is JSON. Inside the `values.yaml` one can list the keys from there.
The JSON format must be of the form key:string and must not contain nested objects.

Secrets for testnet must be prefixed `hyperlane-testnet4`. Otherwise the
Cluster Secret Store does not have the necessary permissions to access the secret.

## Testnet

The testnet deployment can be found at: \
https://testnet-offchain-lookup.services.hyperlane.xyz

**Deploy**

```shell
helm upgrade --install offchain-lookup-server . -f values.yaml -f values-testnet.yaml --namespace testnet4
```

## Mainnet

_Not deployed yet_
