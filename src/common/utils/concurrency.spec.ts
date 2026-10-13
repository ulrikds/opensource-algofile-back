import { mapWithConcurrency } from './concurrency';
import { extractCidFromMetadata } from '../../filebase/services/filebase-client.service';

describe('mapWithConcurrency', () => {
  it('keeps result order and never exceeds the limit', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10 + i;
    });
    expect(out).toEqual([50, 11, 42, 23, 34]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });
});

describe('extractCidFromMetadata', () => {
  const cid = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

  it('reads the cid metadata key', () => {
    expect(extractCidFromMetadata({ cid })).toBe(cid);
  });

  it('falls back to response headers, then to any CID-looking value', () => {
    expect(extractCidFromMetadata({}, { 'x-amz-meta-cid': cid })).toBe(cid);
    expect(extractCidFromMetadata({ other: cid })).toBe(cid);
  });

  it('returns undefined when nothing looks like a CID', () => {
    expect(extractCidFromMetadata({ foo: 'bar' })).toBeUndefined();
  });
});
