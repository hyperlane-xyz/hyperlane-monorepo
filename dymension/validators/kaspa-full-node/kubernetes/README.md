> generated

# Kaspa Node Kubernetes Deployment

This directory contains Kustomize configurations for deploying a Kaspa blockchain node infrastructure on Kubernetes.

## Architecture

The deployment includes:
- **kaspad**: Kaspa blockchain node (StatefulSet with persistent volumes)
- **kaspa-db**: PostgreSQL database (StatefulSet with persistent volumes)
- **kaspa-rest-server**: REST API server
- **simply-kaspa-indexer**: Blockchain indexer
- **simply-kaspa-socket-server**: WebSocket server
- **kaspa-explorer**: Web UI explorer

## Directory Structure

```
kubernetes/
├── base/                           # Base configuration
│   ├── kustomization.yaml
│   ├── namespace.yaml
│   ├── kaspad-statefulset.yaml
│   ├── postgres-statefulset.yaml
│   ├── deployments.yaml
│   ├── services.yaml
│   └── configmap.yaml
└── overlays/
    ├── testnet/                    # Testnet configuration
    │   ├── kustomization.yaml
    │   ├── namespace.yaml
    │   └── kaspad-patch.yaml
    └── mainnet/                    # Mainnet configuration
        ├── kustomization.yaml
        ├── namespace.yaml
        └── kaspad-patch.yaml
```

## Features

### StatefulSets with Persistent Volumes
- Each kaspad pod gets its own persistent volume claim (500Gi)
- PostgreSQL uses persistent storage (200Gi)
- Pods are named deterministically: `kaspad-0`, `kaspad-1`, `kaspad-2`, etc.

### Environment-Specific Overlays

**Testnet:**
- Namespace: `kaspa-node-testnet`
- 2 kaspad replicas
- Configured for testnet-10

**Mainnet:**
- Namespace: `kaspa-node-mainnet`
- 5 kaspad replicas
- Configured for mainnet

## Prerequisites

1. Kubernetes cluster with:
   - StorageClass `standard-rwo` configured (GCP persistent disks)
   - Sufficient resources for running blockchain nodes
   - kubectl configured to access your cluster

2. Kustomize installed (or use `kubectl apply -k`)

## Deployment

### Deploy to Testnet

```bash
kubectl apply -k overlays/testnet/
```

### Deploy to Mainnet

```bash
kubectl apply -k overlays/mainnet/
```

### Verify Deployment

```bash
# Check testnet resources
kubectl get all -n kaspa-node-testnet

# Check mainnet resources
kubectl get all -n kaspa-node-mainnet

# Check persistent volume claims
kubectl get pvc -n kaspa-node-testnet
kubectl get pvc -n kaspa-node-mainnet
```

### View Logs

```bash
# View kaspad logs (testnet)
kubectl logs -n kaspa-node-testnet kaspad-0 -f

# View indexer logs
kubectl logs -n kaspa-node-testnet -l app=simply-kaspa-indexer -f
```

## Storage Configuration

Each kaspad pod uses a separate persistent volume claim. This means:
- `kaspad-0` uses `kaspad-data-kaspad-0`
- `kaspad-1` uses `kaspad-data-kaspad-1`
- And so on...

These are automatically created by the StatefulSet and backed by GCP persistent disks (or your configured StorageClass).

## Accessing Services

Services are exposed internally within the cluster:
- Kaspa Explorer: `http://kaspa-explorer:8080`
- REST API: `http://kaspa-rest-server:8000`
- WebSocket: `ws://simply-kaspa-socket-server:8001`
- kaspad RPC: `kaspad:16210` and `kaspad:17210`

To expose externally, you can:
1. Create an Ingress resource
2. Use LoadBalancer service type
3. Use `kubectl port-forward`

Example port-forward:
```bash
kubectl port-forward -n kaspa-node-testnet svc/kaspa-explorer 8080:8080
```

## Resource Requirements

Default resource allocations:
- **kaspad**: 2-4 CPU, 4-8Gi memory, 500Gi storage
- **PostgreSQL**: 1-2 CPU, 2-10Gi memory, 200Gi storage
- **REST server**: 250m-1 CPU, 512Mi-1Gi memory
- **Indexer**: 250m-1 CPU, 512Mi-1Gi memory
- **Socket server**: 100m-500m CPU, 256Mi-512Mi memory
- **Explorer**: 100m-500m CPU, 256Mi-512Mi memory

## Customization

To customize the deployment:

1. Edit the base configuration in `base/`
2. Add environment-specific patches in `overlays/testnet/` or `overlays/mainnet/`
3. Modify resource requests/limits as needed
4. Update storage sizes in the StatefulSet definitions

## Scaling

To change the number of kaspad replicas:

Edit the `replicas` field in the overlay's `kustomization.yaml`:

```yaml
replicas:
  - name: kaspad
    count: 3  # Change to desired number
```

Then reapply:
```bash
kubectl apply -k overlays/testnet/
```

## Cleanup

```bash
# Delete testnet deployment
kubectl delete -k overlays/testnet/

# Delete mainnet deployment
kubectl delete -k overlays/mainnet/

# Note: PVCs are not automatically deleted. To delete them:
kubectl delete pvc -n kaspa-node-testnet --all
kubectl delete pvc -n kaspa-node-mainnet --all
```

## Monitoring

Recommended monitoring:
- Check kaspad sync status via RPC
- Monitor PostgreSQL connection pool and queries
- Track resource usage (CPU/memory/disk)
- Monitor blockchain height and sync progress

## Troubleshooting

### Pod not starting
```bash
kubectl describe pod -n kaspa-node-testnet kaspad-0
kubectl logs -n kaspa-node-testnet kaspad-0
```

### PVC not binding
```bash
kubectl get pvc -n kaspa-node-testnet
kubectl describe pvc -n kaspa-node-testnet kaspad-data-kaspad-0
```

### Database connection issues
```bash
kubectl logs -n kaspa-node-testnet -l app=kaspa-rest-server
kubectl exec -n kaspa-node-testnet kaspa-db-0 -- psql -U postgres -c "\l"
```

## Notes

- The PostgreSQL shared memory size is configured via environment variables (10GB limit)
- kaspad stores blockchain data in `/app/data/` which is mounted to the PVC
- The setup uses headless services for StatefulSets to provide stable DNS names
- Each environment (testnet/mainnet) runs in its own namespace for isolation
