import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  HeadBucketCommand,
  GetBucketLocationCommand,
  GetBucketAclCommand,
  PutBucketAclCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  DeleteBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetBucketLoggingCommand,
} from '@aws-sdk/client-s3';
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
import { FilebaseClientService } from './filebase-client.service';
import { mapWithConcurrency } from '../../common/utils/concurrency';

const FREE_POOL_LIMIT_GB = 10;
const S3_BUCKET = 'algofile-bucket-custom';

@Injectable()
export class FilebaseBucketService {
  constructor(
    @InjectModel(Bucket.name)
    private readonly bucketModel: Model<BucketDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Collection.name)
    private readonly collectionModel: Model<CollectionDocument>,
    @InjectModel(PinnedCid.name)
    private readonly pinnedCidModel: Model<PinnedCidDocument>,
    @InjectModel(ImportedCid.name)
    private readonly importedCidModel: Model<ImportedCidDocument>,
    private readonly configService: ConfigService,
    private readonly clientService: FilebaseClientService,
  ) {}

  /**
   * Bytes used by the files matching `match` (any PinnedCid/ImportedCid/Collection filter on owner/bucketName).
   * Uploads register a PinnedCid and, for deduplicated or pinned files, an ImportedCid too, so the larger of
   * the two is taken. Collection assets are also saved as PinnedCids, so only assets missing from PinnedCid
   * (legacy records) are added on top.
   */
  private async computeUsedBytes(match: Record<string, any>): Promise<number> {
    const sumBytes = [
      { $match: match },
      { $group: { _id: null, totalBytes: { $sum: '$sizeBytes' } } },
    ];
    const [pinnedAgg, importedAgg, assetFiles] = await Promise.all([
      this.pinnedCidModel.aggregate(sumBytes).exec(),
      this.importedCidModel.aggregate(sumBytes).exec(),
      this.collectionModel.aggregate([
        { $match: match },
        { $unwind: '$assets' },
        {
          $project: {
            _id: 0,
            files: [
              { cid: '$assets.imageCid', size: '$assets.imageSize' },
              { cid: '$assets.metadataCid', size: '$assets.metadataSize' },
            ],
          },
        },
        { $unwind: '$files' },
        { $match: { 'files.cid': { $nin: [null, ''] }, 'files.size': { $gt: 0 } } },
        { $group: { _id: '$files.cid', size: { $max: '$files.size' } } },
      ]).exec(),
    ]);

    let collectionOnlyBytes = 0;
    if (assetFiles.length > 0) {
      const pinnedCids = new Set<string>(
        await this.pinnedCidModel
          .distinct('cid', { ...match, cid: { $in: assetFiles.map((f) => f._id) } })
          .exec(),
      );
      for (const f of assetFiles) {
        if (!pinnedCids.has(f._id)) collectionOnlyBytes += f.size;
      }
    }

    return (
      Math.max(pinnedAgg[0]?.totalBytes || 0, importedAgg[0]?.totalBytes || 0) +
      collectionOnlyBytes
    );
  }

  private getFreeBucketName(): string {
    return (this.configService.get<string>('BUCKET_FREE_NAME') || 'algofile-bucket-free')
      .toLowerCase()
      .trim();
  }

  /**
   * Recalculates exact used storage in bytes for a specific user across all their uploads
   */
  async recalculateUserStorageBytes(userId: string): Promise<number> {
    try {
      const totalUsedBytes = await this.computeUsedBytes({ owner: new Types.ObjectId(userId) });
      await this.userModel.updateOne(
        { _id: userId },
        { $set: { usedStorageBytes: totalUsedBytes } },
      ).exec();
      return totalUsedBytes;
    } catch (err) {
      console.warn(`Failed to recalculate user storage for ${userId}:`, err.message);
      const user = await this.userModel.findById(userId).exec();
      return user?.usedStorageBytes || 0;
    }
  }

  /**
   * Recalculates exact used storage in bytes for a specific bucket and updates MongoDB
   */
  async recalculateBucketSizeBytes(bucketName: string, userId?: string): Promise<number> {
    const sanitizedBucket = bucketName.toLowerCase().trim();
    try {
      const match: Record<string, any> = { bucketName: sanitizedBucket };
      const isFree = sanitizedBucket === this.getFreeBucketName() || sanitizedBucket === 'algofilebucketfree';
      // The free bucket is shared: report only the caller's share of it.
      if (userId && isFree) {
        match.owner = new Types.ObjectId(userId);
      }

      const totalUsedBytes = await this.computeUsedBytes(match);
      await this.bucketModel.updateOne(
        { name: sanitizedBucket, owner: { $ne: null } },
        { $set: { usedSizeBytes: totalUsedBytes } },
      ).exec();
      return totalUsedBytes;
    } catch (err) {
      console.warn(`Failed to recalculate bucket size for ${bucketName}:`, err.message);
      const bucket = await this.bucketModel.findOne({ name: sanitizedBucket }).exec();
      return bucket?.usedSizeBytes || 0;
    }
  }

  /**
   * Recalculates exact used storage in bytes for the shared global free bucket (10 GB pool)
   */
  async recalculateFreeBucketPoolStorage(): Promise<number> {
    try {
      const freeName = this.getFreeBucketName();
      // Ownerless records are lookup caches written by resolveCidFromProvider, not anyone's upload;
      // counting them let a public CID lookup fill the free pool for everyone.
      const totalPoolBytes = await this.computeUsedBytes({
        bucketName: freeName,
        owner: { $ne: null },
      });
      await this.bucketModel.updateOne(
        { name: freeName },
        { $set: { usedSizeBytes: totalPoolBytes, maxSizeGb: FREE_POOL_LIMIT_GB } },
      ).exec();
      return totalPoolBytes;
    } catch (err) {
      console.warn(`Failed to recalculate free pool storage:`, err.message);
      return 0;
    }
  }

  /**
   * Lists all platform-managed buckets for the authenticated user (Free + Owned Buckets)
   */
  async listBuckets(userId: string) {
    try {
      const user = await this.userModel.findById(userId).exec();
      if (!user) {
        throw new BadRequestException('User profile not found.');
      }

      // Check if user's plan has expired globally
      if (
        user.planExpiresAt &&
        new Date() > user.planExpiresAt &&
        user.planType !== 'free'
      ) {
        user.planType = 'free';
        user.planExpiresAt = null;
        await user.save();
      }

      // 1. Fetch all buckets owned by the user
      const userObjId = Types.ObjectId.isValid(userId)
        ? new Types.ObjectId(userId)
        : null;
      const ownerFilter = userObjId
        ? { $or: [{ owner: userObjId }, { owner: userId }] }
        : { owner: userId };

      const userBuckets = await this.bucketModel
        .find(ownerFilter as any)
        .exec();

      // 2. Construct result list (only user-owned paid buckets)
      const result: Array<{
        id?: string;
        name: string;
        maxSizeGb: number;
        usedSizeBytes: number;
        globalPoolUsedBytes?: number;
        globalPoolLimitGb?: number;
        createdAt: any;
        isFree: boolean;
        expiresAt: Date | null;
      }> = [];

      // Add custom user-owned buckets with recalculated storage
      const usedSizes = await Promise.all(
        userBuckets.map((b) => this.recalculateBucketSizeBytes(b.name, userId)),
      );
      userBuckets.forEach((b, i) => {
        result.push({
          id: b._id.toString(),
          name: b.name,
          maxSizeGb: b.maxSizeGb,
          usedSizeBytes: usedSizes[i],
          createdAt: (b as any).createdAt,
          isFree: false,
          expiresAt: b.expiresAt ?? null,
        });
      });

      return result;
    } catch (error) {
      throw new BadRequestException(`Failed to list buckets: ${error.message}`);
    }
  }

  /**
   * Asserts caller is an administrator
   */
  private async assertAdmin(userId: string): Promise<UserDocument> {
    const user = await this.userModel.findById(userId).exec();
    if (!user || user.role !== 'admin') {
      throw new ForbiddenException(
        'Acesso negado: Apenas administradores podem gerenciar expiração de buckets.',
      );
    }
    return user;
  }

  /**
   * Admin endpoint: lists all registered buckets with full expiration, usage, and owner details
   */
  async listBucketsForAdmin(userId: string) {
    await this.assertAdmin(userId);

    const buckets = await this.bucketModel
      .find()
      .populate('owner', 'email displayName algorandAddress role')
      .sort({ createdAt: -1 })
      .exec();

    const officialBuckets = [
      'algofilerouteapi',
      'algofilerouteapi6m',
      'algofilerouteapi1y',
      'algofilerouteapi2y',
    ];

    const now = new Date();

    return buckets.map((b) => {
      const ownerObj = b.owner as any;
      const isOfficial = officialBuckets.includes(b.name.toLowerCase());
      const isFree = !b.owner && !isOfficial;

      let status: 'lifetime' | 'expired' | 'expiring-soon' | 'active' = 'lifetime';
      let daysRemaining: number | null = null;

      if (b.expiresAt) {
        const expiryTime = new Date(b.expiresAt).getTime();
        const diffMs = expiryTime - now.getTime();
        daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        if (diffMs <= 0) {
          status = 'expired';
        } else if (daysRemaining <= 7) {
          status = 'expiring-soon';
        } else {
          status = 'active';
        }
      }

      return {
        id: b._id.toString(),
        name: b.name,
        maxSizeGb: b.maxSizeGb,
        usedSizeBytes: b.usedSizeBytes || 0,
        expiresAt: b.expiresAt ?? null,
        createdAt: (b as any).createdAt,
        updatedAt: (b as any).updatedAt,
        status,
        daysRemaining,
        isOfficial,
        isFree,
        owner: ownerObj
          ? {
              id: ownerObj._id?.toString(),
              email: ownerObj.email,
              displayName: ownerObj.displayName,
              algorandAddress: ownerObj.algorandAddress,
              role: ownerObj.role,
            }
          : null,
      };
    });
  }

  /**
   * Admin endpoint: updates or extends bucket expiration
   */
  async updateBucketExpirationByAdmin(
    userId: string,
    bucketId: string,
    expiresAt: Date | null,
  ) {
    await this.assertAdmin(userId);

    const bucket = await this.bucketModel.findById(bucketId).exec();
    if (!bucket) {
      throw new BadRequestException('Bucket não encontrado.');
    }

    bucket.expiresAt = expiresAt;
    await bucket.save();

    return {
      success: true,
      id: bucket._id.toString(),
      name: bucket.name,
      expiresAt: bucket.expiresAt,
    };
  }

  /**
   * Finds all buckets owned by a user with the specified Pera wallet address
   */
  async findBucketsByWallet(walletAddress: string) {
    try {
      if (!walletAddress) {
        const buckets = await this.bucketModel
          .find()
          .sort({ createdAt: -1 })
          .limit(50)
          .exec();
        return buckets.map((b) => ({
          id: b._id.toString(),
          name: b.name,
          maxSizeGb: b.maxSizeGb,
          usedSizeBytes: b.usedSizeBytes,
          createdAt: (b as any).createdAt,
          isFree: false,
          expiresAt: b.expiresAt ?? null,
        }));
      }

      const cleanWallet = walletAddress.trim();
      if (!/^[A-Z2-7]{58}$/i.test(cleanWallet)) {
        throw new BadRequestException(
          'Invalid Algorand wallet address format.',
        );
      }

      const escapedWallet = cleanWallet.replace(
        /[-[\]{}()*+?.,\\^$|#\s]/g,
        '\\$&',
      );
      const user = await this.userModel
        .findOne({
          peraWalletAddress: { $regex: new RegExp(`^${escapedWallet}$`, 'i') },
        })
        .exec();

      if (!user) {
        return [];
      }

      const userBuckets = await this.bucketModel
        .find({ owner: user._id as any })
        .exec();

      return userBuckets.map((b) => ({
        id: b._id.toString(),
        name: b.name,
        maxSizeGb: b.maxSizeGb,
        usedSizeBytes: b.usedSizeBytes,
        createdAt: (b as any).createdAt,
        isFree: false,
        expiresAt: b.expiresAt ?? null,
      }));
    } catch (error) {
      throw new BadRequestException(
        `Failed to search buckets by wallet: ${error.message}`,
      );
    }
  }

  /**
   * Renames a user-owned bucket and updates its database records and collection mappings
   */
  async renameBucket(userId: string, oldName: string, newName: string) {
    const sanitizedOld = oldName.toLowerCase().trim();
    const sanitizedNew = newName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .trim();

    if (!sanitizedNew) {
      throw new BadRequestException(
        'New bucket name must be a valid alphanumeric string with hyphens.',
      );
    }

    const bucket = await this.bucketModel
      .findOne({ name: sanitizedOld, owner: userId as any })
      .exec();
    if (!bucket) {
      throw new BadRequestException(
        'Bucket not found or you are not the owner.',
      );
    }

    // Check if new name is already taken in the database
    const existing = await this.bucketModel
      .findOne({ name: sanitizedNew })
      .exec();
    if (existing) {
      throw new BadRequestException(
        `Bucket name '${sanitizedNew}' is already taken.`,
      );
    }

    const userHash = this.clientService.getUserHash(userId);
    const s3Client = this.clientService.getS3Client();

    const oldPrefix = `${sanitizedOld}-${userHash}/`;
    const newPrefix = `${sanitizedNew}-${userHash}/`;

    try {
      let continuationToken: string | undefined;
      do {
        const listRes = await s3Client.send(
          new ListObjectsV2Command({
            Bucket: S3_BUCKET,
            Prefix: oldPrefix,
            ContinuationToken: continuationToken,
          }),
        );
        const keys = (listRes.Contents || []).map((obj) => obj.Key!).filter(Boolean);

        // Copy the whole page first, then delete it in one request.
        await mapWithConcurrency(keys, 16, (oldKey) =>
          s3Client.send(
            new CopyObjectCommand({
              Bucket: S3_BUCKET,
              CopySource: `${S3_BUCKET}/${encodeURIComponent(oldKey)}`,
              Key: oldKey.replace(oldPrefix, newPrefix),
            }),
          ),
        );
        if (keys.length > 0) {
          await s3Client.send(
            new DeleteObjectsCommand({
              Bucket: S3_BUCKET,
              Delete: { Objects: keys.map((Key) => ({ Key })) },
            }),
          );
        }

        continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (err) {
      // Renaming in MongoDB anyway would point the bucket at a prefix that no longer holds its files.
      throw new BadRequestException(
        `Could not move files to the new bucket name: ${err.message}. The bucket was not renamed; try again.`,
      );
    }

    // 2. Update the name in the database
    bucket.name = sanitizedNew;
    await bucket.save();

    // 3. Update all collections and pinned CIDs with the new bucketName
    await this.collectionModel
      .updateMany(
        { bucketName: sanitizedOld, owner: userId as any },
        { $set: { bucketName: sanitizedNew } },
      )
      .exec();

    await this.pinnedCidModel
      .updateMany(
        { bucketName: sanitizedOld, owner: userId as any },
        { $set: { bucketName: sanitizedNew } },
      )
      .exec();

    // ImportedCid also stores the S3 key, which carries the bucket name in its prefix.
    await this.importedCidModel
      .updateMany(
        { bucketName: sanitizedOld, owner: userId as any },
        [
          {
            $set: {
              bucketName: sanitizedNew,
              s3Key: {
                $replaceOne: { input: { $ifNull: ['$s3Key', ''] }, find: oldPrefix, replacement: newPrefix },
              },
            },
          },
        ],
        { updatePipeline: true },
      )
      .exec();

    return {
      message: `Bucket successfully renamed from '${sanitizedOld}' to '${sanitizedNew}'.`,
      bucket: {
        name: bucket.name,
        maxSizeGb: bucket.maxSizeGb,
        usedSizeBytes: bucket.usedSizeBytes,
        expiresAt: bucket.expiresAt,
      },
    };
  }

  /**
   * Creates a new bucket on Filebase and logs its size limit in MongoDB
   */
  async createBucket(
    userId: string,
    bucketName: string,
    maxSizeGb: number = 5,
  ) {
    const sanitizedName = bucketName.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const accessKeyId = this.configService.get<string>('FILEBASE_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>('FILEBASE_SECRET_ACCESS_KEY');
    const ipfsRpcToken = (accessKeyId && secretAccessKey)
      ? Buffer.from(`${accessKeyId}:${secretAccessKey}:${sanitizedName}`).toString('base64')
      : this.configService.get<string>('FILEBASE_IPFS_RPC_TOKEN');

    if (!ipfsRpcToken) {
      throw new BadRequestException(
        'Filebase credentials are not configured on the backend.',
      );
    }

    const count = await this.bucketModel
      .countDocuments({ owner: userId as any })
      .exec();
    if (count >= 5) {
      throw new BadRequestException(
        'You have reached the limit of 5 storage buckets. Please delete an existing bucket or renew one.',
      );
    }

    // Check if name is already taken in the database
    const existing = await this.bucketModel
      .findOne({ name: sanitizedName })
      .exec();
    if (existing) {
      throw new BadRequestException(
        `Bucket '${sanitizedName}' already exists on the platform.`,
      );
    }

    try {
      // Save bucket record in MongoDB with custom limit
      await this.bucketModel.create({
        name: sanitizedName,
        owner: userId as any,
        maxSizeGb: maxSizeGb || 5,
        usedSizeBytes: 0,
        ipfsRpcToken,
      });

      return {
        message: `Bucket '${sanitizedName}' successfully deployed with a ${maxSizeGb} GB limit.`,
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to create bucket on platform: ${error.message}`,
      );
    }
  }

  /**
   * Deletes a bucket on Filebase S3 and removes it from MongoDB, along with any associated collections
   */
  async deleteBucket(userId: string, bucketName: string) {
    const sanitizedName = bucketName.toLowerCase().replace(/[^a-z0-9-]/g, '');

    // 1. Verify that the bucket exists and belongs to the user
    const bucket = await this.bucketModel
      .findOne({ name: sanitizedName })
      .exec();
    if (!bucket) {
      throw new BadRequestException(`Bucket '${sanitizedName}' not found.`);
    }

    if (bucket.owner?.toString() !== userId) {
      throw new BadRequestException(
        `Access denied: You do not own the bucket '${sanitizedName}'.`,
      );
    }

    const s3Client = this.clientService.getS3Client();

    try {
      const s3Bucket = 'algofile-bucket-custom';
      const userHash = this.clientService.getUserHash(userId);
      const prefix = `${sanitizedName}-${userHash}/`;

      // 2. Empty the bucket prefix (list and delete all S3 objects/files)
      let isTruncated = true;
      let continuationToken: string | undefined;

      while (isTruncated) {
        const listCommand = new ListObjectsV2Command({
          Bucket: s3Bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });

        const listRes = await s3Client.send(listCommand);

        if (listRes.Contents && listRes.Contents.length > 0) {
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

      // 3. Remove the bucket from MongoDB
      await this.bucketModel.deleteOne({ name: sanitizedName }).exec();

      // 4. Delete all associated collections and pinned CIDs from MongoDB
      await this.collectionModel
        .deleteMany({ bucketName: sanitizedName, owner: userId as any })
        .exec();

      await this.pinnedCidModel
        .deleteMany({ bucketName: sanitizedName, owner: userId as any })
        .exec();

      // Deduplicated and pinned files live in ImportedCid too; left behind they kept counting toward the quota.
      await this.importedCidModel
        .deleteMany({ bucketName: sanitizedName, owner: userId as any })
        .exec();

      await this.recalculateUserStorageBytes(userId);

      return {
        success: true,
        message: `Bucket '${sanitizedName}' and all associated files/collections were successfully deleted.`,
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to delete bucket from Filebase: ${error.message}`,
      );
    }
  }

  /**
   * Deletes all objects in a bucket (including all versions and delete markers)
   */
  async emptyBucket(userId: string, bucketName: string) {
    const sanitizedName = bucketName.toLowerCase().replace(/[^a-z0-9-]/g, '');

    // Verify that the bucket exists and belongs to the user
    const bucket = await this.bucketModel
      .findOne({ name: sanitizedName })
      .exec();
    if (!bucket) {
      throw new BadRequestException(`Bucket '${sanitizedName}' not found.`);
    }

    if (bucket.owner?.toString() !== userId) {
      throw new BadRequestException(
        `Access denied: You do not own the bucket '${sanitizedName}'.`,
      );
    }

    const s3Client = this.clientService.getS3Client();

    try {
      const s3Bucket = 'algofile-bucket-custom';
      const userHash = this.clientService.getUserHash(userId);
      const prefix = `${sanitizedName}-${userHash}/`;

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

      // Reset the bucket's size counter in MongoDB
      bucket.usedSizeBytes = 0;
      await bucket.save();

      // Delete all associated collections and pinned CIDs from MongoDB since files are gone
      await this.collectionModel
        .deleteMany({ bucketName: sanitizedName, owner: userId as any })
        .exec();

      await this.pinnedCidModel
        .deleteMany({ bucketName: sanitizedName, owner: userId as any })
        .exec();

      // Deduplicated and pinned files live in ImportedCid too; left behind they kept counting toward the quota.
      await this.importedCidModel
        .deleteMany({ bucketName: sanitizedName, owner: userId as any })
        .exec();

      await this.recalculateUserStorageBytes(userId);

      return {
        success: true,
        message: `Successfully deleted ${totalDeleted} file versions/markers from bucket '${sanitizedName}'.`,
      };
    } catch (error) {
      throw new BadRequestException(`Failed to empty bucket: ${error.message}`);
    }
  }

  /**
   * Helper to manually increment a bucket's size counter (useful for external scripts or metadata buffers)
   */
  async incrementBucketSize(bucketName: string, sizeBytes: number) {
    const bucket = await this.bucketModel
      .findOne({ name: bucketName.toLowerCase() })
      .exec();
    if (bucket) {
      bucket.usedSizeBytes += sizeBytes;
      await bucket.save();
    }
  }

  /**
   * Scans Filebase S3 directly for a user's bucket, recalculates true storage size,
   * cleans up any orphaned MongoDB records (e.g. if files/folders were deleted externally in Filebase),
   * updates the bucket document and user quota, and returns fresh sync stats.
   */
  async syncBucketStorage(userId: string, bucketName: string) {
    const sanitizedName = bucketName.toLowerCase().replace(/[^a-z0-9-]/g, '');

    // 1. Verify bucket existence and ownership
    const bucket = await this.bucketModel.findOne({ name: sanitizedName }).exec();
    if (!bucket) {
      throw new BadRequestException(`Bucket '${sanitizedName}' not found.`);
    }

    if (bucket.owner && bucket.owner.toString() !== userId) {
      throw new BadRequestException(
        `Access denied: You do not own the bucket '${sanitizedName}'.`,
      );
    }

    const previousSizeBytes = bucket.usedSizeBytes || 0;
    const ownerId = bucket.owner ? bucket.owner.toString() : userId;
    const userHash = this.clientService.getUserHash(ownerId);
    const prefix = `${sanitizedName}-${userHash}/`;
    const s3Bucket = 'algofile-bucket-custom';
    const s3Client = this.clientService.getS3Client();

    try {
      // 2. Fetch all S3 objects under this bucket's prefix
      let isTruncated = true;
      let continuationToken: string | undefined;
      const s3Keys = new Set<string>();
      let totalS3Bytes = 0;
      let s3FileCount = 0;

      while (isTruncated) {
        const listCommand = new ListObjectsV2Command({
          Bucket: s3Bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });

        const listRes = await s3Client.send(listCommand);

        if (listRes.Contents && listRes.Contents.length > 0) {
          for (const obj of listRes.Contents) {
            if (!obj.Key) continue;
            // Ignore folder markers (ending with '/')
            if (obj.Key.endsWith('/')) continue;

            s3Keys.add(obj.Key);
            s3FileCount++;
            totalS3Bytes += obj.Size || 0;
          }
        }

        isTruncated = listRes.IsTruncated || false;
        continuationToken = listRes.NextContinuationToken;
      }

      // 3. Identify and clean up orphaned MongoDB records in importedcids
      const userObjId = Types.ObjectId.isValid(ownerId) ? new Types.ObjectId(ownerId) : null;
      const matchFilter: any = { bucketName: sanitizedName };
      if (userObjId) {
        matchFilter.owner = userObjId;
      }

      const importedDocs = await this.importedCidModel
        .find(matchFilter)
        .select('_id s3Key fileId cid folder')
        .exec();

      const orphanedImportedIds: any[] = [];
      for (const doc of importedDocs) {
        const directKey = doc.s3Key;
        const byFileId = doc.fileId ? `${prefix}${doc.fileId}` : null;
        const byCid = doc.cid ? `${prefix}${doc.cid}` : null;
        const byFolderCid = doc.folder && doc.cid ? `${prefix}${doc.folder}/${doc.cid}` : null;

        const existsInS3 =
          (directKey && s3Keys.has(directKey)) ||
          (byFileId && s3Keys.has(byFileId)) ||
          (byFolderCid && s3Keys.has(byFolderCid)) ||
          (byCid && s3Keys.has(byCid));

        if (!existsInS3) {
          orphanedImportedIds.push(doc._id);
        }
      }

      let cleanedImportedCount = 0;
      if (orphanedImportedIds.length > 0) {
        const delRes = await this.importedCidModel
          .deleteMany({ _id: { $in: orphanedImportedIds } })
          .exec();
        cleanedImportedCount = delRes.deletedCount || orphanedImportedIds.length;
      }

      // 4. Identify and clean up orphaned MongoDB records in pinnedcids
      const pinnedDocs = await this.pinnedCidModel
        .find(matchFilter)
        .select('_id fileId cid')
        .exec();

      const orphanedPinnedIds: any[] = [];
      for (const doc of pinnedDocs) {
        const byFileId = doc.fileId ? `${prefix}${doc.fileId}` : null;
        const byCid = doc.cid ? `${prefix}${doc.cid}` : null;

        const existsInS3 =
          (byFileId && s3Keys.has(byFileId)) || (byCid && s3Keys.has(byCid));

        if (!existsInS3) {
          orphanedPinnedIds.push(doc._id);
        }
      }

      let cleanedPinnedCount = 0;
      if (orphanedPinnedIds.length > 0) {
        const delRes = await this.pinnedCidModel
          .deleteMany({ _id: { $in: orphanedPinnedIds } })
          .exec();
        cleanedPinnedCount = delRes.deletedCount || orphanedPinnedIds.length;
      }

      // 5. Update the bucket's usedSizeBytes in MongoDB
      bucket.usedSizeBytes = totalS3Bytes;
      await bucket.save();

      // 6. Recalculate user storage quota
      await this.recalculateUserStorageBytes(ownerId);

      const freedSizeBytes = Math.max(0, previousSizeBytes - totalS3Bytes);

      return {
        success: true,
        bucketName: sanitizedName,
        usedSizeBytes: totalS3Bytes,
        maxSizeGb: bucket.maxSizeGb,
        s3FileCount,
        cleanedImportedCount,
        cleanedPinnedCount,
        previousSizeBytes,
        freedSizeBytes,
        message: `Bucket '${sanitizedName}' successfully synchronized with Filebase S3. Found ${s3FileCount} active files (${(totalS3Bytes / 1024 / 1024).toFixed(2)} MB), removed ${cleanedImportedCount} orphaned records.`,
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to sync bucket with Filebase S3: ${error.message}`,
      );
    }
  }

  /**
   * Configures S3 CORS configuration on a bucket to allow direct browser uploads (PUT and OPTIONS).
   */
  async configureBucketCors(bucketName: string): Promise<void> {
    try {
      const corsRules = {
        CORSRules: [
          {
            AllowedHeaders: ['*'],
            AllowedMethods: ['PUT', 'OPTIONS', 'GET', 'HEAD', 'POST'],
            AllowedOrigins: ['*'],
            ExposeHeaders: ['x-amz-meta-cid', 'ETag', 'x-amz-ipfs-cid', 'cid'],
            MaxAgeSeconds: 3000,
          },
        ],
      };

      const command = new PutBucketCorsCommand({
        Bucket: bucketName,
        CORSConfiguration: corsRules,
      });

      await this.clientService.getS3Client().send(command);
    } catch (error) {
      // Ignore NoSuchBucket errors because some seeded buckets might not exist in this Filebase S3 account
      if (
        error.name === 'NoSuchBucket' ||
        error.message?.includes('does not exist')
      ) {
        return;
      }
      console.warn(
        `Failed to configure S3 CORS for bucket '${bucketName}': ${error.message}`,
      );
    }
  }

  async seedBuckets() {
    const bucketsToSeed: Array<{
      name: string;
      maxSizeGb: number;
      ipfsRpcToken: string;
    }> = [];

    // Seed free bucket
    const freeName =
      this.configService.get<string>('BUCKET_FREE_NAME') ||
      'algofile-bucket-free';
    const freeRpcToken =
      this.configService.get<string>('BUCKET_FREE_RPC_TOKEN') ||
      this.configService.get<string>('FILEBASE_IPFS_RPC_TOKEN') ||
      'mock-token';
    bucketsToSeed.push({
      name: freeName.toLowerCase().trim(),
      maxSizeGb: FREE_POOL_LIMIT_GB, // shared pool, enforced in FilebaseUploadService
      ipfsRpcToken: freeRpcToken.trim(),
    });

    for (let i = 1; i <= 3; i++) {
      const name = this.configService.get<string>(`BUCKET_${i}_NAME`);
      const limitGbStr = this.configService.get<string>(`BUCKET_${i}_LIMIT_GB`);
      const ipfsRpcToken = this.configService.get<string>(
        `BUCKET_${i}_RPC_TOKEN`,
      );

      if (name && ipfsRpcToken) {
        bucketsToSeed.push({
          name: name.toLowerCase().trim(),
          maxSizeGb: parseInt(limitGbStr || '5', 10) || 5,
          ipfsRpcToken: ipfsRpcToken.trim(),
        });
      }
    }

    // Seed official route buckets
    const officialNames = [
      'algofilerouteapi',
      'algofilerouteapi6m',
      'algofilerouteapi1y',
      'algofilerouteapi2y',
    ];
    for (const name of officialNames) {
      bucketsToSeed.push({
        name,
        maxSizeGb: 250,
        ipfsRpcToken: freeRpcToken.trim(),
      });
    }

    if (bucketsToSeed.length === 0) {
      console.log('No predefined buckets found in env config to seed.');
      return;
    }

    console.log(
      `Seeding ${bucketsToSeed.length} predefined buckets into MongoDB...`,
    );
    for (const b of bucketsToSeed) {
      const existing = await this.bucketModel.findOne({ name: b.name }).exec();
      if (existing) {
        existing.maxSizeGb = b.maxSizeGb;
        existing.ipfsRpcToken = b.ipfsRpcToken;
        await existing.save();
      } else {
        await this.bucketModel.create({
          name: b.name,
          maxSizeGb: b.maxSizeGb,
          ipfsRpcToken: b.ipfsRpcToken,
          usedSizeBytes: 0,
        });
      }
    }
  }

  async headBucket(userId: string, bucketName: string) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket } = await this.clientService.getS3Params(bucketName, userId);
    const command = new HeadBucketCommand({
      Bucket: s3Bucket,
    });
    return this.clientService.getS3Client().send(command);
  }

  async getBucketLocation(userId: string, bucketName: string) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket } = await this.clientService.getS3Params(bucketName, userId);
    const command = new GetBucketLocationCommand({
      Bucket: s3Bucket,
    });
    return this.clientService.getS3Client().send(command);
  }

  async getBucketAcl(userId: string, bucketName: string) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket } = await this.clientService.getS3Params(bucketName, userId);
    const command = new GetBucketAclCommand({
      Bucket: s3Bucket,
    });
    return this.clientService.getS3Client().send(command);
  }

  async putBucketAcl(userId: string, bucketName: string, acl: string) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket } = await this.clientService.getS3Params(bucketName, userId);
    const command = new PutBucketAclCommand({
      Bucket: s3Bucket,
      ACL: acl as any,
    });
    return this.clientService.getS3Client().send(command);
  }

  async getBucketCors(userId: string, bucketName: string) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket } = await this.clientService.getS3Params(bucketName, userId);
    const command = new GetBucketCorsCommand({
      Bucket: s3Bucket,
    });
    return this.clientService.getS3Client().send(command);
  }

  async putBucketCors(userId: string, bucketName: string, corsRules: any[]) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket } = await this.clientService.getS3Params(bucketName, userId);
    const command = new PutBucketCorsCommand({
      Bucket: s3Bucket,
      CORSConfiguration: {
        CORSRules: corsRules,
      },
    });
    return this.clientService.getS3Client().send(command);
  }

  async deleteBucketCors(userId: string, bucketName: string) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket } = await this.clientService.getS3Params(bucketName, userId);
    const command = new DeleteBucketCorsCommand({
      Bucket: s3Bucket,
    });
    return this.clientService.getS3Client().send(command);
  }

  async getBucketLifecycle(userId: string, bucketName: string) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket } = await this.clientService.getS3Params(bucketName, userId);
    const command = new GetBucketLifecycleConfigurationCommand({
      Bucket: s3Bucket,
    });
    return this.clientService.getS3Client().send(command);
  }

  async getBucketLifecycleConfiguration(userId: string, bucketName: string) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket } = await this.clientService.getS3Params(bucketName, userId);
    const command = new GetBucketLifecycleConfigurationCommand({
      Bucket: s3Bucket,
    });
    return this.clientService.getS3Client().send(command);
  }

  async getBucketVersioning(userId: string, bucketName: string) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket } = await this.clientService.getS3Params(bucketName, userId);
    const command = new GetBucketVersioningCommand({
      Bucket: s3Bucket,
    });
    return this.clientService.getS3Client().send(command);
  }

  async getBucketLogging(userId: string, bucketName: string) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket } = await this.clientService.getS3Params(bucketName, userId);
    const command = new GetBucketLoggingCommand({
      Bucket: s3Bucket,
    });
    return this.clientService.getS3Client().send(command);
  }
}
