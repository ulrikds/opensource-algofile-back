import {
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import {
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import { Bucket, BucketDocument } from '../schemas/bucket.schema';
import { User, UserDocument } from '../../users/schemas/user.schema';
import { PinnedCid, PinnedCidDocument } from '../schemas/pinned-cid.schema';
import { ImportedCid, ImportedCidDocument } from '../schemas/imported-cid.schema';
import { FilebaseClientService } from './filebase-client.service';
import { FilebaseBucketService } from './filebase-bucket.service';
import { FilebasePinningService } from './filebase-pinning.service';
import { FilebaseFileExplorerService } from './filebase-file-explorer.service';
import { mapWithConcurrency } from '../../common/utils/concurrency';

const FREE_POOL_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB shared by every free user
const FREE_USER_LIMIT_BYTES = 250 * 1024 * 1024; // 250 MB per free user
const PRESIGNED_URL_TTL_SECONDS = 900;
const BULK_CONCURRENCY = 16;

type ExistingCid = NonNullable<Awaited<ReturnType<FilebasePinningService['findExistingCid']>>>;

@Injectable()
export class FilebaseUploadService {
  constructor(
    @InjectModel(Bucket.name)
    private readonly bucketModel: Model<BucketDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(PinnedCid.name)
    private readonly pinnedCidModel: Model<PinnedCidDocument>,
    @InjectModel(ImportedCid.name)
    private readonly importedCidModel: Model<ImportedCidDocument>,
    private readonly clientService: FilebaseClientService,
    private readonly bucketService: FilebaseBucketService,
    private readonly pinningService: FilebasePinningService,
    private readonly explorerService: FilebaseFileExplorerService,
  ) {}

  /** Zero-byte S3 object pointing at an already stored CID, so the file shows up in the bucket without re-uploading it. */
  private async putReferenceObject(
    userId: string,
    bucketName: string,
    key: string,
    existing: ExistingCid,
    sizeBytes: number,
    contentType?: string,
  ): Promise<void> {
    const { s3Bucket, s3Key } = await this.clientService.getS3Params(bucketName, userId, key);
    await this.clientService.getS3Client().send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: s3Key,
        Body: Buffer.alloc(0),
        ContentType: contentType || 'application/octet-stream',
        Metadata: {
          cid: existing.cid,
          'x-amz-meta-cid': existing.cid,
          'x-amz-meta-existing-ref': 'true',
          'x-amz-meta-original-size': String(sizeBytes),
          'x-amz-meta-source': existing.source || 'project-dedup',
        },
      }),
    );
  }

  private async addQuotaUsage(bucketName: string, userId: string, sizeBytes: number): Promise<void> {
    await Promise.all([
      this.bucketModel
        .updateOne({ name: bucketName.toLowerCase().trim() }, { $inc: { usedSizeBytes: sizeBytes } })
        .exec(),
      this.userModel
        .updateOne({ _id: new Types.ObjectId(userId) }, { $inc: { usedStorageBytes: sizeBytes } })
        .exec(),
    ]);
  }

  private buildUploadKey(fileName: string, folder?: string, index?: number): string {
    const cleanFolder = folder ? folder.replace(/^\/+|\/+$/g, '').trim() : '';
    const sanitizedFilename = fileName.replace(/[^a-zA-Z0-9.]/g, '_');
    const baseKey = index === undefined
      ? `${Date.now()}_${sanitizedFilename}`
      : `${Date.now()}_${index}_${sanitizedFilename}`;
    return cleanFolder ? `${cleanFolder}/${baseKey}` : baseKey;
  }

  /**
   * Core base upload function for any file (buffer) to Filebase S3 & IPFS.
   * Checks first if the file content (via SHA-256 hash) or CID already exists in Filebase / AlgoFile.
   * - If ALREADY EXISTS: Physical S3 upload to Filebase is skipped. A zero-upload reference object
   *   is placed in the importing user's bucket in S3, the weight is assigned to the bucket/user quota,
   *   and the file is registered in PinnedCid & ImportedCid.
   * - If NEW: Performs physical S3 upload, pins to IPFS, registers CID & SHA-256 hash.
   */
  async uploadFile(
    userId: string,
    bucketName: string,
    key: string,
    fileBuffer: Buffer,
    mimeType: string,
    options?: {
      providedCid?: string;
      providedFileHash?: string;
      updateQuota?: boolean;
    },
  ): Promise<{
    key: string;
    cid: string;
    url: string;
    sizeBytes: number;
    referencedFromProject?: boolean;
  }> {
    try {
      const fileHash =
        options?.providedFileHash ||
        crypto.createHash('sha256').update(fileBuffer).digest('hex');

      // 1. Base Deduplication Check: query PinnedCid, ImportedCid, and Collection
      const existing = await this.pinningService.findExistingCid(
        undefined,
        options?.providedCid,
        fileHash,
      );

      let cid: string;
      let url: string;
      let sizeBytes = fileBuffer.length;
      let isReferenced = false;

      if (existing) {
        // Content already stored: skip the physical upload and only place a reference object.
        cid = existing.cid;
        url = existing.url || this.pinningService.getGatewayUrl(cid);
        sizeBytes = existing.sizeBytes || fileBuffer.length;
        isReferenced = true;

        await this.putReferenceObject(userId, bucketName, key, existing, sizeBytes, mimeType);

        try {
          const userObjId = new Types.ObjectId(userId);
          await this.importedCidModel.findOneAndUpdate(
            {
              cid,
              bucketName: bucketName.toLowerCase().trim(),
              owner: userObjId as any,
            },
            {
              $set: {
                cid,
                bucketName: bucketName.toLowerCase().trim(),
                name: key.split('/').pop() || key,
                fileId: key,
                sizeBytes,
                mimeType,
                url,
                owner: userObjId as any,
                isExistingRef: true,
                fileHash,
              },
            },
            { upsert: true },
          ).exec();
        } catch (err) {
          console.warn('Could not record ImportedCid reference:', err?.message);
        }
      } else {
        const { s3Bucket, s3Key } = await this.clientService.getS3Params(
          bucketName,
          userId,
          key,
        );

        const putResponse = await this.clientService.getS3Client().send(
          new PutObjectCommand({
            Bucket: s3Bucket,
            Key: s3Key,
            Body: fileBuffer,
            ContentType: mimeType,
          }),
        );

        // Attempt to retrieve CID from HTTP response headers
        const headers = (putResponse.$metadata as any).httpHeaders || {};
        cid =
          headers['x-amz-meta-cid'] ||
          headers['cid'] ||
          headers['x-amz-ipfs-cid'];

        // Fallback to getFileMetadata with retries
        if (!cid) {
          const fileMetadata = await this.explorerService.getFileMetadata(
            userId,
            bucketName,
            key,
          );
          cid = fileMetadata.cid;
        }

        if (!cid) {
          throw new Error('IPFS CID was not returned by Filebase.');
        }
        url = this.pinningService.getGatewayUrl(cid);
      }

      // Always save CID record for the specified user and bucket (with fileHash for future deduplication)
      await this.pinningService.saveCidRecord({
        cid,
        bucketName,
        name: key,
        fileId: key,
        sizeBytes,
        mimeType,
        owner: userId,
        fileHash,
      });

      if (options?.updateQuota) {
        await this.addQuotaUsage(bucketName, userId, sizeBytes);
      }

      return {
        key,
        cid,
        url,
        sizeBytes,
        referencedFromProject: isReferenced,
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to upload file to Filebase: ${error.message}`,
      );
    }
  }

  /** Signs a PUT URL. With sizeBytes, Content-Length is part of the signature and S3 rejects any other size. */
  private async signPutUrl(
    userId: string,
    bucketName: string,
    key: string,
    contentType: string,
    sizeBytes?: number,
  ): Promise<string> {
    try {
      const { s3Bucket, s3Key } = await this.clientService.getS3Params(
        bucketName,
        userId,
        key,
      );

      const command = new PutObjectCommand({
        Bucket: s3Bucket,
        Key: s3Key,
        ContentType: contentType,
        ...(sizeBytes && sizeBytes > 0 ? { ContentLength: sizeBytes } : {}),
      });

      return await getSignedUrl(this.clientService.getS3Client(), command, {
        expiresIn: PRESIGNED_URL_TTL_SECONDS,
      });
    } catch (error) {
      throw new BadRequestException(
        `Failed to generate presigned upload URL: ${error.message}`,
      );
    }
  }

  /**
   * Generates a presigned S3 PUT URL for direct file upload from client to Filebase S3
   */
  async getPresignedUploadUrl(
    userId: string,
    bucketName: string,
    key: string,
    contentType: string,
    sizeBytes?: number,
  ): Promise<string> {
    // getS3Params resolves the prefix from the bucket OWNER, so without this check anyone could get
    // a URL that writes into another user's bucket.
    await this.clientService.assertWritableBucket(userId, bucketName);
    return this.signPutUrl(userId, bucketName, key, contentType, sizeBytes);
  }

  /**
   * Generates a presigned S3 PUT URL for direct browser uploads into a bucket.
   * If fileHash is provided and the file already exists in Filebase/project,
   * skips generating presigned URL, places the zero-upload S3 reference object
   * in the user's bucket, adds the weight to quota, and returns alreadyExists: true.
   */
  async generateBucketPresignedUrl(
    userId: string,
    bucketName: string,
    fileName: string,
    contentType?: string,
    folder?: string,
    fileHash?: string,
    sizeBytes?: number,
  ): Promise<{
    uploadUrl?: string;
    key: string;
    alreadyExists?: boolean;
    cid?: string;
    sizeBytes?: number;
    url?: string;
  }> {
    await this.clientService.assertWritableBucket(userId, bucketName);
    const key = this.buildUploadKey(fileName, folder);
    const referenced = await this.referenceExistingByHash(
      userId,
      bucketName,
      key,
      fileName,
      contentType,
      fileHash,
      sizeBytes,
    );
    if (referenced) return referenced;

    const uploadUrl = await this.signPutUrl(
      userId,
      bucketName,
      key,
      contentType || 'application/octet-stream',
      sizeBytes,
    );
    return { uploadUrl, key, alreadyExists: false };
  }

  /** Dedup path shared by the single and bulk presigned endpoints. Returns null when the hash is unknown. */
  private async referenceExistingByHash(
    userId: string,
    bucketName: string,
    key: string,
    fileName: string,
    contentType?: string,
    fileHash?: string,
    sizeBytes?: number,
  ): Promise<{
    key: string;
    alreadyExists: true;
    cid: string;
    sizeBytes: number;
    url: string;
  } | null> {
    if (!fileHash) return null;
    const existing = await this.pinningService.findExistingCid(undefined, undefined, fileHash);
    if (!existing) return null;

    const resolvedSize = existing.sizeBytes || sizeBytes || 0;
    await this.putReferenceObject(userId, bucketName, key, existing, resolvedSize, contentType);
    await this.pinningService.saveCidRecord({
      cid: existing.cid,
      bucketName,
      name: fileName,
      fileId: key,
      sizeBytes: resolvedSize,
      mimeType: contentType,
      owner: userId,
      fileHash,
    });
    await this.addQuotaUsage(bucketName, userId, resolvedSize);

    return {
      key,
      alreadyExists: true,
      cid: existing.cid,
      sizeBytes: resolvedSize,
      url: existing.url || this.pinningService.getGatewayUrl(existing.cid),
    };
  }

  /**
   * Generates presigned S3 PUT URLs in bulk for direct browser uploads.
   * Any items that already exist in Filebase/project are marked alreadyExists: true
   * with zero physical upload, zero-byte reference placed in S3, and quota attributed.
   */
  async generateBucketPresignedUrlsBulk(
    userId: string,
    bucketName: string,
    items: Array<{
      fileName: string;
      contentType?: string;
      fileHash?: string;
      sizeBytes?: number;
    }>,
    folder?: string,
  ): Promise<
    Array<{
      fileName: string;
      uploadUrl?: string;
      key: string;
      alreadyExists?: boolean;
      cid?: string;
      sizeBytes?: number;
      url?: string;
    }>
  > {
    await this.clientService.assertWritableBucket(userId, bucketName);

    return mapWithConcurrency(items, BULK_CONCURRENCY, async (item, idx) => {
      const key = this.buildUploadKey(item.fileName, folder, idx);
      const contentType = item.contentType || 'application/octet-stream';

      const referenced = await this.referenceExistingByHash(
        userId,
        bucketName,
        key,
        item.fileName,
        contentType,
        item.fileHash,
        item.sizeBytes,
      );
      if (referenced) return { fileName: item.fileName, ...referenced };

      const uploadUrl = await this.signPutUrl(
        userId,
        bucketName,
        key,
        contentType,
        item.sizeBytes,
      );
      return { fileName: item.fileName, uploadUrl, key, alreadyExists: false };
    });
  }

  /**
   * Confirms a direct S3 PUT upload: reads the real size and CID from S3, enforces the quota,
   * and registers the PinnedCid. Client-reported sizes are never trusted, since a presigned
   * upload can be any size the client chooses.
   */
  async confirmDirectUpload(
    userId: string,
    bucketName: string,
    key: string,
    originalName?: string,
    providedCid?: string,
    _providedSizeBytes?: number,
    options?: { skipRecalc?: boolean },
  ) {
    const sanitizedBucket = bucketName.toLowerCase().trim();
    const bucket = await this.clientService.assertWritableBucket(userId, sanitizedBucket);
    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new BadRequestException('User profile not found.');
    }

    const { s3Bucket, s3Key } = await this.clientService.getS3Params(sanitizedBucket, userId, key);
    // s3Key is `<bucket>-<ownerHash>/<relative key>`; bucket names never contain '/'.
    const relativeKey = s3Key!.slice(s3Key!.indexOf('/') + 1);
    const pinnedName = originalName || relativeKey.split('_').slice(1).join('_') || relativeKey;

    let cid: string | undefined;
    let sizeBytes = 0;
    try {
      const info = await this.clientService.headObjectInfo(s3Bucket, s3Key!);
      cid = info.cid;
      sizeBytes = info.sizeBytes;
    } catch (err) {
      throw new BadRequestException(`Uploaded object '${key}' was not found in storage.`);
    }
    cid = cid || providedCid;
    if (!cid) {
      // Filebase can attach the CID a moment after the PUT completes.
      cid = (await this.explorerService.getFileMetadata(userId, sanitizedBucket, relativeKey)).cid;
    }

    const userObjId = new Types.ObjectId(userId);
    let pinned = await this.pinnedCidModel.findOne({
      bucketName: sanitizedBucket,
      $or: [{ fileId: relativeKey }, { fileId: key }],
      owner: userObjId as any,
    }).exec();

    // Re-confirming the same key only charges the size difference.
    const deltaBytes = sizeBytes - (pinned?.sizeBytes || 0);
    const rejectAndDelete = async (message: string) => {
      await this.clientService.getS3Client()
        .send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: s3Key }))
        .catch(() => {});
      throw new BadRequestException(message);
    };

    if (!bucket.owner) {
      const currentPoolBytes = await this.bucketService.recalculateFreeBucketPoolStorage();
      if (currentPoolBytes + deltaBytes > FREE_POOL_LIMIT_BYTES) {
        await rejectAndDelete('Upload blocked: The shared global free pool limit of 10 GB is full.');
      }
      if ((user.usedStorageBytes || 0) + deltaBytes > FREE_USER_LIMIT_BYTES) {
        await rejectAndDelete('Upload blocked: Exceeds your free sandbox limit of 250 MB.');
      }
    } else {
      const limitBytes = bucket.maxSizeGb * 1024 * 1024 * 1024;
      if ((bucket.usedSizeBytes || 0) + deltaBytes > limitBytes) {
        await rejectAndDelete(
          `Upload blocked: This bucket has exceeded its storage limit of ${bucket.maxSizeGb} GB.`,
        );
      }
    }

    const gatewayUrl = this.pinningService.getGatewayUrl(cid);
    if (pinned) {
      pinned.cid = cid;
      pinned.name = pinnedName;
      pinned.fileId = relativeKey;
      pinned.sizeBytes = sizeBytes;
      pinned.url = gatewayUrl;
      await pinned.save();
    } else {
      pinned = await this.pinnedCidModel.create({
        owner: userObjId as any,
        bucketName: sanitizedBucket,
        cid,
        fileId: relativeKey,
        name: pinnedName,
        sizeBytes,
        url: gatewayUrl,
      });
    }

    if (options?.skipRecalc) {
      // Bulk confirm recalculates once at the end; keep the counters close in the meantime.
      await this.addQuotaUsage(sanitizedBucket, userId, deltaBytes);
    } else {
      await this.bucketService.recalculateUserStorageBytes(userId);
      await this.bucketService.recalculateBucketSizeBytes(sanitizedBucket, userId);
    }

    return {
      success: true,
      cid,
      key: relativeKey,
      name: pinnedName,
      sizeBytes,
      url: gatewayUrl,
      pinId: (pinned as any)._id?.toString(),
    };
  }

  /** Confirms many direct uploads with bounded concurrency and a single quota recalculation. */
  async confirmDirectUploadsBulk(
    userId: string,
    bucketName: string,
    items: Array<{ key: string; originalName?: string; cid?: string }>,
  ) {
    const results = await mapWithConcurrency(items, 8, (item) =>
      this.confirmDirectUpload(
        userId,
        bucketName,
        item.key,
        item.originalName,
        item.cid,
        undefined,
        { skipRecalc: true },
      ),
    );
    await this.bucketService.recalculateUserStorageBytes(userId);
    await this.bucketService.recalculateBucketSizeBytes(bucketName, userId);
    return { success: true, items: results };
  }

  /**
   * Handles server-side API file uploads directly with quota enforcement
   */
  async uploadFileViaApi(
    userId: string,
    bucketName: string,
    fileName: string,
    fileBuffer: Buffer,
    mimeType: string,
    folder?: string,
  ): Promise<{
    key: string;
    cid: string;
    url: string;
    sizeBytes: number;
    bucketName: string;
    referencedFromProject?: boolean;
  }> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new BadRequestException('User not found');
    }

    const targetBucketName = bucketName
      ? bucketName.toLowerCase().trim()
      : 'algofile-bucket-free';
    const bucket = await this.bucketModel
      .findOne({ name: targetBucketName })
      .exec();
    if (!bucket) {
      throw new BadRequestException(
        `Target S3 bucket '${targetBucketName}' is not registered on the platform.`,
      );
    }

    const isFreeBucket = !bucket.owner;
    const incomingSizeBytes = fileBuffer.length;

    if (isFreeBucket) {
      const currentPoolBytes = await this.bucketService.recalculateFreeBucketPoolStorage();
      if (currentPoolBytes + incomingSizeBytes > FREE_POOL_LIMIT_BYTES) {
        throw new BadRequestException(
          `Upload blocked: The shared global free pool limit of 10 GB is full. No user can upload to the free bucket until storage is cleared.`,
        );
      }

      if (user.usedStorageBytes + incomingSizeBytes > FREE_USER_LIMIT_BYTES) {
        const remainingUserBytes = FREE_USER_LIMIT_BYTES - user.usedStorageBytes;
        const remainingUserMb = Math.max(
          0,
          remainingUserBytes / (1024 * 1024),
        ).toFixed(2);
        throw new BadRequestException(
          `Upload blocked: You have exceeded your free sandbox limit of 250 MB. Remaining storage: ${remainingUserMb} MB. Please purchase a dedicated bucket in the dashboard.`,
        );
      }
    } else {
      if (bucket.owner?.toString() !== userId) {
        throw new BadRequestException(
          `Access denied: You do not own the bucket '${targetBucketName}'.`,
        );
      }

      if (bucket.expiresAt && new Date() > bucket.expiresAt) {
        throw new BadRequestException(
          `Upload blocked: The bucket '${targetBucketName}' has expired on ${bucket.expiresAt.toLocaleString()}.`,
        );
      }

      const limitBytes = bucket.maxSizeGb * 1024 * 1024 * 1024;
      if (bucket.usedSizeBytes + incomingSizeBytes > limitBytes) {
        const remainingBytes = limitBytes - bucket.usedSizeBytes;
        const remainingMb = Math.max(0, remainingBytes / (1024 * 1024)).toFixed(
          2,
        );
        throw new BadRequestException(
          `Upload blocked: This bucket has exceeded its storage limit of ${bucket.maxSizeGb} GB. Remaining storage: ${remainingMb} MB.`,
        );
      }
    }

    const cleanFolder = folder ? folder.replace(/^\/+|\/+$/g, '').trim() : '';
    const targetKey = cleanFolder ? `${cleanFolder}/${fileName}` : fileName;

    const uploadResult = await this.uploadFile(
      userId,
      targetBucketName,
      targetKey,
      fileBuffer,
      mimeType,
    );

    if (isFreeBucket) {
      await this.userModel
        .updateOne(
          { _id: userId },
          { $inc: { usedStorageBytes: incomingSizeBytes } },
        )
        .exec();
    } else {
      await this.addQuotaUsage(targetBucketName, userId, incomingSizeBytes);
    }

    return {
      key: uploadResult.key,
      cid: uploadResult.cid,
      url: uploadResult.url,
      sizeBytes: uploadResult.sizeBytes,
      bucketName: targetBucketName,
      referencedFromProject: uploadResult.referencedFromProject,
    };
  }

  /**
   * Confirms files uploaded through the paid API-key presigned flow: resolves the real size and CID
   * from S3 and registers the pins. Keys are always resolved inside the caller's bucket prefix.
   */
  async confirmPublicBulkUpload(
    userId: string,
    bucketName: string,
    items: Array<{
      key: string;
      originalName?: string;
      cid?: string;
    }>,
  ): Promise<{
    success: boolean;
    bucketName: string;
    items: Array<{
      key: string;
      fileName: string;
      cid: string;
      url: string;
      sizeBytes: number;
    }>;
  }> {
    const sanitizedBucket = bucketName.toLowerCase().trim();
    const userObjId = Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : null;

    const results = await mapWithConcurrency(items, BULK_CONCURRENCY, async (item) => {
      const { s3Bucket, s3Key } = await this.clientService.getS3Params(
        sanitizedBucket,
        userId,
        item.key,
      );

      let cid: string | undefined;
      let sizeBytes = 0;
      try {
        const info = await this.clientService.headObjectInfo(s3Bucket, s3Key!);
        cid = info.cid || item.cid;
        sizeBytes = info.sizeBytes;
      } catch (err) {
        console.warn(`Could not resolve S3 metadata for key ${item.key}:`, err.message);
      }

      const baseName = item.key.split('/').pop() || item.key;
      const fileName =
        item.originalName ||
        (baseName.includes('_') ? baseName.split('_').slice(1).join('_') : baseName);
      const gatewayUrl = cid ? this.pinningService.getGatewayUrl(cid) : '';

      if (cid && userObjId) {
        await this.pinnedCidModel.findOneAndUpdate(
          { bucketName: sanitizedBucket, cid, owner: userObjId as any },
          {
            $set: {
              owner: userObjId as any,
              bucketName: sanitizedBucket,
              cid,
              fileId: item.key,
              name: fileName,
              sizeBytes,
              url: gatewayUrl,
            },
          },
          { upsert: true },
        ).exec().catch(() => {});
      }

      return {
        key: item.key,
        fileName,
        cid: cid || '',
        url: gatewayUrl,
        sizeBytes,
      };
    });

    return {
      success: true,
      bucketName: sanitizedBucket,
      items: results,
    };
  }
}
