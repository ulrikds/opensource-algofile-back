import { Injectable, BadRequestException } from '@nestjs/common';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Bucket, BucketDocument } from '../schemas/bucket.schema';
import * as crypto from 'crypto';

const CID_METADATA_KEYS = [
  'cid',
  'ipfs-cid',
  'ipfs_cid',
  'ipfscid',
  'ipfs-hash',
  'ipfs_hash',
  'ipfshash',
  'ipfs_pin_hash',
  'ipfs-pin-hash',
];

/** Finds the IPFS CID Filebase attaches to an object, under whichever metadata key it used. */
export function extractCidFromMetadata(
  metadata?: Record<string, string>,
  headers?: Record<string, string>,
): string | undefined {
  for (const k of CID_METADATA_KEYS) {
    if (metadata?.[k]) return metadata[k];
  }
  const fromHeaders = headers?.['x-amz-meta-cid'] || headers?.['cid'] || headers?.['x-amz-ipfs-cid'];
  if (fromHeaders) return fromHeaders;
  for (const [k, v] of Object.entries(metadata || {})) {
    const key = k.toLowerCase();
    if (
      typeof v === 'string' &&
      (/^(Qm|bafy|bafk|bafz)/.test(v) || key.includes('cid') || key.includes('ipfs'))
    ) {
      return v;
    }
  }
  return undefined;
}

@Injectable()
export class FilebaseClientService {
  private readonly s3Client: S3Client;

  constructor(
    @InjectModel(Bucket.name) private readonly bucketModel: Model<BucketDocument>,
    private readonly configService: ConfigService,
  ) {
    process.env.AWS_SDK_JS_SUPPRESS_NODE_JS_WARNING = '1';
    const endpoint =
      this.configService.get<string>('FILEBASE_ENDPOINT') ||
      'https://s3.filebase.io';
    const accessKeyId = this.configService.get<string>(
      'FILEBASE_ACCESS_KEY_ID',
    );
    const secretAccessKey = this.configService.get<string>(
      'FILEBASE_SECRET_ACCESS_KEY',
    );

    if (!accessKeyId || !secretAccessKey) {
      console.warn(
        'Filebase Access Key ID or Secret Access Key is not defined in the environment variables.',
      );
    }

    this.s3Client = new S3Client({
      endpoint,
      region: 'auto',
      credentials: {
        accessKeyId: accessKeyId || 'placeholder-key',
        secretAccessKey: secretAccessKey || 'placeholder-secret',
      },
      forcePathStyle: true,
    });
  }

  getS3Client(): S3Client {
    return this.s3Client;
  }

  getUserHash(userId: string): string {
    return crypto
      .createHash('sha256')
      .update(userId)
      .digest('hex')
      .substring(0, 12);
  }

  isCustomStorageBucket(bucket: any, name: string): boolean {
    return true;
  }

  async getS3Params(
    bucketName: string,
    userId: string,
    key?: string,
  ): Promise<{ s3Bucket: string; s3Key?: string }> {
    const sanitizedBucket = bucketName.toLowerCase().trim();
    const bucket = await this.bucketModel
      .findOne({ name: sanitizedBucket })
      .exec();

    const ownerId =
      bucket && bucket.owner
        ? (bucket.owner as any)?._id
          ? (bucket.owner as any)._id.toString()
          : bucket.owner.toString()
        : userId;
    const userHash = this.getUserHash(ownerId);
    const s3Bucket = 'algofile-bucket-custom';

    if (!key) {
      return { s3Bucket };
    }

    const prefix = `${sanitizedBucket}-${userHash}/`;
    const s3Key = key.startsWith(prefix) ? key : `${prefix}${key}`;
    return { s3Bucket, s3Key };
  }

  /**
   * Ownership plus expiry: the check every write path (direct upload, presigned URL, confirm) must pass.
   * The free bucket has no owner and is shared; its quota is enforced when the upload is confirmed.
   */
  async assertWritableBucket(userId: string, bucketName: string): Promise<BucketDocument> {
    const bucket = await this.verifyBucketOwnership(userId, bucketName);
    if (bucket.owner && bucket.expiresAt && new Date() > bucket.expiresAt) {
      throw new BadRequestException(
        `Upload blocked: The bucket '${bucket.name}' has expired on ${bucket.expiresAt.toLocaleString()}.`,
      );
    }
    return bucket;
  }

  /** HEADs an object and returns its real size and the IPFS CID Filebase stored in its metadata. */
  async headObjectInfo(
    s3Bucket: string,
    s3Key: string,
  ): Promise<{ cid?: string; sizeBytes: number }> {
    const head = await this.s3Client.send(
      new HeadObjectCommand({ Bucket: s3Bucket, Key: s3Key }),
    );
    return {
      cid: extractCidFromMetadata(head.Metadata, (head.$metadata as any)?.httpHeaders),
      sizeBytes: head.ContentLength || 0,
    };
  }

  async verifyBucketOwnership(userId: string, bucketName: string): Promise<BucketDocument> {
    const sanitized = bucketName.toLowerCase().trim();
    const bucket = await this.bucketModel.findOne({ name: sanitized }).exec();
    if (!bucket) {
      throw new BadRequestException(
        `Bucket '${bucketName}' is not registered on the platform.`,
      );
    }
    const isFreeBucket = !bucket.owner;
    if (!isFreeBucket && bucket.owner?.toString() !== userId) {
      throw new BadRequestException(
        `Access denied: You do not own the bucket '${bucketName}'.`,
      );
    }
    return bucket;
  }
}
