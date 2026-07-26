export interface MemoryObserver {
  start(): void;
  stop(): void;
}

export interface MemoryObserverDependencies {
  memoryUsage: () => { rss: number; heapUsed: number; external: number };
  now: () => number;
  setInterval: (callback: () => void, delayMs: number) => { unref?: () => void };
  clearInterval: (timer: unknown) => void;
  serialize: (event: Record<string, unknown>) => string;
  write: (line: string) => void;
}

type MemoryPhase = 'start' | 'running' | 'end';
type MemorySample = { rssBytes: number; heapUsedBytes: number; externalBytes: number };

const SAMPLE_INTERVAL_MS = 5_000;

export function createMemoryObserver(overrides: Partial<MemoryObserverDependencies> = {}): MemoryObserver {
  const dependencies: MemoryObserverDependencies = {
    memoryUsage: process.memoryUsage,
    now: Date.now,
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: timer => clearInterval(timer as NodeJS.Timeout),
    serialize: JSON.stringify,
    write: line => process.stderr.write(line),
    ...overrides,
  };
  let started = false;
  let stopped = false;
  let timer: unknown;
  let peaks: MemorySample | undefined;

  const sample = (phase: MemoryPhase) => {
    try {
      const usage = dependencies.memoryUsage();
      const current = { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, externalBytes: usage.external };
      peaks = peaks ? {
        rssBytes: Math.max(peaks.rssBytes, current.rssBytes),
        heapUsedBytes: Math.max(peaks.heapUsedBytes, current.heapUsedBytes),
        externalBytes: Math.max(peaks.externalBytes, current.externalBytes),
      } : current;
      const event = { event: 'memory', phase, timestamp: dependencies.now(), ...current, ...(phase === 'end' ? { peakRssBytes: peaks.rssBytes, peakHeapUsedBytes: peaks.heapUsedBytes, peakExternalBytes: peaks.externalBytes } : {}) };
      dependencies.write(`${dependencies.serialize(event)}\n`);
    } catch {
      // Observability must never alter the command outcome.
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      sample('start');
      try {
        timer = dependencies.setInterval(() => sample('running'), SAMPLE_INTERVAL_MS);
        try { timer && typeof (timer as { unref?: () => void }).unref === 'function' && (timer as { unref: () => void }).unref(); } catch { /* isolated */ }
      } catch {
        // A failed scheduler leaves boundary samples available without a running sample.
      }
    },
    stop() {
      if (!started || stopped) return;
      stopped = true;
      try { if (timer !== undefined) dependencies.clearInterval(timer); } catch { /* isolated */ }
      sample('end');
    },
  };
}
