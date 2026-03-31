export function debugLog(scope: string, message: string, details?: unknown): void {
  if (!process.env.POCODEX_DEBUG) {
    return;
  }

  const prefix = `[pocodex:${scope}] ${message}`;
  if (details === undefined) {
    console.log(prefix);
    return;
  }

  try {
    console.log(prefix, JSON.stringify(details));
  } catch {
    console.log(prefix, String(details));
  }
}

const warnedLogKeys = new Set<string>();

export function warnOnceLog(
  scope: string,
  key: string,
  message: string,
  details?: unknown,
): void {
  const normalizedKey = `${scope}:${key}`;
  if (warnedLogKeys.has(normalizedKey)) {
    return;
  }
  warnedLogKeys.add(normalizedKey);

  const prefix = `[pocodex:${scope}] ${message}`;
  if (details === undefined) {
    console.warn(prefix);
    return;
  }

  try {
    console.warn(prefix, JSON.stringify(details));
  } catch {
    console.warn(prefix, String(details));
  }
}
