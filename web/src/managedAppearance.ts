type NativeAppearance = {
  read(): unknown;
  write(value: string): unknown;
};
declare global {
  interface Window {
    openbotAppearance?: NativeAppearance;
  }
}
export type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem'> & {
  readonly available?: boolean;
};

/** The native bridge owns one local-workspace preference, never arbitrary browser storage. */
export function managedAppearanceStorage(
  key: string,
  valid: (raw: string) => boolean,
): AppearanceStorage | undefined {
  if (typeof window === 'undefined' || !window.openbotAppearance) return;
  const bridge = window.openbotAppearance;
  let value: string | null = null,
    available = false;
  const bounded = (raw: unknown): raw is string =>
    typeof raw === 'string' && new TextEncoder().encode(raw).length <= 2048;
  const persist = (raw: string) => {
    value = raw;
    available = false;
    if (!bounded(raw) || !valid(raw)) throw Error('Invalid appearance');
    const result = bridge.write(raw) as { available?: unknown } | undefined;
    available = result?.available === true;
    if (!available) throw Error('Appearance could not be saved');
  };
  try {
    const saved = bridge.read() as { value?: unknown; available?: unknown } | undefined;
    if (
      !saved ||
      typeof saved.available !== 'boolean' ||
      (saved.value !== null && (!bounded(saved.value) || !valid(saved.value)))
    )
      throw Error('Invalid appearance response');
    value = saved.value;
    available = saved.available;
    // A native value wins over this port's old preference. Migrate only this exact key.
    if (value === null && available) {
      let legacy: string | null = null;
      try {
        legacy = window.localStorage.getItem(key);
      } catch {
        /* Native storage remains usable. */
      }
      if (bounded(legacy) && valid(legacy)) persist(legacy);
    }
  } catch {
    available = false;
  }
  return {
    get available() {
      return available;
    },
    getItem(name) {
      return name === key ? value : null;
    },
    setItem(name, raw) {
      if (name !== key) throw Error('Unsupported preference');
      persist(raw);
    },
  };
}
