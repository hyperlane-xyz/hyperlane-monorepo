let nextPort = 8600;
const allocatedPorts = new Set<number>();

export function allocatePort(): number {
  while (allocatedPorts.has(nextPort)) {
    nextPort++;
  }
  const port = nextPort++;
  allocatedPorts.add(port);
  return port;
}

export function releasePort(port: number): void {
  allocatedPorts.delete(port);
}

export function allocatePorts(count: number): number[] {
  return Array.from({ length: count }, () => allocatePort());
}

export function releasePorts(ports: number[]): void {
  ports.forEach(releasePort);
}
