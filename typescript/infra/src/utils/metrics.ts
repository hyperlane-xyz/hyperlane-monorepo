import { Pushgateway, Registry } from 'prom-client';

function getPushGateway(register: Registry): Pushgateway | null {
  const gatewayAddr = process.env['PROMETHEUS_PUSH_GATEWAY'];
  if (gatewayAddr) {
    return new Pushgateway(gatewayAddr, [], register);
  } else {
    console.warn(
      'Prometheus push gateway address was not defined; not publishing metrics.',
    );
    return null;
  }
}

export async function submitMetrics(
  register: Registry,
  jobName: string,
  options?: { appendMode?: boolean },
) {
  const gateway = getPushGateway(register);
  if (!gateway) return;

  let resp;
  if (options?.appendMode) {
    resp = (await gateway.pushAdd({ jobName })).resp;
  } else {
    resp = (await gateway.push({ jobName })).resp;
  }

  const statusCode =
    typeof resp == 'object' && resp != null && 'statusCode' in resp
      ? (resp as any).statusCode
      : 'unknown';
  console.log(
    `Prometheus metrics pushed to PushGateway with status ${statusCode}`,
  );
}
