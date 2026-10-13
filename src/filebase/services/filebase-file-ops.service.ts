import {
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import {
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Bucket, BucketDocument } from '../schemas/bucket.schema';
import { PinnedCid, PinnedCidDocument } from '../schemas/pinned-cid.schema';
import { ImportedCid, ImportedCidDocument } from '../schemas/imported-cid.schema';
import { FilebaseClientService } from './filebase-client.service';
import { FilebaseBucketService } from './filebase-bucket.service';

@Injectable()
export class FilebaseFileOpsService {
  constructor(
    @InjectModel(Bucket.name)
    private readonly bucketModel: Model<BucketDocument>,
    @InjectModel(PinnedCid.name)
    private readonly pinnedCidModel: Model<PinnedCidDocument>,
    @InjectModel(ImportedCid.name)
    private readonly importedCidModel: Model<ImportedCidDocument>,
    private readonly clientService: FilebaseClientService,
    private readonly bucketService: FilebaseBucketService,
  ) {}

  /**
   * Performs a fast server-side S3 copy from one key to another (even across user prefixes).
   */
  async copyFile(
    sourceUserId: string,
    destUserId: string,
    bucketName: string,
    sourceKey: string,
    destKey: string,
  ): Promise<void> {
    try {
      const { s3Bucket: srcBucket, s3Key: srcKey } =
        await this.clientService.getS3Params(bucketName, sourceUserId, sourceKey);
      const { s3Bucket: dstBucket, s3Key: dstKey } =
        await this.clientService.getS3Params(bucketName, destUserId, destKey);

      const copyCommand = new CopyObjectCommand({
        Bucket: dstBucket,
        CopySource: `${srcBucket}/${srcKey}`,
        Key: dstKey,
      });

      await this.clientService.getS3Client().send(copyCommand);
    } catch (error) {
      throw new BadRequestException(
        `Failed to copy file in Filebase: ${error.message}`,
      );
    }
  }

  /**
   * Deletes a file from Filebase S3, fetches its size via HeadObject, and returns the deleted size in bytes
   */
  async deleteFile(
    userId: string,
    bucketName: string,
    key: string,
  ): Promise<number> {
    try {
      const { s3Bucket, s3Key } = await this.clientService.getS3Params(
        bucketName,
        userId,
        key,
      );
      let sizeBytes = 0;
      try {
        const headCommand = new HeadObjectCommand({
          Bucket: s3Bucket,
          Key: s3Key,
        });
        const headResponse = await this.clientService.getS3Client().send(headCommand);
        sizeBytes = headResponse.ContentLength || 0;
      } catch (err) {
        console.warn(
          `Could not get size for file ${key} in bucket ${bucketName} (S3: ${s3Bucket}/${s3Key}): ${err.message}`,
        );
      }

      const deleteCommand = new DeleteObjectCommand({
        Bucket: s3Bucket,
        Key: s3Key,
      });
      await this.clientService.getS3Client().send(deleteCommand);
      return sizeBytes;
    } catch (error) {
      console.error(
        `Failed to delete file ${key} from Filebase bucket ${bucketName}: ${error.message}`,
      );
      return 0;
    }
  }

  /**
   * Creates a folder marker object in S3 for a bucket
   */
  async createFolder(
    userId: string,
    bucketName: string,
    folderName: string,
    parentFolder?: string,
  ) {
    const sanitizedName = bucketName.toLowerCase().trim();
    const bucket = await this.bucketModel.findOne({ name: sanitizedName }).exec();
    if (!bucket) {
      throw new BadRequestException(`Bucket '${bucketName}' is not registered.`);
    }
    const isFreeBucket = !bucket.owner;
    if (!isFreeBucket && bucket.owner?.toString() !== userId) {
      throw new BadRequestException(`Access denied: You do not own the bucket '${bucketName}'.`);
    }

    const trimmedName = (folderName || '').trim();
    if (!trimmedName) {
      throw new BadRequestException('Folder name cannot be empty.');
    }
    if (trimmedName.includes('/') || trimmedName.includes('\\') || trimmedName.includes('..')) {
      throw new BadRequestException('Folder name cannot contain slashes or ".."');
    }
    const sanitizedFolder = trimmedName.replace(/[^a-zA-Z0-9_\- ]/g, '').trim();
    if (!sanitizedFolder) {
      throw new BadRequestException('Folder name must contain valid alphanumeric characters.');
    }

    const cleanParent = parentFolder ? parentFolder.replace(/^\/+|\/+$/g, '').trim() : '';
    const folderPath = cleanParent ? `${cleanParent}/${sanitizedFolder}` : sanitizedFolder;
    const folderKey = `${folderPath}/`;

    const { s3Bucket, s3Key } = await this.clientService.getS3Params(
      sanitizedName,
      userId,
      folderKey,
    );

    const putCommand = new PutObjectCommand({
      Bucket: s3Bucket,
      Key: s3Key,
      Body: Buffer.alloc(0),
      ContentType: 'application/x-directory',
    });

    await this.clientService.getS3Client().send(putCommand);

    return {
      success: true,
      folder: folderPath,
      name: sanitizedFolder,
    };
  }

  /**
   * Deletes a folder and all its contents from S3 and cleans up MongoDB records
   */
  async deleteFolder(
    userId: string,
    bucketName: string,
    folderPath: string,
  ) {
    const sanitizedName = bucketName.toLowerCase().trim();
    const bucket = await this.bucketModel.findOne({ name: sanitizedName }).exec();
    if (!bucket) {
      throw new BadRequestException(`Bucket '${bucketName}' is not registered.`);
    }
    const isFreeBucket = !bucket.owner;
    if (!isFreeBucket && bucket.owner?.toString() !== userId) {
      throw new BadRequestException(`Access denied: You do not own the bucket '${bucketName}'.`);
    }

    const cleanFolder = (folderPath || '').replace(/^\/+|\/+$/g, '').trim();
    if (!cleanFolder) {
      throw new BadRequestException('Cannot delete root directory as a folder.');
    }

    const ownerId =
      bucket && bucket.owner
        ? (bucket.owner as any)?._id
          ? (bucket.owner as any)._id.toString()
          : bucket.owner.toString()
        : userId;
    const userHash = this.clientService.getUserHash(ownerId);
    const prefix = `${sanitizedName}-${userHash}/${cleanFolder}/`;
    const s3Bucket = 'algofile-bucket-custom';
    const s3Client = this.clientService.getS3Client();

    let isTruncated = true;
    let continuationToken: string | undefined;
    let totalDeleted = 0;

    while (isTruncated) {
      const listCommand = new ListObjectsV2Command({
        Bucket: s3Bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });
      const listRes = await s3Client.send(listCommand);

      if (listRes.Contents && listRes.Contents.length > 0) {
        totalDeleted += listRes.Contents.length;
        const deleteObjectsCommand = new DeleteObjectsCommand({
          Bucket: s3Bucket,
          Delete: {
            Objects: listRes.Contents.map((obj) => ({
              Key: obj.Key,
            })),
          },
        });
        await s3Client.send(deleteObjectsCommand);
      }

      isTruncated = listRes.IsTruncated || false;
      continuationToken = listRes.NextContinuationToken;
    }

    // Also delete the folder marker itself if exists
    try {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: s3Bucket,
          Key: `${sanitizedName}-${userHash}/${cleanFolder}/`,
        }),
      );
    } catch {
      // Ignore if not present
    }

    // Remove MongoDB PinnedCid and ImportedCid records that belong to this folder
    const userObjId = new Types.ObjectId(ownerId);
    const folderRegex = new RegExp(`^${cleanFolder}/`);
    await this.pinnedCidModel.deleteMany({
      bucketName: sanitizedName,
      owner: userObjId as any,
      $or: [
        { fileId: { $regex: folderRegex } },
        { fileId: cleanFolder },
        { fileId: `${cleanFolder}/` },
      ],
    }).exec();

    await this.importedCidModel.deleteMany({
      bucketName: sanitizedName,
      owner: userObjId as any,
      $or: [
        { folder: cleanFolder },
        { fileId: { $regex: folderRegex } },
        { fileId: cleanFolder },
      ],
    }).exec();

    await this.bucketService.recalculateUserStorageBytes(userId);
    await this.bucketService.recalculateBucketSizeBytes(sanitizedName, userId);

    return {
      success: true,
      deletedCount: totalDeleted,
      message: `Folder '${cleanFolder}' and all contents deleted successfully.`,
    };
  }

  /**
   * Deletes a single file by relative key and cleans up MongoDB records
   */
  async deleteSingleFile(
    userId: string,
    bucketName: string,
    key: string,
  ) {
    const sanitizedName = bucketName.toLowerCase().trim();
    const bucket = await this.bucketModel.findOne({ name: sanitizedName }).exec();
    if (!bucket) {
      throw new BadRequestException(`Bucket '${bucketName}' is not registered.`);
    }
    const isFreeBucket = !bucket.owner;
    if (!isFreeBucket && bucket.owner?.toString() !== userId) {
      throw new BadRequestException(`Access denied: You do not own the bucket '${bucketName}'.`);
    }

    if (!key) {
      throw new BadRequestException('File key is required.');
    }

    await this.deleteFile(userId, sanitizedName, key);

    const userObjId = new Types.ObjectId(userId);
    const keyFilename = key.split('/').pop() || key;
    await this.pinnedCidModel.deleteMany({
      bucketName: sanitizedName,
      owner: userObjId as any,
      $or: [
        { fileId: key },
        { name: key },
        { cid: keyFilename },
      ],
    }).exec();

    await this.importedCidModel.deleteMany({
      bucketName: sanitizedName,
      owner: userObjId as any,
      $or: [
        { fileId: key },
        { name: key },
        { s3Key: key },
        { cid: keyFilename },
      ],
    }).exec();

    await this.bucketService.recalculateUserStorageBytes(userId);
    await this.bucketService.recalculateBucketSizeBytes(sanitizedName, userId);

    return {
      success: true,
      message: `File '${key}' deleted successfully.`,
    };
  }

  /**
   * Moves a file within a bucket from one location/folder to another using server-side S3 copy and delete
   */
  async moveFile(
    userId: string,
    bucketName: string,
    sourceKey: string,
    destFolder: string,
  ): Promise<{ success: boolean; oldKey: string; newKey: string }> {
    const sanitizedName = bucketName.toLowerCase().trim();
    const bucket = await this.bucketModel.findOne({ name: sanitizedName }).exec();
    if (!bucket) {
      throw new BadRequestException(`Bucket '${bucketName}' is not registered.`);
    }
    const isFreeBucket = !bucket.owner;
    if (!isFreeBucket && bucket.owner?.toString() !== userId) {
      throw new BadRequestException(`Access denied: You do not own the bucket '${bucketName}'.`);
    }

    if (!sourceKey) {
      throw new BadRequestException('sourceKey is required.');
    }

    const filename = sourceKey.split('/').pop() || sourceKey;
    const cleanDestFolder = (destFolder || '').replace(/^\/+|\/+$/g, '').trim();
    const destKey = cleanDestFolder ? `${cleanDestFolder}/${filename}` : filename;

    if (destKey === sourceKey) {
      return { success: true, oldKey: sourceKey, newKey: destKey };
    }

    // 1. S3 Copy from source to dest
    await this.copyFile(userId, userId, sanitizedName, sourceKey, destKey);

    // 2. S3 Delete source object
    await this.deleteFile(userId, sanitizedName, sourceKey);

    // 3. Update MongoDB records (PinnedCid)
    const userObjId = new Types.ObjectId(userId);
    await this.pinnedCidModel.updateMany(
      {
        bucketName: sanitizedName,
        owner: userObjId as any,
        $or: [
          { fileId: sourceKey },
          { name: sourceKey },
        ],
      },
      {
        $set: {
          fileId: destKey,
        },
      },
    ).exec();

    return {
      success: true,
      oldKey: sourceKey,
      newKey: destKey,
    };
  }

  /**
   * Moves multiple files in bulk to a target folder
   */
  async moveFilesBulk(
    userId: string,
    bucketName: string,
    sourceKeys: string[],
    destFolder: string,
  ): Promise<{ success: boolean; movedCount: number; items: any[] }> {
    const results = await Promise.all(
      sourceKeys.map((key) => this.moveFile(userId, bucketName, key, destFolder)),
    );
    return {
      success: true,
      movedCount: results.length,
      items: results,
    };
  }

  /**
   * Deletes multiple files in bulk
   */
  async deleteFilesBulk(
    userId: string,
    bucketName: string,
    keys: string[],
  ): Promise<{ success: boolean; deletedCount: number }> {
    await Promise.all(keys.map((key) => this.deleteSingleFile(userId, bucketName, key)));
    return {
      success: true,
      deletedCount: keys.length,
    };
  }
}
