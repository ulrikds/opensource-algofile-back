import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { raceGateways, readCapped } from './filebase-pinning.service';

// Fake gateways: /small answers at once, /late answers after 100ms then streams, /big streams endlessly,
// /sized announces 10MB, /missing is a 404 and /hang never answers. streamed counts bytes actually sent.
let server: Server;
let base = '';
let streamed = 0;
const stream = (res: any) => {
  res.writeHead(200, { 'content-type': 'video/mp4' });
  const t = setInterval(() => (streamed += 64 * 1024) && res.write(Buffer.alloc(64 * 1024)), 5);
  res.on('close', () => clearInterval(t));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/small') return res.end('{"name":"ok"}');
    if (req.url === '/late') {
      const t = setTimeout(() => stream(res), 100);
      return res.on('close', () => clearTimeout(t));
    }
    if (req.url === '/big') return stream(res);
    if (req.url === '/sized') return res.writeHead(200, { 'content-length': String(10 << 20) }).flushHeaders();
    if (req.url === '/missing') return res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const settle = () => new Promise((r) => setTimeout(r, 400));

describe('raceGateways + readCapped', () => {
  it('reads only the first gateway to answer and cancels the others', async () => {
    streamed = 0;
    const won = await raceGateways([`${base}/late`, `${base}/small`, `${base}/missing`], {}, 2000);
    expect((await readCapped(won!.res, 1024))?.toString()).toBe('{"name":"ok"}');
    won!.release();
    await settle();
    expect(streamed).toBe(0); // /late was aborted before it sent anything
  });

  it('stops downloading once the cap is passed, whether or not the size is announced', async () => {
    streamed = 0;
    const big = await raceGateways([`${base}/big`], {}, 2000);
    expect(await readCapped(big!.res, 256 * 1024)).toBeNull();
    big!.release();
    await settle();
    expect(streamed).toBeLessThan(2 << 20); // an uncancelled stream would be past ~5MB by now

    const sized = await raceGateways([`${base}/sized`], {}, 2000);
    expect(await readCapped(sized!.res, 1 << 20)).toBeNull();
    sized!.release();
  });

  it('gives up when every gateway fails or time runs out', async () => {
    expect(await raceGateways([`${base}/missing`, `${base}/missing`], {}, 2000)).toBeNull();
    const started = Date.now();
    expect(await raceGateways([`${base}/hang`], {}, 200)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
