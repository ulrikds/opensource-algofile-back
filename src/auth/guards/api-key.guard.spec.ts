import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AcceptsPaidKeys, ApiKeyGuard, rateLimitTracker, resolveApiKey } from './api-key.guard';

const req = (headers: Record<string, string>, extra: any = {}) => ({ headers, ...extra });

describe('rateLimitTracker', () => {
  it('trusts CF-Connecting-IP, never X-Forwarded-For, and groups IPv6 by /64', () => {
    expect(rateLimitTracker(req({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '6.6.6.6' }))).toBe('1.2.3.4');
    expect(rateLimitTracker(req({ 'x-forwarded-for': '6.6.6.6' }, { ip: '::ffff:10.0.0.1' }))).toBe('10.0.0.1');
    expect(rateLimitTracker(req({ 'cf-connecting-ip': '2001:db8:a:b::1' }))).toBe('2001:db8:a:b::/64');
    expect(rateLimitTracker(req({ 'cf-connecting-ip': '2001:db8:a:b:ffff:1:2:3' }))).toBe('2001:db8:a:b::/64');
    expect(rateLimitTracker(req({ 'cf-connecting-ip': '2001::1:2:3:4:5' }))).toBe('2001:0:0:1::/64');
  });
});

describe('resolveApiKey', () => {
  it('reads x-api-key / Bearer and falls back to the public key only on upload/challenge routes', () => {
    expect(resolveApiKey(req({ 'x-api-key': 'k1' }))).toBe('k1');
    expect(resolveApiKey(req({ authorization: 'Bearer k2' }))).toBe('k2');
    expect(resolveApiKey(req({}, { originalUrl: '/api/algofile/upload' }))).toBe('algofilerouteapi1y');
    expect(resolveApiKey(req({}, { originalUrl: '/api/users/me' }))).toBeUndefined();
  });
});

describe('ApiKeyGuard', () => {
  const guardFor = (isPaid: boolean) =>
    new ApiKeyGuard(
      {
        validateApiKey: async () => ({ _id: 'k', name: 'n', owner: 'u', bucket: { name: 'b' }, isPaid }),
        findById: async () => ({ _id: 'u', email: 'e' }),
      } as any,
      {} as any,
      new Reflector(),
    );
  class Routes {
    @AcceptsPaidKeys() charges() {}
    free() {}
  }
  const ctx = (handler: () => void) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-api-key': 'k' }, originalUrl: '/x' }) }),
      getHandler: () => handler,
    }) as any;

  it('accepts paid keys only on routes that charge via x402', async () => {
    await expect(guardFor(true).canActivate(ctx(Routes.prototype.charges))).resolves.toBe(true);
    await expect(guardFor(true).canActivate(ctx(Routes.prototype.free))).rejects.toThrow(ForbiddenException);
    await expect(guardFor(false).canActivate(ctx(Routes.prototype.free))).resolves.toBe(true);
  });
});
