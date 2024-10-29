export function isHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch (error) {
    return false;
  }
}
