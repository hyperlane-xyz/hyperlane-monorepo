export function verifyScale(configMap: Record<string, any>): boolean {
  if (!areDecimalsUniform(configMap)) {
    const maxDecimals = Math.max(
      ...Object.values(configMap).map((config) => config.decimals!),
    );

    for (const [_, config] of Object.entries(configMap)) {
      if (config.decimals) {
        const scale = 10 ** (maxDecimals - config.decimals);
        if (
          (!config.scale && scale !== 1) ||
          (config.scale && scale !== config.scale)
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

function areDecimalsUniform(configMap: Record<string, any>): boolean {
  const values = [...Object.values(configMap)];
  const [first, ...rest] = values;
  for (const d of rest) {
    if (d.decimals !== first.decimals) {
      return false;
    }
  }
  return true;
}
