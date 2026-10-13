import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isIPv6 } from 'net';
import { UsersService } from '../../users/users.service';
import { ConfigService } from '@nestjs/config';
import { PurchasesService } from '../../purchases/purchases.service';

// Shared public keys: the raw key is the name itself (see UsersService.seedOfficialKeys).
export const OFFICIAL_KEY_NAMES = [
  'algofilerouteapi',
  'algofilerouteapi6m',
  'algofilerouteapi1y',
  'algofilerouteapi2y',
];

// Raw key from 'x-api-key' or 'Authorization: Bearer <key>'; upload/challenge routes default to the public 1y key.
export function resolveApiKey(req: any): string | undefined {
  const auth = req.headers['authorization'];
  const key = req.headers['x-api-key'] || (auth?.startsWith('Bearer ') ? auth.substring(7) : undefined);
  if (key) return key;
  const url = (req.originalUrl || req.url || '').toString();
  if (url.includes('/upload') || url.includes('/challenge')) return 'algofilerouteapi1y';
}

// Behind Cloudflare, CF-Connecting-IP is set by the edge and can't be forged through it (X-Forwarded-For can).
// ponytail: a direct hit on the origin can still forge it; firewall the origin to Cloudflare IPs.
export function clientIp(req: any): string {
  return (req.headers['cf-connecting-ip'] || req.ip || '').toString();
}

// Rate-limit identity: IPv6 grouped by /64, since one host usually owns the whole /64 and can rotate within it.
export function rateLimitTracker(req: any): string {
  const ip = clientIp(req);
  if (!isIPv6(ip) || ip.includes('.')) return ip.replace(/^::ffff:/i, '');
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.slice(0, 4).join(':') + '::/64';
}

// Paid keys (incl. the public ones) are only accepted on routes that charge them via x402.
// Anywhere else they'd skip payment and write to the official buckets, which have no storage limit.
export const AcceptsPaidKeys = () => SetMetadata('acceptsPaidKeys', true);

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
    @Optional() private readonly purchasesService?: PurchasesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const apiKey = resolveApiKey(request);
    if (!apiKey) {
      throw new UnauthorizedException('API key is missing');
    }

    const keyRecord = await this.usersService.validateApiKey(apiKey);
    if (!keyRecord || !keyRecord.bucket) {
      throw new UnauthorizedException('Invalid or unlinked API key');
    }

    const bucket = keyRecord.bucket as any;
    if (bucket.expiresAt && new Date() > new Date(bucket.expiresAt)) {
      throw new UnauthorizedException(
        `API access blocked: The bound bucket '${bucket.name}' has expired.`,
      );
    }

    const user = await this.usersService.findById(keyRecord.owner.toString());
    if (!user) {
      throw new UnauthorizedException('User associated with API key not found');
    }

    const isPublic = OFFICIAL_KEY_NAMES.includes(keyRecord.name?.toLowerCase()) || (keyRecord as any).isPublic === true;

    const origin = (request.headers['origin'] || '').toString();
    const referer = (request.headers['referer'] || '').toString();
    const ip = clientIp(request);
    const endpoint = (request.originalUrl || request.url || '/').toString();
    const method = (request.method || 'GET').toString();
    const userAgent = (request.headers['user-agent'] || '').toString();

    // Attach user and telemetry context to request
    request.user = {
      id: user._id.toString(),
      email: user.email,
      apiKeyBucket: (keyRecord.bucket as any).name,
      apiKeyId: keyRecord._id.toString(),
      apiKeyRecord: keyRecord,
    };

    request.apiTelemetry = {
      origin,
      referer,
      ip,
      endpoint,
      method,
      isPublic,
      apiKeyName: keyRecord.name,
    };

    // Log telemetry asynchronously
    if (this.purchasesService) {
      this.purchasesService.logApiKeyAccess({
        apiKeyId: keyRecord._id.toString(),
        apiKeyName: keyRecord.name,
        isPublic,
        origin,
        referer,
        endpoint,
        method,
        ip,
        userAgent,
        ownerId: user._id.toString(),
      }).catch(() => {});
    }

    // Checked after logging so blocked attempts still show up in the access log.
    if (keyRecord.isPaid && !this.reflector.get<boolean>('acceptsPaidKeys', context.getHandler())) {
      throw new ForbiddenException(
        'Paid API keys can only be used on /api/algofile/upload and /api/algofile/upload/bulk-presigned.',
      );
    }

    return true;
  }
}
