export function isUrl(value: string) {
  try {
    const url = new URL(value);
    return !!url.hostname;
  } catch (error) {
    return false;
  }
}

export function isHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch (error) {
    return false;
  }
}
