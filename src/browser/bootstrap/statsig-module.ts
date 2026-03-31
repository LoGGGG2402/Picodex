export function installBootstrapStatsigModule(args: {
  backgroundSubagentsStatsigGate: string;
  statsigClassPatchMark: string;
  statsigInstancePatchMark: string;
}): {
  installStatsigBackgroundSubagentsOverride: () => void;
} {
  const {
    backgroundSubagentsStatsigGate,
    statsigClassPatchMark,
    statsigInstancePatchMark,
  } = args;

  function installStatsigBackgroundSubagentsOverride(): void {
    const host = globalThis as typeof globalThis & {
      __STATSIG__?: Record<string, unknown>;
    };
    const statsigGlobal =
      host.__STATSIG__ && typeof host.__STATSIG__ === "object" ? host.__STATSIG__ : {};
    host.__STATSIG__ = statsigGlobal;

    let statsigClientValue = patchStatsigClientClass(statsigGlobal.StatsigClient);
    patchStatsigInstances(statsigGlobal);

    Object.defineProperty(statsigGlobal, "StatsigClient", {
      configurable: true,
      enumerable: true,
      get: () => statsigClientValue,
      set: (value: unknown) => {
        statsigClientValue = patchStatsigClientClass(value);
        patchStatsigInstances(statsigGlobal);
      },
    });
  }

  function patchStatsigClientClass(value: unknown): unknown {
    if (typeof value !== "function") {
      return value;
    }

    const statsigClientClass = value as (Function & {
      prototype?: Record<string, unknown>;
      [statsigClassPatchMark]?: boolean;
    });
    if (statsigClientClass[statsigClassPatchMark]) {
      return value;
    }

    const prototype =
      statsigClientClass.prototype && typeof statsigClientClass.prototype === "object"
        ? statsigClientClass.prototype
        : null;
    if (!prototype) {
      return value;
    }

    patchStatsigClientLike(prototype, statsigClassPatchMark);
    statsigClientClass[statsigClassPatchMark] = true;
    return value;
  }

  function patchStatsigInstances(statsigGlobal: Record<string, unknown>): void {
    patchStatsigClientLike(statsigGlobal.firstInstance, statsigInstancePatchMark);

    const instances =
      statsigGlobal.instances && typeof statsigGlobal.instances === "object"
        ? statsigGlobal.instances
        : null;
    if (!instances) {
      return;
    }

    for (const instance of Object.values(instances)) {
      patchStatsigClientLike(instance, statsigInstancePatchMark);
    }
  }

  function patchStatsigClientLike(target: unknown, markKey: string): void {
    if (!target || typeof target !== "object") {
      return;
    }

    const client = target as Record<string, unknown> & { [key: string]: unknown };
    if (client[markKey] === true) {
      return;
    }

    const originalCheckGate = typeof client.checkGate === "function" ? client.checkGate : null;
    if (originalCheckGate) {
      client.checkGate = function (this: unknown, gateName: unknown, ...args: unknown[]) {
        if (gateName === backgroundSubagentsStatsigGate) {
          return true;
        }
        return originalCheckGate.apply(this, [gateName, ...args]);
      };
    }

    const originalGetFeatureGate =
      typeof client.getFeatureGate === "function" ? client.getFeatureGate : null;
    if (originalGetFeatureGate) {
      client.getFeatureGate = function (this: unknown, gateName: unknown, ...args: unknown[]) {
        const result = originalGetFeatureGate.apply(this, [gateName, ...args]);
        if (gateName !== backgroundSubagentsStatsigGate) {
          return result;
        }
        if (result && typeof result === "object") {
          return {
            ...(result as Record<string, unknown>),
            value: true,
          };
        }
        return {
          name: backgroundSubagentsStatsigGate,
          value: true,
        };
      };
    }

    client[markKey] = true;
  }

  return {
    installStatsigBackgroundSubagentsOverride,
  };
}
