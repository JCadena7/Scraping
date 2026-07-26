import { describe, expect, it, vi } from 'vitest';
import { createMemoryObserver } from '../src/jer/memory-observer.js';

type Sample = { rss: number; heapUsed: number; external: number };

function harness(samples: Sample[]) {
  const output: string[] = [];
  const callbacks: Array<() => void> = [];
  const clear = vi.fn();
  const unref = vi.fn();
  return {
    output,
    callbacks,
    clear,
    unref,
    observer: createMemoryObserver({
      memoryUsage: () => samples.shift() ?? { rss: 0, heapUsed: 0, external: 0 },
      now: (() => { let value = 1_000; return () => value += 1_000; })(),
      setInterval: callback => { callbacks.push(callback); return { unref }; },
      clearInterval: clear,
      write: line => { output.push(line); },
    }),
  };
}

describe('memory observer', () => {
  it('emits ordered JSONL samples every 5,000 ms and reports end-inclusive observed peaks', () => {
    const test = harness([
      { rss: 10, heapUsed: 2, external: 1 },
      { rss: 20, heapUsed: 3, external: 4 },
      { rss: 30, heapUsed: 5, external: 2 },
    ]);

    test.observer.start();
    test.callbacks[0]();
    test.observer.stop();

    const events = test.output.map(line => JSON.parse(line));
    expect(events).toEqual([
      { event: 'memory', phase: 'start', timestamp: 2_000, rssBytes: 10, heapUsedBytes: 2, externalBytes: 1 },
      { event: 'memory', phase: 'running', timestamp: 3_000, rssBytes: 20, heapUsedBytes: 3, externalBytes: 4 },
      { event: 'memory', phase: 'end', timestamp: 4_000, rssBytes: 30, heapUsedBytes: 5, externalBytes: 2, peakRssBytes: 30, peakHeapUsedBytes: 5, peakExternalBytes: 4 },
    ]);
    expect(test.unref).toHaveBeenCalledOnce();
    expect(test.clear).toHaveBeenCalledOnce();
  });

  it('supports short runs and idempotent lifecycle calls', () => {
    const test = harness([{ rss: 7, heapUsed: 6, external: 5 }, { rss: 4, heapUsed: 3, external: 2 }]);

    test.observer.start();
    test.observer.start();
    test.observer.stop();
    test.observer.stop();

    expect(test.output.map(line => JSON.parse(line).phase)).toEqual(['start', 'end']);
    expect(test.clear).toHaveBeenCalledOnce();
  });

  it('swallows provider, clock, scheduler, serialization, writer, unref, and clear failures', () => {
    const write = vi.fn(() => { throw new Error('writer'); });
    const observer = createMemoryObserver({
      memoryUsage: () => { throw new Error('provider'); },
      now: () => { throw new Error('clock'); },
      setInterval: () => { throw new Error('scheduler'); },
      clearInterval: () => { throw new Error('clear'); },
      write,
    });

    expect(() => observer.start()).not.toThrow();
    expect(() => observer.stop()).not.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it('does not emit or throw when JSON serialization fails after a valid sample', () => {
    const write = vi.fn();
    const observer = createMemoryObserver({
      memoryUsage: () => ({ rss: 1, heapUsed: 2, external: 3 }),
      now: () => 1,
      setInterval: () => ({ unref: () => undefined }),
      clearInterval: () => undefined,
      write,
      serialize: () => { throw new Error('serialization'); },
    } as never);

    expect(() => observer.start()).not.toThrow();
    expect(() => observer.stop()).not.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});
