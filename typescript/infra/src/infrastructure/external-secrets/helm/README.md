# `external-secrets-gcp`

## Overview

This Helm chart contains some resources that allow other workloads on the cluster to access secrets from GCP secret manager. The out-of-the-box `external-secrets` Helm chart ([see here](https://external-secrets.io/v0.4.4/guides-getting-started/)) should also be deployed on the cluster prior to this chart being deployed. The resources in this chart generally follow the external-secrets documentation for using GCP Secret Manager ([see here](https://external-secrets.io/v0.4.4/provider-google-secrets-manager/)).

This chart has two resources:

- `gcp-sa-secret.yaml` - This is a vanilla opaque Secret that contains the keys to a service account with the `roles/secretmanager.secretAccessor` role granted.
- `cluster-secret-store.yaml` - This is a [ClusterSecretStore](https://external-secrets.io/v0.4.4/api-clustersecretstore/), which is an external-secrets CRD that can be used by [ExternalSecret](https://external-secrets.io/v0.4.4/api-externalsecret/)s in any namespace on the cluster to access GCP Secret Manager secrets. This resource uses the service account credentials in the `gcp-sa-secret.yaml` Secret to interact with GCP.

### Future work

#### Restricting which secrets in a project can be accessed

As of now, the GCP service account that's used by the ClusterSecretStore to access GCP Secret Manager secrets can get any secret. This means that anyone with the ability to deploy infrastructure on the cluster can read all secrets. We should consider restricting which secrets that an environment's service account can access-- e.g. all secrets prefixed by the environment, or possibly a curated list.

#### GCP service accounts vs workload identity

GCP service account credentials are static and long-living, which is really unattractive. The leading alternative is workload identity, which doesn't require static and long-living credentials. For now, the GCP service account approach was used for the following reasons:

1. The existing mainnet cluster does not support workload identity. It doesn't seem like a big lift to change the cluster to support workload identity, but it was desireable to avoid a disruption by making large changes to the infrastructure.
2. Workload identity has some less-than-attractive features, like [identity sameness](https://cloud.google.com/kubernetes-engine/docs/concepts/workload-identity), which essentially requires putting sensitive workloads in their own GCP project.

Regardless, workload identities are a more attractive long-term option, and moving to them should be relatively easy.

## What is external-secrets?

The [documentation](https://external-secrets.io/v0.4.4/) is the best source. In short, it allows Kuberenetes Secrets to get their secrets from an external secret provided (like GCP's Secret Manager), all without a developer/deployer needing to touch the secrets themselves.

The general idea is there are `SecretStore`s (or `ClusterSecretStore`s, which are the cluster-wide version), that specify how the cluster can authenticate with the external secret provider. `ExternalSecret`s can then be specified in "application" infrastructure, which allow developers to specify a template for a Secret that will be created using the secret values from the external provider (& using the credentials from the SecretStore).

