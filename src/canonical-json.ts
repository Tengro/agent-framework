function normalizeCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeCanonicalJson(entry));
  }
  if (value && typeof value === 'object') {
    const withToJson = value as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === 'function') {
      return normalizeCanonicalJson(withToJson.toJSON());
    }
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = normalizeCanonicalJson((value as Record<string, unknown>)[key]);
      if (child !== undefined) normalized[key] = child;
    }
    return normalized;
  }
  return value;
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJson(value)) ?? 'null';
}
