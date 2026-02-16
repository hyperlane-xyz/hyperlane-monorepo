# External Secrets Infrastructure

This directory contains the infrastructure code for deploying and managing external-secrets in the Hyperlane infrastructure.

## Overview

External-secrets is used to access secrets in GCP Secret Manager via Kubernetes secrets. The deployment consists of two parts:

1. **Core external-secrets release**: Deploys the external-secrets operator with CRDs and webhook
2. **GCP-specific chart**: Deploys environment-specific resources for GCP Secret Manager integration

## CA Bundle Patching

### Problem

The external-secrets Helm chart deploys CRDs with webhook conversion strategies that require proper TLS certificate validation. Without the correct CA bundle, the webhook cannot validate incoming requests, leading to:

- GCP console warnings about invalid TLS certificates
- Potential webhook failures
- Security concerns

### Solution

The deployment automatically patches the external-secrets CRDs with the correct CA bundle from the current Kubernetes cluster context. This ensures:

- Proper TLS certificate validation
- No more GCP console warnings
- Reliable webhook operation

### How It Works

1. **Automatic CA Bundle Retrieval**: The deployment retrieves the cluster's CA bundle using:

   ```bash
   kubectl config view --raw --minify --flatten -o jsonpath='{.clusters[0].cluster.certificate-authority-data}'
   ```

2. **CRD Patching**: The CA bundle is automatically applied to the relevant CRDs:

   - `externalsecrets.external-secrets.io`
   - `clusterexternalsecrets.external-secrets.io`

3. **Efficiency**: The system checks if patching is needed before applying, avoiding unnecessary operations.

## Usage

The deployment is handled by the `deploy-infra-external-secrets.ts` script:

```bash
npm run deploy-infra-external-secrets -- --environment <env>
```

## Troubleshooting

### CA Bundle Issues

If you encounter CA bundle related issues:

1. **Check cluster context**: Ensure you're connected to the correct cluster
2. **Verify CA bundle**: Check if the CA bundle was retrieved successfully
3. **Manual verification**: Verify the CRDs have the correct CA bundle:

   ```bash
   kubectl get crd externalsecrets.external-secrets.io -o jsonpath='{.spec.conversion.webhook.clientConfig.caBundle}'
   ```

### Webhook Issues

If the webhook is not working:

1. **Check deployment status**: Ensure the external-secrets-webhook deployment is ready
2. **Verify CRD patches**: Check that the CRDs have been patched with the CA bundle
3. **Check logs**: Review the webhook deployment logs for errors

## Future Improvements

- Consider upgrading to a newer version of external-secrets that supports webhook CA bundle configuration via Helm values
- Implement workload identity instead of static service account credentials
- Add more granular secret access controls
