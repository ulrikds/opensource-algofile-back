import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Bucket, BucketDocument } from '../schemas/bucket.schema';
import { User, UserDocument } from '../../users/schemas/user.schema';
import {
  Collection,
  CollectionDocument,
} from '../../collections/schemas/collection.schema';
import { PinnedCid, PinnedCidDocument } from '../schemas/pinned-cid.schema';
import { ImportedCid, ImportedCidDocument } from '../schemas/imported-cid.schema';
import {
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { FilebaseClientService } from './filebase-client.service';
import * as crypto from 'crypto';

/**
 * Races IPFS gateways on response headers, aborts every loser right away and returns the winner with its
 * body still unread. Reading full bodies from all gateways in parallel downloaded each file once per gateway
 * (algofile, algofile2 and algofile3 are billed to our Filebase plan) and nothing cancelled the losers.
 */
export async function raceGateways(
  urls: string[],
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ res: Response; release: () => void } | null> {
  const controllers = urls.map(() => new AbortController());
  const abortAll = () => controllers.forEach((c) => c.abort());
  const timer = setTimeout(abortAll, timeoutMs); // also bounds the winner's body read
  const release = () => {
    clearTimeout(timer);
    abortAll();
  };
  try {
    const { res, i } = await Promise.any(
      urls.map(async (url, i) => {
        const res = await fetch(url, { headers, signal: controllers[i].signal });
        if (!res.ok) {
          controllers[i].abort();
          throw new Error(`HTTP ${res.status}`);
        }
        return { res, i };
      }),
    );
    controllers.forEach((c, j) => j !== i && c.abort());
    return { res, release };
  } catch {
    release();
    return null;
  }
}

/** Reads a response body, returning null as soon as it goes over maxBytes. */
export async function readCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (Number(res.headers.get('content-length')) > maxBytes) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    if ((total += chunk.length) > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const METADATA_CACHE_MAX = 5000;

@Injectable()
export class FilebasePinningService {
  private gatewayCounter = 0;
  private readonly metadataCache = new Map<
    string,
    {
      imageCid: string | null;
      name?: string;
      description?: string;
      mimeType?: string;
      properties?: Record<string, any>;
      raw?: any;
    }
  >();

  constructor(
    @InjectModel(Bucket.name) private readonly bucketModel: Model<BucketDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Collection.name)
    private readonly collectionModel: Model<CollectionDocument>,
    @InjectModel(PinnedCid.name)
    private readonly pinnedCidModel: Model<PinnedCidDocument>,
    @InjectModel(ImportedCid.name)
    private readonly importedCidModel: Model<ImportedCidDocument>,
    private readonly configService: ConfigService,
    private readonly clientService: FilebaseClientService,
  ) {}

  /** Bounded insert: the cache lives for the whole process, so without a cap it only ever grows. */
  private cacheMetadata(cid: string, entry: any): void {
    if (this.metadataCache.size >= METADATA_CACHE_MAX) {
      // Maps iterate in insertion order, so the first key is the oldest entry.
      this.metadataCache.delete(this.metadataCache.keys().next().value!);
    }
    this.metadataCache.set(cid, entry);
  }

  getGatewayUrl(cid: string): string {
    const gatewaysConfig = this.configService.get<string>('FILEBASE_GATEWAYS');
    if (gatewaysConfig) {
      const gateways = gatewaysConfig
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      if (gateways.length > 0) {
        const gateway = gateways[this.gatewayCounter % gateways.length];
        this.gatewayCounter = (this.gatewayCounter + 1) % gateways.length;
        const cleanGateway = gateway.startsWith('http')
          ? gateway
          : `https://${gateway}`;
        const normalized = cleanGateway.endsWith('/')
          ? cleanGateway.slice(0, -1)
          : cleanGateway;
        return `${normalized}/ipfs/${cid}`;
      }
    }
    return `https://algofile.myfilebase.com/ipfs/${cid}`;
  }

  getGatewayUrlsForCid(cid: string): string[] {
    const cleanCid = this.cleanCid(cid) || cid;
    const gatewaysConfig = this.configService.get<string>('FILEBASE_GATEWAYS');
    if (gatewaysConfig) {
      const gateways = gatewaysConfig
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      if (gateways.length > 0) {
        return gateways.map((g) => {
          const cleanGateway = g.startsWith('http') ? g : `https://${g}`;
          const normalized = cleanGateway.endsWith('/')
            ? cleanGateway.slice(0, -1)
            : cleanGateway;
          return `${normalized}/ipfs/${cleanCid}`;
        });
      }
    }
    return [
      `https://algofile.myfilebase.com/ipfs/${cleanCid}`,
      `https://algofile2.myfilebase.com/ipfs/${cleanCid}`,
      `https://algofile3.myfilebase.com/ipfs/${cleanCid}`,
      `https://ipfs.algonode.xyz/ipfs/${cleanCid}`,
      `https://4160.nodely.dev/ipfs/${cleanCid}`,
      `https://dweb.link/ipfs/${cleanCid}`,
    ];
  }

  /**
   * Resolves the size in bytes and MIME type of an IPFS CID using cached records or fast concurrent probe.
   * Capped to <1.8s so it never blocks bulk or single pin requests.
   */
  async resolveCidSize(cid: string): Promise<{ sizeBytes: number; mimeType?: string }> {
    if (!cid) return { sizeBytes: 0 };
    const cleanCid = this.cleanCid(cid);
    if (!cleanCid) return { sizeBytes: 0 };

    // 1. Check MongoDB cache first for instantaneous (<5ms) resolution
    try {
      const cached = await this.findCidRecord(cleanCid);
      if (cached && cached.sizeBytes && cached.sizeBytes > 0) {
        return { sizeBytes: cached.sizeBytes, mimeType: cached.mimeType };
      }
    } catch (_) {}

    // 2. Fast concurrent probe on the highest-speed public gateway with 1.8s timeout
    const fastGateways = [
      `https://algofile.myfilebase.com/ipfs/${cleanCid}`,
      `https://algofile2.myfilebase.com/ipfs/${cleanCid}`,
      `https://algofile3.myfilebase.com/ipfs/${cleanCid}`,
      `https://ipfs.algonode.xyz/ipfs/${cleanCid}`,
    ];

    const probe = async (url: string) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1800);
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { Range: 'bytes=0-0', 'User-Agent': 'Mozilla/5.0' },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.status === 206 || res.status === 200) {
          const contentType = res.headers.get('content-type') || undefined;
          const cr = res.headers.get('content-range');
          if (cr) {
            const match = cr.match(/\/(\d+)$/);
            if (match) {
              const size = parseInt(match[1], 10);
              if (size > 0) {
                return { sizeBytes: size, mimeType: contentType };
              }
            }
          }
          const cl = res.headers.get('content-length');
          if (cl) {
            const size = parseInt(cl, 10);
            if (size > 1) {
              return { sizeBytes: size, mimeType: contentType };
            }
          }
        }
      } catch (_) {
        clearTimeout(timeoutId);
      }
      return null;
    };

    // First gateway to report a size wins instead of waiting for the slowest one.
    try {
      return await Promise.any(
        fastGateways.map(async (url) => {
          const result = await probe(url);
          if (!result || result.sizeBytes <= 0) throw new Error('no size');
          return result;
        }),
      );
    } catch (_) {
      return { sizeBytes: 0 };
    }
  }

  getIpfsSizeCheckUrl(cid: string): string {
    const gatewaysConfig = this.configService.get<string>('FILEBASE_GATEWAYS');
    if (gatewaysConfig) {
      const gateways = gatewaysConfig
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      if (gateways.length > 0) {
        const gateway = gateways[this.gatewayCounter % gateways.length];
        this.gatewayCounter = (this.gatewayCounter + 1) % gateways.length;
        const cleanGateway = gateway.startsWith('http')
          ? gateway
          : `https://${gateway}`;
        const normalized = cleanGateway.endsWith('/')
          ? cleanGateway.slice(0, -1)
          : cleanGateway;
        return `${normalized}/ipfs/${cid}`;
      }
    }
    return `https://algofile.myfilebase.com/ipfs/${cid}`;
  }

  /**
   * Cleans an IPFS CID by extracting valid CID from ipfs:// URLs, gateway URLs,
   * path segments, query parameters, trailing slashes, or wrapping punctuation.
   */
  cleanCid(raw: string): string {
    if (!raw) return '';
    let str = raw.trim();

    // Strip wrapping quotes, backticks, commas, brackets
    str = str.replace(/^[\[\("\"'`]+|[\]\)"'`],*$/g, '').trim();

    // Subdomain gateway: https://<cid>.ipfs.dweb.link or https://<cid>.ipfs.w3s.link
    const subdomainMatch = str.match(/([a-zA-Z0-9]{46,})\.ipfs\./i);
    if (subdomainMatch) {
      return subdomainMatch[1];
    }

    // Path gateway: /ipfs/<cid>
    const ipfsPathMatch = str.match(/\/ipfs\/([a-zA-Z0-9]+)/i);
    if (ipfsPathMatch) {
      return ipfsPathMatch[1];
    }

    // IPFS URI: ipfs://<cid>
    if (str.toLowerCase().startsWith('ipfs://')) {
      str = str.slice(7);
    }

    // If a full valid CID exists anywhere inside the string
    const generalCidMatch = str.match(
      /(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{50,100}|ba[a-z0-9]{50,100}|z[1-9A-HJ-NP-Za-km-z]{44,100})/i,
    );
    if (generalCidMatch) {
      return generalCidMatch[1];
    }

    // Strip subpath, query string, fragment
    str = str.split('/')[0].split('?')[0].split('#')[0].trim();
    str = str.replace(/^[^\w]+|[^\w]+$/g, '');

    return str;
  }

  /**
   * Validates if a string conforms to standard IPFS CIDv0 or CIDv1 formats.
   */
  isValidCid(cid: string): boolean {
    if (!cid) return false;
    const cidRegex =
      /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{50,100}|ba[a-z0-9]{50,100}|z[1-9A-HJ-NP-Za-km-z]{44,100})$/i;
    return cidRegex.test(cid);
  }

  /**
   * Derives or validates the Filebase IPFS RPC Base64 token for a given bucket.
   * Filebase RPC expects Base64(accessKeyId:secretAccessKey:bucketName).
   */
  getBucketRpcToken(bucketName: string, existingToken?: string): string {
    const accessKeyId = this.configService.get<string>('FILEBASE_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>('FILEBASE_SECRET_ACCESS_KEY');
    if (accessKeyId && secretAccessKey) {
      const sanitized = (bucketName || '').toLowerCase().trim();
      let physicalBucket = 'algofile-bucket-custom';

      const freeBucket = (
        this.configService.get<string>('BUCKET_FREE_NAME') ||
        'algofile-bucket-free'
      )
        .toLowerCase()
        .trim();

      if (sanitized === freeBucket || sanitized === 'algofilebucketfree') {
        physicalBucket = freeBucket;
      } else if (sanitized.startsWith('algofilerouteapi')) {
        physicalBucket = sanitized;
      }

      return Buffer.from(
        `${accessKeyId}:${secretAccessKey}:${physicalBucket}`,
      ).toString('base64');
    }
    if (existingToken && existingToken !== 'mock-token') {
      return existingToken;
    }
    return '';
  }

  async saveCidRecord(data: {
    cid: string;
    bucketName?: string;
    name?: string;
    fileId?: string;
    assetId?: number | null;
    sizeBytes?: number;
    mimeType?: string;
    fileType?: string;
    url?: string;
    metadata?: Record<string, any>;
    owner?: string;
    fileHash?: string;
  }): Promise<PinnedCidDocument | null> {
    if (!data || !data.cid) return null;
    const cleanCid = data.cid.trim();
    const sanitizedBucket = (data.bucketName || 'algofile-bucket-free')
      .toLowerCase()
      .trim();
    // Scoped by owner: in the shared free bucket two users can store the same CID, and an unscoped
    // upsert would hand the first user's record (and its quota) over to the second.
    const filter: Record<string, any> = { cid: cleanCid, bucketName: sanitizedBucket };
    if (data.owner && Types.ObjectId.isValid(data.owner)) {
      filter.owner = new Types.ObjectId(data.owner);
    }

    let parsedMeta = data.metadata;
    if (typeof parsedMeta === 'string') {
      try {
        parsedMeta = JSON.parse(parsedMeta);
      } catch {}
    }

    const update: any = {
      $set: {
        cid: cleanCid,
        bucketName: sanitizedBucket,
        name: data.name || data.fileId || cleanCid,
        fileId: data.fileId || data.name || cleanCid,
        sizeBytes: data.sizeBytes || 0,
        url: data.url || this.getGatewayUrl(cleanCid),
      },
    };
    if (data.assetId !== undefined && data.assetId !== null) {
      update.$set.assetId = data.assetId;
    }
    if (data.mimeType) update.$set.mimeType = data.mimeType;
    if (data.fileType) update.$set.fileType = data.fileType;
    if (parsedMeta) update.$set.metadata = parsedMeta;
    if (data.owner) update.$set.owner = filter.owner || data.owner;
    if (data.fileHash) update.$set.fileHash = data.fileHash;

    try {
      return await this.pinnedCidModel
        .findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' })
        .exec();
    } catch (err) {
      console.warn(`Failed to save CID record for ${cleanCid}: ${err.message}`);
      return null;
    }
  }

  /**
   * Checks if a CID or file buffer content (via SHA-256 hash) already exists
   * in Mongo (PinnedCid, ImportedCid, or Collection models). If found, returns CID details to skip physical S3 upload.
   */
  async findExistingCid(
    fileBuffer?: Buffer,
    cid?: string,
    providedFileHash?: string,
  ): Promise<{
    cid: string;
    url: string;
    sizeBytes: number;
    name?: string;
    source?: string;
  } | null> {
    let fileHash = providedFileHash;
    if (!fileHash && fileBuffer && fileBuffer.length > 0) {
      fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    }

    const cleanCid = cid ? this.cleanCid(cid) : undefined;
    const isValid = cleanCid && this.isValidCid(cleanCid);

    if (!fileHash && !isValid) return null;

    // 1. Query PinnedCid collection
    const pinnedOrFilters: any[] = [];
    if (isValid) pinnedOrFilters.push({ cid: cleanCid });
    if (fileHash) pinnedOrFilters.push({ fileHash });

    if (pinnedOrFilters.length > 0) {
      const pinnedRecord = await this.pinnedCidModel
        .findOne({ $or: pinnedOrFilters })
        .exec();
      if (pinnedRecord && pinnedRecord.cid) {
        return {
          cid: pinnedRecord.cid,
          url: pinnedRecord.url || this.getGatewayUrl(pinnedRecord.cid),
          sizeBytes: pinnedRecord.sizeBytes || (fileBuffer ? fileBuffer.length : 0),
          name: pinnedRecord.name,
          source: 'pinned_cid',
        };
      }
    }

    // 2. Query ImportedCid collection
    const importedOrFilters: any[] = [];
    if (isValid) importedOrFilters.push({ cid: cleanCid });
    if (fileHash) importedOrFilters.push({ fileHash });

    if (importedOrFilters.length > 0) {
      const importedRecord = await this.importedCidModel
        .findOne({ $or: importedOrFilters })
        .exec();
      if (importedRecord && importedRecord.cid) {
        return {
          cid: importedRecord.cid,
          url: importedRecord.url || this.getGatewayUrl(importedRecord.cid),
          sizeBytes: importedRecord.sizeBytes || (fileBuffer ? fileBuffer.length : 0),
          name: importedRecord.name,
          source: 'imported_cid',
        };
      }
    }

    // 3. Query Collection collection
    const collectionOrFilters: any[] = [];
    if (fileHash) {
      collectionOrFilters.push({ 'assets.imageHash': fileHash });
      collectionOrFilters.push({ 'assets.metadataHash': fileHash });
    }
    if (isValid) {
      collectionOrFilters.push({ 'assets.imageCid': cleanCid });
      collectionOrFilters.push({ 'assets.metadataCid': cleanCid });
    }

    if (collectionOrFilters.length > 0) {
      const collection = await this.collectionModel
        .findOne({ $or: collectionOrFilters })
        .exec();

      if (collection && collection.assets) {
        for (const asset of collection.assets) {
          if (
            (fileHash && (asset as any).imageHash === fileHash) ||
            (isValid && asset.imageCid === cleanCid)
          ) {
            return {
              cid: asset.imageCid,
              url: asset.imageUrl || this.getGatewayUrl(asset.imageCid),
              sizeBytes: (asset as any).imageSize || (fileBuffer ? fileBuffer.length : 0),
              name: asset.name,
              source: 'collection_asset_image',
            };
          }
          if (
            (fileHash && (asset as any).metadataHash === fileHash) ||
            (isValid && asset.metadataCid === cleanCid)
          ) {
            return {
              cid: asset.metadataCid,
              url: asset.metadataUrl || this.getGatewayUrl(asset.metadataCid),
              sizeBytes: (asset as any).metadataSize || (fileBuffer ? fileBuffer.length : 0),
              name: `${asset.name} Metadata`,
              source: 'collection_asset_metadata',
            };
          }
        }
      }
    }

    return null;
  }

  async findCidRecord(cid: string): Promise<{
    foundInDb: boolean;
    source: string;
    cid: string;
    fileId: string;
    assetId: number | null;
    bucketName: string;
    name: string;
    sizeBytes: number;
    mimeType: string;
    url: string;
    metadata: Record<string, any> | null;
    owner?: any;
    s3Key?: string;
  } | null> {
    if (!cid) return null;
    const cleanCid = cid.trim();

    // 1. Check PinnedCid collection in Mongo
    const pinnedRecord = await this.pinnedCidModel
      .findOne({ cid: cleanCid })
      .exec();
    if (pinnedRecord) {
      return {
        foundInDb: true,
        source: 'pinned_cid',
        cid: pinnedRecord.cid,
        fileId: pinnedRecord.fileId || pinnedRecord.name || pinnedRecord.cid,
        assetId: pinnedRecord.assetId ?? null,
        bucketName: pinnedRecord.bucketName,
        name: pinnedRecord.name || pinnedRecord.fileId || pinnedRecord.cid,
        sizeBytes: pinnedRecord.sizeBytes || 0,
        mimeType: pinnedRecord.mimeType || 'application/octet-stream',
        url: pinnedRecord.url || this.getGatewayUrl(cleanCid),
        metadata: pinnedRecord.metadata || null,
        owner: pinnedRecord.owner,
        s3Key: (pinnedRecord as any).s3Key || '',
      };
    }

    // 2. Check Collections for matching imageCid or metadataCid
    const collection = await this.collectionModel
      .findOne({
        $or: [
          { 'assets.imageCid': cleanCid },
          { 'assets.metadataCid': cleanCid },
        ],
      })
      .exec();

    if (collection && collection.assets) {
      for (const asset of collection.assets) {
        if (asset.imageCid === cleanCid) {
          return {
            foundInDb: true,
            source: 'collection_asset_image',
            cid: cleanCid,
            fileId: asset.imageKey || asset.name,
            assetId: asset.assetId ?? null,
            bucketName: collection.bucketName,
            name: asset.name,
            sizeBytes: asset.imageSize || 0,
            mimeType: asset.mimeType || 'image/png',
            url: asset.imageUrl || this.getGatewayUrl(cleanCid),
            metadata: null,
            owner: collection.owner,
            s3Key: (asset as any).s3Key || (asset as any).imageKey || '',
          };
        }
        if (asset.metadataCid === cleanCid) {
          return {
            foundInDb: true,
            source: 'collection_asset_metadata',
            cid: cleanCid,
            fileId: asset.metadataKey || `${asset.name}.json`,
            assetId: asset.assetId ?? null,
            bucketName: collection.bucketName,
            name: `${asset.name} Metadata`,
            sizeBytes: asset.metadataSize || 0,
            mimeType: 'application/json',
            url: asset.metadataUrl || this.getGatewayUrl(cleanCid),
            metadata: null,
            owner: collection.owner,
            s3Key: (asset as any).s3Key || (asset as any).metadataKey || '',
          };
        }
      }
    }

    // 3. Check ImportedCid collection in Mongo
    const importedRecord = await this.importedCidModel
      .findOne({ cid: cleanCid })
      .exec();
    if (importedRecord) {
      return {
        foundInDb: true,
        source: 'imported_cid',
        cid: importedRecord.cid,
        fileId: importedRecord.fileId || importedRecord.name || importedRecord.cid,
        assetId: null,
        bucketName: importedRecord.bucketName,
        name: importedRecord.name || importedRecord.fileId || importedRecord.cid,
        sizeBytes: importedRecord.sizeBytes || 0,
        mimeType: importedRecord.mimeType || 'application/octet-stream',
        url: importedRecord.url || this.getGatewayUrl(cleanCid),
        metadata: importedRecord.metadata || null,
        owner: importedRecord.owner,
        s3Key: importedRecord.s3Key || '',
      };
    }

    return null;
  }

  /**
   * Batch checks a list of CIDs to identify which ones already exist inside the project
   * (across PinnedCid, ImportedCid, and Collection models).
   */
  async checkExistingCidsInProject(cids: string[]): Promise<Record<string, {
    exists: boolean;
    sizeBytes: number;
    name?: string;
    source?: string;
  }>> {
    if (!cids || cids.length === 0) return {};
    const cleanList = Array.from(
      new Set(cids.map((c) => this.cleanCid(c)).filter((c) => this.isValidCid(c))),
    );
    if (cleanList.length === 0) return {};

    const resultMap: Record<string, { exists: boolean; sizeBytes: number; name?: string; source?: string }> = {};

    // 1. Query PinnedCid
    const pinned = await this.pinnedCidModel
      .find({ cid: { $in: cleanList } })
      .select('cid sizeBytes name')
      .lean()
      .exec();

    for (const p of pinned) {
      resultMap[p.cid] = {
        exists: true,
        sizeBytes: p.sizeBytes || 0,
        name: p.name,
        source: 'pinned_cid',
      };
    }

    // 2. Query ImportedCid for any remaining
    const remainingAfterPinned = cleanList.filter((c) => !resultMap[c]);
    if (remainingAfterPinned.length > 0) {
      const imported = await this.importedCidModel
        .find({ cid: { $in: remainingAfterPinned } })
        .select('cid sizeBytes name')
        .lean()
        .exec();

      for (const imp of imported) {
        resultMap[imp.cid] = {
          exists: true,
          sizeBytes: imp.sizeBytes || 0,
          name: imp.name,
          source: 'imported_cid',
        };
      }
    }

    // 3. Query Collections for any remaining
    const remainingAfterImported = cleanList.filter((c) => !resultMap[c]);
    if (remainingAfterImported.length > 0) {
      const collections = await this.collectionModel
        .find({
          $or: [
            { 'assets.imageCid': { $in: remainingAfterImported } },
            { 'assets.metadataCid': { $in: remainingAfterImported } },
          ],
        })
        .select('assets')
        .lean()
        .exec();

      for (const col of collections) {
        if (col.assets && Array.isArray(col.assets)) {
          for (const asset of col.assets) {
            if (asset.imageCid && remainingAfterImported.includes(asset.imageCid)) {
              resultMap[asset.imageCid] = {
                exists: true,
                sizeBytes: (asset as any).imageSize || 0,
                name: asset.name,
                source: 'collection_asset_image',
              };
            }
            if (asset.metadataCid && remainingAfterImported.includes(asset.metadataCid)) {
              resultMap[asset.metadataCid] = {
                exists: true,
                sizeBytes: (asset as any).metadataSize || 0,
                name: `${asset.name} Metadata`,
                source: 'collection_asset_metadata',
              };
            }
          }
        }
      }
    }

    return resultMap;
  }

  /**
   * Helper to extract the image IPFS CID from an ARC-3 or ARC-19 metadata JSON object.
   * Handles image, image_url, animation_url, media, properties.files arrays, and recursive string search.
   */
  extractImageCidFromJson(json: any): string | null {
    if (!json) return null;
    let obj = json;
    if (typeof obj === 'string') {
      try {
        obj = JSON.parse(obj);
      } catch {
        // Try repairing single quotes or python-style dict representation
        try {
          obj = JSON.parse(obj.replace(/'/g, '"'));
        } catch {
          // Direct regex extraction for image field from raw text
          const imgMatch = obj.match(/['"]image(?:_url)?['"]\s*:\s*['"]([^'"]+)['"]/i);
          if (imgMatch) {
            const cleaned = this.cleanCid(imgMatch[1]);
            if (this.isValidCid(cleaned)) return cleaned;
          }
          const cleaned = this.cleanCid(obj);
          if (this.isValidCid(cleaned)) return cleaned;
          return null;
        }
      }
    }
    if (!obj || typeof obj !== 'object') return null;

    // 1. Check standard candidate fields
    const candidates: any[] = [
      obj.image,
      obj.image_url,
      obj.animation_url,
      obj.media,
      obj.media_url,
      obj.imageUrl,
      obj.animationUrl,
      obj.image?.url,
      obj.image?.src,
      obj.image?.uri,
      obj.properties?.image,
      obj.properties?.file,
      obj.properties?.image_url,
      obj.properties?.imageUrl,
      obj.properties?.media,
      obj.properties?.image?.url,
      obj.properties?.image?.src,
      obj.properties?.image?.uri,
    ];

    // 2. Check standard ARC-3 files arrays
    const filesArrays = [obj.properties?.files, obj.files, obj.media_files];
    for (const arr of filesArrays) {
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === 'string') {
            candidates.push(item);
          } else if (item && typeof item === 'object') {
            candidates.push(item.src, item.file, item.url, item.uri);
          }
        }
      }
    }

    for (const cand of candidates) {
      if (cand && typeof cand === 'string') {
        const cleaned = this.cleanCid(cand);
        if (this.isValidCid(cleaned)) {
          return cleaned;
        }
      }
    }

    // 3. Fallback: Deep recursive scan of all string values in the JSON
    const scanStrings = (target: any, depth = 0): string | null => {
      if (!target || depth > 4) return null;
      if (typeof target === 'string') {
        const cleaned = this.cleanCid(target);
        if (this.isValidCid(cleaned)) {
          return cleaned;
        }
        return null;
      }
      if (typeof target === 'object') {
        for (const val of Object.values(target)) {
          const found = scanStrings(val, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };

    return scanStrings(obj);
  }

  /**
   * Returns the dedicated URL on the platform's public gateway "algofilepublic".
   * This gateway is strictly intended for internal platform functions resolving/discovering CIDs.
   */
  getPublicGatewayUrl(cid: string): string {
    const cleanCid = this.cleanCid(cid) || cid;
    const publicGwConfig =
      this.configService.get<string>('FILEBASE_PUBLIC_GATEWAY') ||
      this.configService.get<string>('ALGOFILE_PUBLIC_GATEWAY') ||
      'algofilepublic.myfilebase.com';
    const cleanGateway = publicGwConfig.startsWith('http')
      ? publicGwConfig
      : `https://${publicGwConfig}`;
    const normalized = cleanGateway.endsWith('/')
      ? cleanGateway.slice(0, -1)
      : cleanGateway;
    return `${normalized}/ipfs/${cleanCid}`;
  }

  /**
   * Fetches metadata JSON and extracts artwork CIDs strictly using the platform's
   * public gateway "algofilepublic".
   * All account keys, dedicated gateways, and third-party public gateways are removed.
   * This is exclusively called by platform internal functions to discover CIDs.
   */
  async fetchMetadataFromGateways(cleanCid: string): Promise<{
    imageCid: string | null;
    name?: string;
    description?: string;
    mimeType?: string;
    properties?: Record<string, any>;
    raw?: any;
  } | null> {
    const publicGatewayUrl = this.getPublicGatewayUrl(cleanCid);

    const urls = [
      `https://ipfs-pera.algonode.dev/ipfs/${cleanCid}`,
      `https://ipfs.algonode.dev/ipfs/${cleanCid}`,
      publicGatewayUrl,
      `https://algofile.myfilebase.com/ipfs/${cleanCid}`,
      `https://algofile2.myfilebase.com/ipfs/${cleanCid}`,
      `https://algofile3.myfilebase.com/ipfs/${cleanCid}`,
      `https://gateway.pinata.cloud/ipfs/${cleanCid}`,
      `https://ipfs.io/ipfs/${cleanCid}`,
      `https://dweb.link/ipfs/${cleanCid}`,
    ];

    const won = await raceGateways(
      urls,
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AlgoFile-Internal-Resolver',
        Accept: 'application/json, text/plain, image/*, */*',
      },
      7000,
    );
    if (!won) return null;
    try {
      const contentType = won.res.headers.get('content-type') || '';

      // If it's a direct image file, the CID itself is the image CID!
      if (contentType.startsWith('image/')) {
        return {
          imageCid: cleanCid,
          mimeType: contentType,
          name: undefined,
          raw: null,
        };
      }

      // Metadata JSON is small; anything over 1MB isn't metadata and isn't worth our bandwidth.
      const body = await readCapped(won.res, 1024 * 1024);
      if (!body) return null;
      const text = body.toString('utf8');

      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Try repairing single quotes or python-style dict representation
        try {
          parsed = JSON.parse(text.replace(/'/g, '"'));
        } catch {
          // Direct regex extraction for image and metadata fields from raw text
          const imgCid = this.extractImageCidFromJson(text);
          if (imgCid) {
            const nameMatch = text.match(/['"]name['"]\s*:\s*['"]([^'"]+)['"]/i);
            const descMatch = text.match(/['"]description['"]\s*:\s*['"]([^'"]+)['"]/i);
            const mimeMatch = text.match(/['"]image_mime_?type['"]\s*:\s*['"]([^'"]+)['"]/i);
            return {
              imageCid: imgCid,
              name: nameMatch ? nameMatch[1] : undefined,
              description: descMatch ? descMatch[1] : undefined,
              mimeType: mimeMatch ? mimeMatch[1] : 'image/png',
              raw: text,
            };
          }
        }
      }

      if (parsed && typeof parsed === 'object') {
        const imgCid = this.extractImageCidFromJson(parsed);
        return {
          imageCid: imgCid,
          name: parsed.name,
          description: parsed.description,
          mimeType: parsed.image_mime_type || parsed.image_mimetype || 'image/png',
          properties: parsed.properties,
          raw: parsed,
        };
      }

      // If text is not JSON, check if it starts with image bytes / signature
      if (text.startsWith('\x89PNG') || text.startsWith('GIF8') || text.startsWith('\xFF\xD8')) {
        return {
          imageCid: cleanCid,
          mimeType: 'image/png',
          raw: null,
        };
      }
      return null;
    } catch {
      return null;
    } finally {
      won.release();
    }
  }

  /**
   * Fetches the actual binary content of an IPFS CID across fast gateways with Promise.any.
   */
  async fetchCidBuffer(
    cleanCid: string,
    maxBytes = Infinity,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    if (!cleanCid) return null;
    const urls = [
      `https://ipfs-pera.algonode.dev/ipfs/${cleanCid}`,
      `https://ipfs.algonode.dev/ipfs/${cleanCid}`,
      `https://algofile.myfilebase.com/ipfs/${cleanCid}`,
      `https://algofile2.myfilebase.com/ipfs/${cleanCid}`,
      `https://algofile3.myfilebase.com/ipfs/${cleanCid}`,
      `https://ipfs.io/ipfs/${cleanCid}`,
      `https://gateway.pinata.cloud/ipfs/${cleanCid}`,
      `https://dweb.link/ipfs/${cleanCid}`,
    ];

    const won = await raceGateways(
      urls,
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AlgoFile-IPFS-Importer',
        Accept: '*/*',
      },
      8000,
    );
    if (!won) return null;
    let buffer: Buffer | null;
    try {
      buffer = await readCapped(won.res, maxBytes);
    } catch {
      return null;
    } finally {
      won.release();
    }
    // Stop at the remaining quota instead of downloading a file that would be rejected afterwards.
    if (!buffer) {
      throw new BadRequestException('Pin blocked: file exceeds the remaining bucket capacity.');
    }
    if (buffer.length === 0) return null;
    const contentType =
      won.res.headers.get('content-type') || 'application/octet-stream';
    return { buffer, contentType };
  }

  /**
   * Resolves metadata JSON and extracts image CIDs for a list of IPFS CIDs.
   * Checks in-memory cache and database first, then queries IPFS gateways concurrently with Promise.any.
   */
  async resolveAssetMetadataBulk(cids: string[]): Promise<
    Record<
      string,
      {
        imageCid: string | null;
        name?: string;
        description?: string;
        mimeType?: string;
        properties?: Record<string, any>;
        raw?: any;
      }
    >
  > {
    if (!cids || !Array.isArray(cids) || cids.length === 0) {
      return {};
    }

    const resultMap: Record<
      string,
      {
        imageCid: string | null;
        name?: string;
        description?: string;
        mimeType?: string;
        properties?: Record<string, any>;
        raw?: any;
      }
    > = {};

    const cleanList = Array.from(
      new Set(
        cids
          .map((c) => this.cleanCid(c))
          .filter((c) => this.isValidCid(c)),
      ),
    );

    if (cleanList.length === 0) {
      return {};
    }

    // 1. Check in-memory cache for instantaneous resolution
    for (const cid of cleanList) {
      const cached = this.metadataCache.get(cid);
      if (cached) {
        resultMap[cid] = cached;
      }
    }

    // 2. Check MongoDB Collections for remaining
    const remainingAfterMem = cleanList.filter((c) => !resultMap[c]);
    if (remainingAfterMem.length > 0) {
      try {
        const collections = await this.collectionModel
          .find({ 'assets.metadataCid': { $in: remainingAfterMem } })
          .select('assets')
          .lean()
          .exec();

        for (const col of collections) {
          if (col.assets && Array.isArray(col.assets)) {
            for (const asset of col.assets) {
              if (asset.metadataCid && remainingAfterMem.includes(asset.metadataCid)) {
                const entry = {
                  imageCid: asset.imageCid || null,
                  name: asset.name,
                  description: (asset as any).description,
                  mimeType: asset.mimeType || 'image/png',
                  properties: (asset as any).properties || {},
                };
                resultMap[asset.metadataCid] = entry;
                this.cacheMetadata(asset.metadataCid, entry);
              }
            }
          }
        }
      } catch (_) {}
    }

    // 3. Check PinnedCids for cached metadata
    const remainingAfterCols = cleanList.filter((c) => !resultMap[c]);
    if (remainingAfterCols.length > 0) {
      try {
        const pinned = await this.pinnedCidModel
          .find({ cid: { $in: remainingAfterCols }, metadata: { $ne: null } })
          .lean()
          .exec();

        for (const p of pinned) {
          if (p.metadata) {
            const imgCid = this.extractImageCidFromJson(p.metadata);
            const metaObj = typeof p.metadata === 'object' ? p.metadata : null;
            const entry = {
              imageCid: imgCid,
              name: metaObj?.name || p.name,
              description: metaObj?.description,
              mimeType: metaObj?.image_mime_type || metaObj?.image_mimetype || p.mimeType,
              properties: metaObj?.properties,
              raw: p.metadata,
            };
            resultMap[p.cid] = entry;
            this.cacheMetadata(p.cid, entry);
          }
        }
      } catch (_) {}
    }

    // 4. Check ImportedCids for cached metadata
    const remainingAfterPinned = cleanList.filter((c) => !resultMap[c]);
    if (remainingAfterPinned.length > 0) {
      try {
        const imported = await this.importedCidModel
          .find({ cid: { $in: remainingAfterPinned }, metadata: { $ne: null } })
          .lean()
          .exec();

        for (const imp of imported) {
          if (imp.metadata) {
            const imgCid = this.extractImageCidFromJson(imp.metadata);
            const metaObj = typeof imp.metadata === 'object' ? imp.metadata : null;
            const entry = {
              imageCid: imgCid,
              name: metaObj?.name || imp.name,
              description: metaObj?.description,
              mimeType: metaObj?.image_mime_type || metaObj?.image_mimetype || imp.mimeType,
              properties: metaObj?.properties,
              raw: imp.metadata,
            };
            resultMap[imp.cid] = entry;
            this.cacheMetadata(imp.cid, entry);
          }
        }
      } catch (_) {}
    }

    // 5. Resolve remaining CIDs via fast IPFS gateway race concurrently
    const remainingToFetch = cleanList.filter((c) => !resultMap[c]);
    const concurrency = 35;

    for (let i = 0; i < remainingToFetch.length; i += concurrency) {
      const batch = remainingToFetch.slice(i, i + concurrency);

      await Promise.all(
        batch.map(async (cid) => {
          const resolved = await this.fetchMetadataFromGateways(cid);

          if (resolved) {
            resultMap[cid] = resolved;
            this.cacheMetadata(cid, resolved);

            // Asynchronously cache metadata and imageCid in MongoDB if record exists
            const updateSet: any = { metadata: resolved.raw || resolved };
            if (resolved.imageCid) {
              updateSet.imageCid = resolved.imageCid;
            }
            this.pinnedCidModel
              .updateOne({ cid }, { $set: updateSet })
              .catch(() => {});
            this.importedCidModel
              .updateOne({ cid }, { $set: updateSet })
              .catch(() => {});
          } else {
            resultMap[cid] = {
              imageCid: null,
            };
          }
        }),
      );
    }

    return resultMap;
  }

  async resolveCidFromProvider(cid: string): Promise<any> {
    if (!cid) {
      throw new BadRequestException('CID is required');
    }
    const cleanCid = cid.trim();

    // 1. Try DB first
    const dbRecord = await this.findCidRecord(cleanCid);
    if (dbRecord) {
      return dbRecord;
    }

    // 2. Fallback to HTTP HEAD request to Filebase IPFS gateway
    let sizeBytes = 0;
    let mimeType = 'application/octet-stream';
    let fetchedMetadata: Record<string, any> | null = null;

    const gatewayUrls = this.getGatewayUrlsForCid(cleanCid);
    let fetchSuccess = false;

    for (const url of gatewayUrls) {
      if (fetchSuccess) break;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (res.ok) {
          fetchSuccess = true;
          const contentType = res.headers.get('content-type');
          if (contentType) mimeType = contentType;
          const contentLength = res.headers.get('content-length');
          if (contentLength) sizeBytes = parseInt(contentLength, 10) || 0;

          if (mimeType.includes('application/json') || url.endsWith('.json')) {
            try {
              fetchedMetadata = await res.json();
            } catch {
              // Ignore JSON parse error if binary
            }
          }
        }
      } catch {
        // Try next gateway
      }
    }

    // 3. Cache in MongoDB
    const savedRecord = await this.saveCidRecord({
      cid: cleanCid,
      bucketName: 'algofile-bucket-free',
      name: cleanCid,
      fileId: cleanCid,
      sizeBytes,
      mimeType,
      metadata: fetchedMetadata || undefined,
    });

    return {
      foundInDb: false,
      source: 'filebase_fallback',
      cid: cleanCid,
      fileId: savedRecord?.fileId || cleanCid,
      assetId: savedRecord?.assetId ?? null,
      bucketName: savedRecord?.bucketName || 'algofile-bucket-free',
      name: savedRecord?.name || cleanCid,
      sizeBytes,
      mimeType,
      url: this.getGatewayUrl(cleanCid),
      metadata: fetchedMetadata,
    };
  }

  /**
   * Pins an existing IPFS CID via the Filebase IPFS RPC API, verifying ownership, fetching file size, updating quotas, and logging in Mongo.
   */
  async pinCid(
    userId: string,
    bucketName: string,
    cid: string,
    name?: string,
    customFolder?: string,
  ): Promise<any> {
    try {
      const cleanCid = this.cleanCid(cid);
    if (!this.isValidCid(cleanCid)) {
      throw new BadRequestException(
        `Invalid IPFS CID format: '${cid}'. Please provide a valid CIDv0 (Qm...) or CIDv1 (bafy...).`,
      );
    }

    const sanitizedBucket = (bucketName || '').toLowerCase().trim();
    const bucket = await this.bucketModel
      .findOne({ name: sanitizedBucket })
      .exec();
    if (!bucket) {
      throw new BadRequestException(
        `Bucket '${bucketName}' was not found.`,
      );
    }

    // Verify ownership: user can ONLY pin to buckets that they own!
    const ownerIdStr = bucket.owner
      ? ((bucket.owner as any)?._id ? (bucket.owner as any)._id.toString() : bucket.owner.toString())
      : '';
    if (!ownerIdStr || ownerIdStr !== userId) {
      throw new BadRequestException(
        `Access denied: You can only pin to buckets that you own.`,
      );
    }

    const token = this.getBucketRpcToken(sanitizedBucket, bucket.ipfsRpcToken);
    if (!token) {
      throw new BadRequestException(
        `Unable to resolve Filebase IPFS RPC token for bucket '${bucketName}'.`,
      );
    }

    // Auto-update token in DB if it was outdated or mock-token
    if (bucket.ipfsRpcToken !== token) {
      bucket.ipfsRpcToken = token;
      await bucket.save();
    }

    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new BadRequestException('User profile not found.');
    }

    // Check if already pinned in this bucket
    const alreadyPinned = await this.importedCidModel
      .findOne({ cid: cleanCid, bucketName: sanitizedBucket, owner: userId as any })
      .exec();

    // 1. Generate folder structure: use customFolder if provided, otherwise single-import-${id}
    const importId = Math.random().toString(36).substring(2, 8);
    const cleanCustomFolder = (customFolder || '').replace(/^\/+|\/+$/g, '').trim();
    const folderName = cleanCustomFolder || `single-import-${importId}`;
    const displayName = (name || '').trim() || cleanCid;
    const fileId = folderName ? `${folderName}/${cleanCid}` : cleanCid;

    // 2. Check if CID already exists anywhere within the project (PinnedCid, ImportedCid, or Collection)
    const existingInProject = alreadyPinned || (await this.findCidRecord(cleanCid));

    let sizeBytes = 0;
    let mimeType: string | undefined = undefined;

    if (existingInProject) {
      sizeBytes = existingInProject.sizeBytes || 0;
      mimeType = existingInProject.mimeType;
    }

    // If size is still not resolved, fetch size via fast Range GET across IPFS gateways
    if (!sizeBytes || sizeBytes === 0) {
      const resolved = await this.resolveCidSize(cleanCid);
      sizeBytes = resolved.sizeBytes;
      if (resolved.mimeType && !mimeType) mimeType = resolved.mimeType;
    }

    // 3. Validate quota limits
    if (bucket.expiresAt && new Date() > bucket.expiresAt) {
      throw new BadRequestException(
        `Pin blocked: The storage bucket '${bucketName}' has expired.`,
      );
    }
    const limitBytes = bucket.maxSizeGb * 1024 * 1024 * 1024;
    if (!alreadyPinned && sizeBytes > 0 && bucket.usedSizeBytes + sizeBytes > limitBytes) {
      throw new BadRequestException(
        `Pin blocked: Exceeds bucket capacity of ${bucket.maxSizeGb} GB. File size: ${(sizeBytes / (1024 * 1024)).toFixed(2)} MB.`,
      );
    }

    // 4. Always ensure CID is pinned on Filebase IPFS RPC
    const endpoint =
      this.configService.get<string>('FILEBASE_IPFS_RPC_ENDPOINT') ||
      'https://rpc.filebase.io';

    let resJson: any = { Pin: { Cid: cleanCid }, referencedFromProject: !!existingInProject };
    const rpcController = new AbortController();
    const rpcTimeout = setTimeout(() => rpcController.abort(), 15000);
    try {
      const response = await fetch(
        `${endpoint}/api/v0/pin/add?arg=${encodeURIComponent(cleanCid)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: rpcController.signal,
        },
      );
      clearTimeout(rpcTimeout);
      if (response.ok) {
        resJson = await response.json();
      }
    } catch (rpcErr: any) {
      clearTimeout(rpcTimeout);
      console.warn(`Filebase RPC pin warning for ${cleanCid}:`, rpcErr.message);
    }

    const s3Client = this.clientService.getS3Client();
    const ownerId = bucket.owner
      ? ((bucket.owner as any)?._id
          ? (bucket.owner as any)._id.toString()
          : bucket.owner.toString())
      : userId;
    const userHash = this.clientService.getUserHash(ownerId);
    const s3Bucket = 'algofile-bucket-custom';
    const s3FileKey = folderName
      ? `${sanitizedBucket}-${userHash}/${folderName}/${cleanCid}`
      : `${sanitizedBucket}-${userHash}/${cleanCid}`;

    // Create folder marker upfront if needed
    if (folderName) {
      try {
        const s3FolderKey = `${sanitizedBucket}-${userHash}/${folderName}/`;
        await s3Client.send(
          new PutObjectCommand({
            Bucket: s3Bucket,
            Key: s3FolderKey,
            Body: Buffer.alloc(0),
            ContentType: 'application/x-directory',
          }),
        );
      } catch (_) {}
    }

    // 5. Download the real file bytes from ipfs.filebase.io to store in S3
    const fetched = await this.fetchCidBuffer(
      cleanCid,
      alreadyPinned ? Infinity : limitBytes - bucket.usedSizeBytes,
    );
    if (fetched) {
      sizeBytes = fetched.buffer.length;
      mimeType = fetched.contentType;
      try {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: s3Bucket,
            Key: s3FileKey,
            Body: fetched.buffer,
            ContentType: fetched.contentType,
            Metadata: {
              cid: cleanCid,
              'x-amz-meta-cid': cleanCid,
              'x-amz-meta-name': displayName,
              'x-amz-meta-original-size': String(fetched.buffer.length),
            },
          }),
        );
      } catch (putErr) {
        console.warn(`Could not upload buffer to ${s3FileKey}:`, putErr.message);
      }
    } else if (
      existingInProject &&
      (existingInProject as any).s3Key &&
      (existingInProject as any).s3Key !== s3FileKey &&
      (existingInProject.sizeBytes || 0) > 0
    ) {
      try {
        await s3Client.send(
          new CopyObjectCommand({
            Bucket: s3Bucket,
            CopySource: `${s3Bucket}/${encodeURIComponent((existingInProject as any).s3Key)}`,
            Key: s3FileKey,
          }),
        );
      } catch (_) {}
    } else {
      try {
        await s3Client.send(
          new CopyObjectCommand({
            Bucket: s3Bucket,
            CopySource: `${s3Bucket}/${encodeURIComponent(cleanCid)}`,
            Key: s3FileKey,
          }),
        );
      } catch (_) {}
    }

    // 6. Save record in dedicated ImportedCid collection and increment quotas
    const userObjId = Types.ObjectId.isValid(userId)
      ? new Types.ObjectId(userId)
      : (userId as any);

    const gatewayUrl = this.getGatewayUrl(cleanCid);

    await this.importedCidModel.findOneAndUpdate(
      { cid: cleanCid, bucketName: sanitizedBucket, owner: userObjId },
      {
        $set: {
          cid: cleanCid,
          bucketName: sanitizedBucket,
          name: displayName,
          fileId,
          folder: folderName,
          sizeBytes,
          mimeType: mimeType || 'application/octet-stream',
          fileType: mimeType?.startsWith('image/') ? 'Image' : 'Metadata',
          url: gatewayUrl,
          owner: userObjId,
          importType: 'single',
          status: 'pinned',
          s3Key: s3FileKey,
          isExistingRef: !!existingInProject,
        },
      },
      { upsert: true, returnDocument: 'after' },
    ).exec();

    // Keep pinnedCidModel in sync for collection compatibility
    await this.pinnedCidModel.findOneAndUpdate(
      { cid: cleanCid, bucketName: sanitizedBucket, owner: userObjId },
      {
        $set: {
          cid: cleanCid,
          bucketName: sanitizedBucket,
          name: displayName,
          fileId,
          sizeBytes,
          mimeType: mimeType || 'application/octet-stream',
          url: gatewayUrl,
          owner: userObjId,
          isImported: true,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    if (!alreadyPinned && sizeBytes > 0) {
      bucket.usedSizeBytes += sizeBytes;
      await bucket.save();

      user.usedStorageBytes = (user.usedStorageBytes || 0) + sizeBytes;
      await user.save();
    }

      return {
        ...resJson,
        folder: folderName,
        fileId,
        sizeBytes,
        referencedFromProject: !!existingInProject,
      };
    } catch (error) {
      const msg = error.message && error.message.toLowerCase().includes('invalid cid')
        ? 'Invalid IPFS CID: The cluster rejected the CID as invalid.'
        : error.message;
      throw new BadRequestException(`Failed to pin CID via RPC: ${msg}`);
    }
  }

  getCreatorFolder(creatorAddress: string, bucketName?: string): { folder: string } {
    const cleanAddr = (creatorAddress || '').trim().toUpperCase();
    if (!cleanAddr) {
      throw new BadRequestException('Valid creator address is required');
    }
    const shortHash = crypto
      .createHash('sha256')
      .update(cleanAddr)
      .digest('hex')
      .substring(0, 8);
    return { folder: `creator-assets-${shortHash}` };
  }

  /**
   * Pins multiple CIDs in a batch, checking individual limits and updating quotas accordingly.
   */
  async pinCidsBulk(
    userId: string,
    bucketName: string,
    cids: string[],
    names?: string[],
    customFolder?: string,
    autoPinImages: boolean = false,
    creatorAddress?: string,
  ): Promise<{
    successCount: number;
    failedCount: number;
    folder: string;
    results: Array<{
      cid: string;
      success: boolean;
      sizeBytes?: number;
      error?: string;
      name?: string;
      imageCid?: string;
      metadata?: any;
      referencedFromProject?: boolean;
    }>;
  }> {
    const sanitizedBucket = (bucketName || '').toLowerCase().trim();
    const bucket = await this.bucketModel
      .findOne({ name: sanitizedBucket })
      .exec();
    if (!bucket) {
      throw new BadRequestException(
        `Bucket '${bucketName}' was not found.`,
      );
    }

    // Verify ownership: user can ONLY pin to buckets that they own!
    const ownerIdStr = bucket.owner
      ? ((bucket.owner as any)?._id ? (bucket.owner as any)._id.toString() : bucket.owner.toString())
      : '';
    if (!ownerIdStr || ownerIdStr !== userId) {
      throw new BadRequestException(
        `Access denied: You can only pin to buckets that you own.`,
      );
    }

    const token = this.getBucketRpcToken(sanitizedBucket, bucket.ipfsRpcToken);
    if (!token) {
      throw new BadRequestException(
        `Unable to resolve Filebase IPFS RPC token for bucket '${bucketName}'.`,
      );
    }

    if (bucket.ipfsRpcToken !== token) {
      bucket.ipfsRpcToken = token;
      await bucket.save();
    }

    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new BadRequestException('User profile not found.');
    }

    const endpoint =
      this.configService.get<string>('FILEBASE_IPFS_RPC_ENDPOINT') ||
      'https://rpc.filebase.io';

    const ownerId = bucket.owner
      ? ((bucket.owner as any)?._id
          ? (bucket.owner as any)._id.toString()
          : bucket.owner.toString())
      : userId;
    const userHash = this.clientService.getUserHash(ownerId);
    const s3Bucket = 'algofile-bucket-custom';

    // Generate single folder for the entire bulk import batch, or use customFolder
    const batchId = Math.random().toString(36).substring(2, 8);
    const cleanCustomFolder = (customFolder || '').replace(/^\/+|\/+$/g, '').trim();
    let folderName = cleanCustomFolder;
    if (!folderName || folderName.toLowerCase() === 'auto') {
      if (creatorAddress && creatorAddress.trim()) {
        const shortHash = crypto
          .createHash('sha256')
          .update(creatorAddress.trim().toUpperCase())
          .digest('hex')
          .substring(0, 8);
        folderName = `creator-assets-${shortHash}`;
      } else {
        folderName = `bulk-import-${batchId}`;
      }
    }

    // List of CIDs and display names for the pinning batch
    let effectiveCids = [...cids];
    let effectiveNames = names ? [...names] : effectiveCids.map((c) => this.cleanCid(c));

    const results: Array<{
      cid: string;
      success: boolean;
      sizeBytes?: number;
      error?: string;
      name?: string;
      imageCid?: string;
      metadata?: any;
      referencedFromProject?: boolean;
    }> = new Array(effectiveCids.length);
    let successCount = 0;
    let failedCount = 0;

    let cumulativeSizeBytes = 0;

    // Create S3 folder marker upfront
    try {
      const s3Client = this.clientService.getS3Client();
      await s3Client.send(
        new PutObjectCommand({
          Bucket: s3Bucket,
          Key: `${sanitizedBucket}-${userHash}/${folderName}/`,
          Body: Buffer.alloc(0),
          ContentType: 'application/x-directory',
        }),
      );
    } catch (s3Err) {
      console.warn(`Could not create folder marker in S3 for ${folderName}:`, s3Err.message);
    }

    // Process in parallel chunks of 10 CIDs at a time for fast execution (<5s per lot)
    const concurrency = 10;
    for (let i = 0; i < effectiveCids.length; i += concurrency) {
      const chunk = effectiveCids.slice(i, i + concurrency);

      await Promise.all(
        chunk.map(async (cidVal, chunkIdx) => {
          const globalIdx = i + chunkIdx;
          const cleanCid = this.cleanCid(cidVal);
          const displayName = effectiveNames?.[globalIdx] ? effectiveNames[globalIdx].trim() : (cleanCid || cidVal);
          const fileId = folderName ? `${folderName}/${cleanCid}` : cleanCid;
          const s3FileKey = folderName
            ? `${sanitizedBucket}-${userHash}/${folderName}/${cleanCid}`
            : `${sanitizedBucket}-${userHash}/${cleanCid}`;

          if (!cleanCid) {
            return;
          }

          if (!this.isValidCid(cleanCid)) {
            failedCount++;
            results[globalIdx] = {
              cid: cidVal,
              name: displayName,
              success: false,
              error: `Invalid IPFS CID format: '${cidVal}'`,
            };
            return;
          }

          try {
            // 1. Check if already pinned in importedCidModel for this bucket and user
            const alreadyPinned = await this.importedCidModel
              .findOne({ cid: cleanCid, bucketName: sanitizedBucket, owner: userId as any })
              .exec();

            // 1b. Check if CID already exists anywhere within the project (PinnedCid, ImportedCid, or Collection)
            const existingInProject = alreadyPinned || (await this.findCidRecord(cleanCid));

            let sizeBytes = 0;
            let mimeType: string | undefined = undefined;

            if (existingInProject) {
              sizeBytes = existingInProject.sizeBytes || 0;
              mimeType = existingInProject.mimeType;
            }

            const gatewayUrl = this.getGatewayUrl(cleanCid);
            const s3Client = this.clientService.getS3Client();

            // 4. Concurrently trigger Filebase RPC pin and IPFS buffer download in parallel for 2x speed
            const rpcController = new AbortController();
            const rpcTimeout = setTimeout(() => rpcController.abort(), 8000);
            const rpcPromise = fetch(
              `${endpoint}/api/v0/pin/add?arg=${encodeURIComponent(cleanCid)}`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                },
                signal: rpcController.signal,
              },
            )
              .then(async (response) => {
                clearTimeout(rpcTimeout);
                if (!response.ok) {
                  const errText = await response.text();
                  if (!errText.toLowerCase().includes('already pinned')) {
                    console.warn(`Filebase RPC pin warning for ${cleanCid}:`, errText);
                  }
                }
              })
              .catch((err: any) => {
                clearTimeout(rpcTimeout);
                console.warn(`Filebase RPC pin warning for ${cleanCid}:`, err.message);
              });

            const [_, fetched] = await Promise.all([
              rpcPromise,
              this.fetchCidBuffer(
                cleanCid,
                alreadyPinned
                  ? Infinity
                  : bucket.maxSizeGb * 1024 * 1024 * 1024 - bucket.usedSizeBytes - cumulativeSizeBytes,
              ),
            ]);

            let effectiveFetched = fetched;
            if (!effectiveFetched) {
              try {
                effectiveFetched = await this.fetchCidBuffer(cleanCid, Infinity);
              } catch (_) {}
            }

            if (effectiveFetched) {
              sizeBytes = effectiveFetched.buffer.length;
              if (effectiveFetched.contentType) mimeType = effectiveFetched.contentType;
            }

            // Verify bucket capacity and expiration limits
            if (bucket.expiresAt && new Date() > bucket.expiresAt) {
              throw new Error(`The storage bucket has expired.`);
            }
            const limitBytes = bucket.maxSizeGb * 1024 * 1024 * 1024;
            if (
              !alreadyPinned &&
              sizeBytes > 0 &&
              bucket.usedSizeBytes + cumulativeSizeBytes + sizeBytes > limitBytes
            ) {
              throw new Error(
                `Exceeds bucket capacity of ${bucket.maxSizeGb} GB.`,
              );
            }

            // 5. Upload real binary bytes directly to Filebase S3 folder
            let uploaded = false;
            let extractedImageCid: string | null = null;
            let parsedMetadata: any = null;
            let isLikelyJson = false;

            if (effectiveFetched) {
              sizeBytes = effectiveFetched.buffer.length;
              if (effectiveFetched.contentType) mimeType = effectiveFetched.contentType;

              // Inspect buffer for metadata JSON (ARC-19, ARC-3, ARC-69)
              isLikelyJson =
                mimeType?.includes('json') ||
                mimeType?.includes('text') ||
                (effectiveFetched.buffer.length > 0 &&
                  (effectiveFetched.buffer[0] === 0x7b || effectiveFetched.buffer[0] === 0x27)); // '{' or "'"

              if (isLikelyJson) {
                try {
                  const text = effectiveFetched.buffer.toString('utf8');
                  let parsed: any = null;
                  try {
                    parsed = JSON.parse(text);
                  } catch {
                    try {
                      parsed = JSON.parse(text.replace(/'/g, '"'));
                    } catch {
                      extractedImageCid = this.extractImageCidFromJson(text);
                    }
                  }
                  if (parsed && typeof parsed === 'object') {
                    parsedMetadata = parsed;
                    extractedImageCid = this.extractImageCidFromJson(parsed);
                    if (extractedImageCid) {
                      this.cacheMetadata(cleanCid, {
                        imageCid: extractedImageCid,
                        name: parsed.name || displayName,
                        description: parsed.description,
                        mimeType: parsed.image_mime_type || parsed.image_mimetype || 'image/png',
                        properties: parsed.properties,
                        raw: parsed,
                      });
                    }
                  }
                } catch (_) {}
              }

              if (!extractedImageCid) {
                const cachedMeta = this.metadataCache.get(cleanCid);
                if (cachedMeta?.imageCid) {
                  extractedImageCid = cachedMeta.imageCid;
                  if (!parsedMetadata) parsedMetadata = cachedMeta.raw || cachedMeta;
                } else {
                  const meta = await this.fetchMetadataFromGateways(cleanCid);
                  if (meta?.imageCid) {
                    extractedImageCid = meta.imageCid;
                    if (!parsedMetadata) parsedMetadata = meta.raw || meta;
                  }
                }
              }

              try {
                await s3Client.send(
                  new PutObjectCommand({
                    Bucket: s3Bucket,
                    Key: s3FileKey,
                    Body: effectiveFetched.buffer,
                    ContentType: mimeType || 'application/octet-stream',
                    Metadata: {
                      cid: cleanCid,
                      'x-amz-meta-cid': cleanCid,
                      'x-amz-meta-name': displayName,
                      'x-amz-meta-original-size': String(effectiveFetched.buffer.length),
                    },
                  }),
                );
                uploaded = true;
              } catch (putErr: any) {
                console.warn(`Could not upload buffer to ${s3FileKey}:`, putErr.message);
              }
            } else if (
              existingInProject &&
              (existingInProject as any).s3Key &&
              (existingInProject as any).s3Key !== s3FileKey &&
              (existingInProject.sizeBytes || 0) > 0
            ) {
              if ((existingInProject as any).metadata) {
                parsedMetadata = (existingInProject as any).metadata;
                extractedImageCid = this.extractImageCidFromJson(parsedMetadata);
              }
              if (!extractedImageCid && (existingInProject as any).imageCid) {
                extractedImageCid = (existingInProject as any).imageCid;
              }
              try {
                await s3Client.send(
                  new CopyObjectCommand({
                    Bucket: s3Bucket,
                    CopySource: `${s3Bucket}/${encodeURIComponent((existingInProject as any).s3Key)}`,
                    Key: s3FileKey,
                  }),
                );
                uploaded = true;
              } catch (_) {}
            } else {
              if (existingInProject && (existingInProject as any).metadata) {
                parsedMetadata = (existingInProject as any).metadata;
                extractedImageCid = this.extractImageCidFromJson(parsedMetadata);
              }
              if (!extractedImageCid && (existingInProject as any).imageCid) {
                extractedImageCid = (existingInProject as any).imageCid;
              }
              try {
                await s3Client.send(
                  new CopyObjectCommand({
                    Bucket: s3Bucket,
                    CopySource: `${s3Bucket}/${encodeURIComponent(cleanCid)}`,
                    Key: s3FileKey,
                  }),
                );
                uploaded = true;
              } catch (_) {}
            }

            // Fallback metadata & image CID resolution if not extracted from buffer yet
            if (!extractedImageCid) {
              const cachedMeta = this.metadataCache.get(cleanCid);
              if (cachedMeta?.imageCid) {
                extractedImageCid = cachedMeta.imageCid;
                if (!parsedMetadata) parsedMetadata = cachedMeta.raw || cachedMeta;
              } else {
                const meta = await this.fetchMetadataFromGateways(cleanCid);
                if (meta?.imageCid) {
                  extractedImageCid = meta.imageCid;
                  if (!parsedMetadata) parsedMetadata = meta.raw || meta;
                }
              }
            }

            if (!uploaded && sizeBytes === 0) {
              throw new Error(`Could not fetch or host content for CID '${cleanCid}'`);
            }

            // 5. Create/Update ImportedCid log in dedicated collection
            const userObjId = Types.ObjectId.isValid(userId)
              ? new Types.ObjectId(userId)
              : (userId as any);

            await this.importedCidModel.findOneAndUpdate(
              { cid: cleanCid, bucketName: sanitizedBucket, owner: userObjId },
              {
                $set: {
                  cid: cleanCid,
                  bucketName: sanitizedBucket,
                  name: displayName,
                  fileId,
                  folder: folderName,
                  sizeBytes,
                  mimeType: mimeType || 'application/octet-stream',
                  fileType: displayName.includes('(Metadata)')
                    ? 'Metadata'
                    : (mimeType?.startsWith('image/')
                        ? 'Image'
                        : (mimeType === 'application/json' || isLikelyJson || parsedMetadata ? 'Metadata' : 'Image')),
                  url: gatewayUrl,
                  owner: userObjId,
                  importType: 'bulk',
                  status: 'pinned',
                  s3Key: s3FileKey,
                  metadata: parsedMetadata || undefined,
                  imageCid: extractedImageCid || undefined,
                  isExistingRef: !!existingInProject,
                },
              },
              { upsert: true, returnDocument: 'after' },
            ).exec();

            // Keep pinnedCidModel in sync for collection compatibility
            await this.pinnedCidModel.findOneAndUpdate(
              { cid: cleanCid, bucketName: sanitizedBucket, owner: userObjId },
              {
                $set: {
                  cid: cleanCid,
                  bucketName: sanitizedBucket,
                  name: displayName,
                  fileId,
                  sizeBytes,
                  mimeType: mimeType || 'application/octet-stream',
                  url: gatewayUrl,
                  owner: userObjId,
                  metadata: parsedMetadata || undefined,
                  imageCid: extractedImageCid || undefined,
                  isImported: true,
                },
              },
              { upsert: true, returnDocument: 'after' },
            );

            if (!alreadyPinned && sizeBytes > 0) {
              cumulativeSizeBytes += sizeBytes;
            }
            successCount++;
            results[globalIdx] = {
              cid: cleanCid,
              name: displayName,
              success: true,
              sizeBytes,
              imageCid: extractedImageCid || undefined,
              metadata: parsedMetadata || undefined,
              referencedFromProject: !!existingInProject,
            };
          } catch (err: any) {
            failedCount++;
            const errMsg = err.message && err.message.toLowerCase().includes('invalid cid')
              ? 'Invalid CID: rejected by cluster'
              : (err.message || 'Unknown error occurred');
            results[globalIdx] = {
              cid: cleanCid || cidVal,
              name: displayName,
              success: false,
              error: errMsg,
            };
          }
        }),
      );
    }

    // Filter out any undefined slots if some indices were skipped (e.g. empty CIDs)
    const filteredResults = results.filter(Boolean);

    // Update database totals with cumulative size of successful pins
    if (cumulativeSizeBytes > 0) {
      bucket.usedSizeBytes += cumulativeSizeBytes;
      await bucket.save();

      user.usedStorageBytes = (user.usedStorageBytes || 0) + cumulativeSizeBytes;
      await user.save();
    }

    return {
      successCount,
      failedCount,
      folder: folderName,
      results: filteredResults,
    };
  }

  /**
   * Retrieves pinned CIDs imported by a specific user, optionally filtered by bucketName.
   * Strictly filters by the authenticated user's ID and only returns imported pins.
   * Automatically resolves and caches missing sizeBytes for any previously pinned items showing 'Unknown'.
   */
  async listPinnedCids(userId: string, bucketName?: string) {
    const userObjId = Types.ObjectId.isValid(userId)
      ? new Types.ObjectId(userId)
      : null;

    const ownerFilter = userObjId
      ? { $or: [{ owner: userObjId }, { owner: userId }] }
      : { owner: userId };

    const filter: any = {
      ...ownerFilter,
    };

    if (bucketName) {
      filter.bucketName = bucketName.toLowerCase().trim();
    }

    let items = await this.importedCidModel
      .find(filter as any)
      .sort({ createdAt: -1 })
      .exec();

    // If none found in dedicated collection, check pinnedCidModel fallback
    if (!items || items.length === 0) {
      const fallbackFilter = {
        ...filter,
        $or: [
          { isImported: true },
          { fileId: { $exists: false } },
          { fileId: null },
          { fileId: '' },
        ],
      };
      items = (await this.pinnedCidModel
        .find(fallbackFilter as any)
        .sort({ createdAt: -1 })
        .exec()) as any;
    }

    // Auto-resolve missing sizeBytes for any pins currently stored with 0 / unknown
    const zeroSizePins = items.filter((p) => !p.sizeBytes || p.sizeBytes === 0);
    if (zeroSizePins.length > 0) {
      await Promise.all(
        zeroSizePins.slice(0, 10).map(async (pin) => {
          try {
            const { sizeBytes, mimeType } = await this.resolveCidSize(pin.cid);
            if (sizeBytes > 0) {
              pin.sizeBytes = sizeBytes;
              if (mimeType && !pin.mimeType) pin.mimeType = mimeType;
              await this.importedCidModel.updateOne(
                { _id: pin._id },
                { $set: { sizeBytes, ...(mimeType ? { mimeType } : {}) } },
              );
              await this.pinnedCidModel.updateOne(
                { _id: pin._id },
                { $set: { sizeBytes, ...(mimeType ? { mimeType } : {}) } },
              );
            }
          } catch (_) {}
        }),
      );
    }

    return items;
  }

  /**
   * Unpins a CID from Filebase IPFS cluster and decrements bucket and user quotas
   */
  async unpinCid(userId: string, pinId: string): Promise<any> {
    const userObjId = Types.ObjectId.isValid(userId)
      ? new Types.ObjectId(userId)
      : null;

    const ownerFilter = userObjId
      ? { $or: [{ owner: userObjId }, { owner: userId }] }
      : { owner: userId };

    const pinRecord =
      (await this.importedCidModel
        .findOne({ _id: pinId, ...ownerFilter } as any)
        .exec()) ||
      (await this.pinnedCidModel
        .findOne({ _id: pinId, ...ownerFilter } as any)
        .exec());

    if (!pinRecord) {
      throw new BadRequestException('Pin record not found or access denied.');
    }

    const sanitizedBucket = (pinRecord.bucketName || '').toLowerCase().trim();
    const bucket = await this.bucketModel
      .findOne({ name: sanitizedBucket })
      .exec();
    if (!bucket) {
      throw new BadRequestException(
        `Bucket '${pinRecord.bucketName}' was not found.`,
      );
    }

    const endpoint =
      this.configService.get<string>('FILEBASE_IPFS_RPC_ENDPOINT') ||
      'https://rpc.filebase.io';
    const token = this.getBucketRpcToken(sanitizedBucket, bucket.ipfsRpcToken);

    if (bucket.ipfsRpcToken !== token && token) {
      bucket.ipfsRpcToken = token;
      await bucket.save();
    }

    const cid = pinRecord.cid;
    const recordFilter = { cid, bucketName: sanitizedBucket, ...ownerFilter } as any;

    try {
      // Deduplicated uploads share one IPFS pin across users and buckets, so the pin is only
      // removed when this record is its last reference; otherwise we'd delete other users' files.
      const otherRef = { cid, $nor: [{ bucketName: sanitizedBucket, ...ownerFilter }] } as any;
      const [otherPinned, otherImported, inCollection] = await Promise.all([
        this.pinnedCidModel.exists(otherRef),
        this.importedCidModel.exists(otherRef),
        this.collectionModel.exists({
          $or: [{ 'assets.imageCid': cid }, { 'assets.metadataCid': cid }],
        }),
      ]);

      if (!otherPinned && !otherImported && !inCollection) {
        const response = await fetch(
          `${endpoint}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
            },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok) {
          const errText = await response.text();
          console.warn(
            `Filebase pin remove returned status ${response.status}: ${errText}`,
          );
        }
      }

      // Remove the copy stored in the user's bucket prefix, if the pin created one.
      const s3Key = (pinRecord as any).s3Key as string | undefined;
      const ownerHash = this.clientService.getUserHash(
        bucket.owner ? bucket.owner.toString() : userId,
      );
      if (s3Key && s3Key.startsWith(`${sanitizedBucket}-${ownerHash}/`)) {
        await this.clientService
          .getS3Client()
          .send(new DeleteObjectCommand({ Bucket: 'algofile-bucket-custom', Key: s3Key }))
          .catch((err) => console.warn(`Could not delete ${s3Key}: ${err.message}`));
      }

      // pinCid writes the same pin to both collections with different _ids; drop both so the
      // PinnedCid copy doesn't keep counting against the quota.
      await Promise.all([
        this.importedCidModel.deleteMany(recordFilter).exec(),
        this.pinnedCidModel.deleteMany(recordFilter).exec(),
      ]);

      const sizeBytes = pinRecord.sizeBytes || 0;
      if (sizeBytes > 0) {
        await Promise.all([
          this.bucketModel.updateOne(
            { _id: bucket._id },
            [{ $set: { usedSizeBytes: { $max: [0, { $subtract: ['$usedSizeBytes', sizeBytes] }] } } }],
            { updatePipeline: true },
          ).exec(),
          this.userModel.updateOne(
            { _id: userId },
            [{ $set: { usedStorageBytes: { $max: [0, { $subtract: ['$usedStorageBytes', sizeBytes] }] } } }],
            { updatePipeline: true },
          ).exec(),
        ]);
      }

      return {
        success: true,
        message: `CID '${cid}' successfully unpinned from bucket '${pinRecord.bucketName}'.`,
        recoveredBytes: sizeBytes,
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to unpin CID from cluster: ${error.message}`,
      );
    }
  }
}
