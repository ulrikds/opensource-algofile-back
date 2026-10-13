import {
  Injectable,
  NotFoundException,
  BadRequestException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';
import { ApiKey, ApiKeyDocument } from './schemas/api-key.schema';
import { Bucket, BucketDocument } from '../filebase/schemas/bucket.schema';
import {
  GlobalStats,
  GlobalStatsDocument,
} from './schemas/global-stats.schema';
import {
  MintTransaction,
  MintTransactionDocument,
} from '../collections/schemas/mint-transaction.schema';
import {
  ActiveWallet,
  ActiveWalletDocument,
} from './schemas/active-wallet.schema';
import { ConfigService } from '@nestjs/config';
import { ListBucketsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { FilebaseClientService } from '../filebase/services/filebase-client.service';
import * as crypto from 'crypto';

@Injectable()
export class UsersService implements OnApplicationBootstrap {
  private readonly encryptionKey: Buffer;
  private cachedPublicStats: {
    totalBuckets: number;
    totalUsedStorageGb: number;
    totalWallets: number;
    totalBoughtStorageGb: number;
    totalAssetsMinted: number;
  } | null = null;
  private lastPublicStatsFetch = 0;
  private cachedFilebaseUsedBytes: number | null = null;
  private lastFilebaseUsageFetch = 0;

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(ApiKey.name) private apiKeyModel: Model<ApiKeyDocument>,
    @InjectModel(Bucket.name) private bucketModel: Model<BucketDocument>,
    @InjectModel(GlobalStats.name)
    private globalStatsModel: Model<GlobalStatsDocument>,
    @InjectModel(MintTransaction.name)
    private mintTransactionModel: Model<MintTransactionDocument>,
    @InjectModel(ActiveWallet.name)
    private activeWalletModel: Model<ActiveWalletDocument>,
    private configService: ConfigService,
    private filebaseClient: FilebaseClientService,
  ) {
    const keyHex = this.configService.get<string>('ENCRYPTION_KEY');
    if (!keyHex || keyHex.length !== 64) {
      throw new Error(
        'ENCRYPTION_KEY must be a 64-character (32-byte) hex string',
      );
    }
    this.encryptionKey = Buffer.from(keyHex, 'hex');
  }

  async onApplicationBootstrap() {
    await this.seedOfficialKeys();
  }

  async seedOfficialKeys() {
    try {
      // 1. Ensure we have a system admin user to own the keys
      let adminUser = await this.userModel.findOne({ role: 'admin' }).exec();
      if (!adminUser) {
        adminUser = await this.userModel.findOne().exec();
      }
      if (!adminUser) {
        adminUser = await this.userModel.create({
          googleId: 'system-admin-id',
          email: 'admin@algofile.com',
          displayName: 'System Admin',
          role: 'admin',
        });
      }

      // 2. Seed official keys: algofilerouteapi, algofilerouteapi6m, algofilerouteapi1y, algofilerouteapi2y
      const officialKeys = [
        'algofilerouteapi',
        'algofilerouteapi6m',
        'algofilerouteapi1y',
        'algofilerouteapi2y',
      ];
      for (const key of officialKeys) {
        const hashedKey = crypto.createHash('sha256').update(key).digest('hex');
        const existingKey = await this.apiKeyModel
          .findOne({ name: key })
          .exec();

        if (!existingKey) {
          const bucket = await this.bucketModel.findOne({ name: key }).exec();
          if (bucket) {
            console.log(`Seeding official API key: ${key}...`);
            await this.apiKeyModel.create({
              hashedKey,
              prefix: key.substring(0, 19) + '...',
              name: key,
              owner: adminUser._id,
              bucket: bucket._id,
              isPaid: true,
              customFeeUsd: 0.025,
              paymentCurrency: 'USDC',
            });
          }
        } else {
          // Ensure the existing API key references the current bucket ID, owner, and has correct fee
          let changed = false;
          const bucket = await this.bucketModel.findOne({ name: key }).exec();
          if (
            bucket &&
            (existingKey.bucket?.toString() !== bucket._id.toString() ||
              existingKey.owner?.toString() !== adminUser._id.toString())
          ) {
            console.log(
              `Updating stale bucket/owner reference for official API key: ${key}...`,
            );
            existingKey.bucket = bucket._id;
            existingKey.owner = adminUser._id;
            changed = true;
          }
          if (existingKey.customFeeUsd !== 0.025) {
            console.log(
              `Updating customFeeUsd to 0.025 for official API key: ${key}...`,
            );
            existingKey.customFeeUsd = 0.025;
            changed = true;
          }
          if (changed) {
            await existingKey.save();
          }
        }
      }
    } catch (err) {
      console.error('Failed to seed official API keys:', err);
    }
  }

  async findById(id: string): Promise<UserDocument> {
    const user = await this.userModel.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if storage plan has expired
    if (
      user.planExpiresAt &&
      new Date() > user.planExpiresAt &&
      user.planType !== 'free'
    ) {
      user.planType = 'free';
      user.storageLimitGb = 1;
      user.planExpiresAt = null;
      await user.save();
    }

    return user;
  }

  async findAll(): Promise<UserDocument[]> {
    return this.userModel.find().sort({ displayName: 1 }).exec();
  }

  async findOrCreateByGoogleId(googleProfile: {
    googleId: string;
    email: string;
    displayName: string;
    avatarUrl: string;
  }): Promise<UserDocument> {
    const { googleId, email, displayName, avatarUrl } = googleProfile;

    let user = await this.userModel.findOne({ googleId });
    if (!user) {
      // Check if email already exists
      user = await this.userModel.findOne({ email });
      if (user) {
        // Link google account to existing email
        user.googleId = googleId;
        user.displayName = displayName;
        user.avatarUrl = avatarUrl;
        await user.save();
      } else {
        user = await this.userModel.create({
          googleId,
          email,
          displayName,
          avatarUrl,
        });
      }
    }

    if (!user) {
      throw new Error('User creation/retrieval failed');
    }

    return user;
  }

  async saveFilebaseCredentials(
    userId: string,
    accessKey: string,
    secretKey: string,
  ): Promise<User> {
    const user = await this.findById(userId);

    // Encrypt Access Key and Secret Key
    const iv = crypto.randomBytes(16);

    const encrypt = (text: string) => {
      const cipher = crypto.createCipheriv(
        'aes-256-cbc',
        this.encryptionKey,
        iv,
      );
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return encrypted;
    };

    user.filebaseAccessKey = encrypt(accessKey);
    user.filebaseSecretKey = encrypt(secretKey);
    user.filebaseIv = iv.toString('hex');

    return user.save();
  }

  async getFilebaseCredentials(
    userId: string,
  ): Promise<{ accessKey: string; secretKey: string } | null> {
    const user = await this.findById(userId);

    if (
      !user.filebaseAccessKey ||
      !user.filebaseSecretKey ||
      !user.filebaseIv
    ) {
      return null;
    }

    const iv = Buffer.from(user.filebaseIv, 'hex');

    const decrypt = (encryptedText: string) => {
      try {
        const decipher = crypto.createDecipheriv(
          'aes-256-cbc',
          this.encryptionKey,
          iv,
        );
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      } catch (err) {
        throw new BadRequestException(
          'Failed to decrypt Filebase credentials. Encryption key might have changed.',
        );
      }
    };

    return {
      accessKey: decrypt(user.filebaseAccessKey),
      secretKey: decrypt(user.filebaseSecretKey),
    };
  }

  async clearFilebaseCredentials(userId: string): Promise<User> {
    const user = await this.findById(userId);
    user.filebaseAccessKey = null;
    user.filebaseSecretKey = null;
    user.filebaseIv = null;
    return user.save();
  }

  async createApiKey(
    userId: string,
    name: string,
    bucketId: string,
    isPaid?: boolean,
    customFeeUsd?: number,
    paymentCurrency?: string,
  ): Promise<{ rawKey: string; keyRecord: ApiKeyDocument }> {
    const bucket = await this.bucketModel.findById(bucketId).exec();
    if (!bucket) {
      throw new NotFoundException('Selected storage bucket not found.');
    }

    if (bucket.owner?.toString() !== userId) {
      throw new BadRequestException(
        'Access denied: You do not own the selected bucket.',
      );
    }

    const plainKey = `algofile_key_${crypto.randomBytes(24).toString('hex')}`;
    const hashedKey = crypto
      .createHash('sha256')
      .update(plainKey)
      .digest('hex');
    const prefix = plainKey.substring(0, 19) + '...';

    // Validate fee: min $0.025, max $5.00 (ponytail: quick clamp)
    const finalFee = isPaid
      ? Math.min(
          5.0,
          Math.max(
            0.025,
            customFeeUsd !== undefined ? Number(customFeeUsd) : 0.025,
          ),
        )
      : 0.025;
    const finalCurrency = 'USDC';

    const newKey = await this.apiKeyModel.create({
      hashedKey,
      prefix,
      name,
      owner: userId as any,
      bucket: bucketId as any,
      isPaid: !!isPaid,
      customFeeUsd: finalFee,
      paymentCurrency: finalCurrency,
    });

    return { rawKey: plainKey, keyRecord: newKey };
  }

  async listApiKeys(userId: string): Promise<ApiKeyDocument[]> {
    return this.apiKeyModel
      .find({ owner: userId as any })
      .populate('bucket')
      .sort({ createdAt: -1 })
      .exec();
  }

  async revokeApiKey(userId: string, keyId: string): Promise<void> {
    const result = await this.apiKeyModel
      .deleteOne({ _id: keyId, owner: userId })
      .exec();
    if (result.deletedCount === 0) {
      throw new NotFoundException('API Key not found or access denied');
    }
  }

  async validateApiKey(rawKey: string): Promise<ApiKeyDocument | null> {
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyRecord = await this.apiKeyModel
      .findOne({ hashedKey })
      .populate('bucket')
      .exec();
    if (!keyRecord) {
      return null;
    }
    keyRecord.lastUsedAt = new Date();
    await keyRecord.save();
    return keyRecord;
  }

  async getAdminStats(): Promise<{
    totalUsers: number;
    boughtBucketsCount: number;
    totalBoughtStorageGb: number;
    totalUsedStorageBytes: number;
  }> {
    const totalUsers = await this.userModel.countDocuments().exec();

    const boughtBucketsCount = await this.bucketModel
      .countDocuments({
        owner: { $ne: null },
        name: { $not: /^algofile-free-/ },
      })
      .exec();

    const bucketStorageAgg = await this.bucketModel
      .aggregate([
        {
          $match: {
            owner: { $ne: null },
            name: { $not: /^algofile-free-/ },
          },
        },
        {
          $group: {
            _id: null,
            totalGb: { $sum: '$maxSizeGb' },
          },
        },
      ])
      .exec();
    const totalBoughtStorageGb = bucketStorageAgg[0]?.totalGb || 0;

    const totalUsedStorageBytes = await this.getGlobalUsedStorageBytes();

    return {
      totalUsers,
      boughtBucketsCount,
      totalBoughtStorageGb,
      totalUsedStorageBytes,
    };
  }

  async getPublicStats(): Promise<{
    totalBuckets: number;
    totalUsedStorageGb: number;
    totalWallets: number;
    totalBoughtStorageGb: number;
    totalAssetsMinted: number;
  }> {
    const now = Date.now();
    if (this.cachedPublicStats && now - this.lastPublicStatsFetch < 300000) {
      return this.cachedPublicStats;
    }

    // 1. Count unique wallets in-memory without bulk writing to ActiveWallet collection
    const userWallets = await this.userModel
      .distinct('peraWalletAddress', { peraWalletAddress: { $ne: null } })
      .exec();
    const mintWallets = await this.mintTransactionModel
      .distinct('sender', { sender: { $ne: null } })
      .exec();
    const uniqueWallets = new Set(
      [...userWallets, ...mintWallets]
        .map((w) => w?.toLowerCase().trim())
        .filter(Boolean),
    );
    const totalWallets = uniqueWallets.size;

    // 2. Storage used (Bytes)
    const totalUsedStorageBytes = await this.getGlobalUsedStorageBytes();

    // 3. Storage purchased (GB)
    const boughtStorageAgg = await this.bucketModel
      .aggregate([
        {
          $match: {
            owner: { $ne: null },
            name: { $not: /^algofile-free-/ },
          },
        },
        { $group: { _id: null, totalGb: { $sum: '$maxSizeGb' } } },
      ])
      .exec();
    const totalBoughtStorageGb = boughtStorageAgg[0]?.totalGb || 0;

    // 4. Assets minted
    const totalAssetsMinted = await this.mintTransactionModel
      .countDocuments()
      .exec();

    // 5. Total Buckets
    const totalBuckets = await this.bucketModel
      .countDocuments({ owner: { $ne: null } })
      .exec();

    // 6. Record/Update in GlobalStats collection (upsert one document)
    const statsDoc = await this.globalStatsModel
      .findOneAndUpdate(
        {},
        {
          totalWallets,
          totalUsedStorageBytes,
          totalBoughtStorageGb,
          totalAssetsMinted,
          totalBuckets,
        },
        { upsert: true, returnDocument: 'after' },
      )
      .exec();

    this.cachedPublicStats = {
      totalBuckets: statsDoc.totalBuckets,
      totalUsedStorageGb:
        Number(
          (statsDoc.totalUsedStorageBytes / (1024 * 1024 * 1024)).toFixed(3),
        ) || 0.05,
      totalWallets: statsDoc.totalWallets,
      totalBoughtStorageGb: statsDoc.totalBoughtStorageGb,
      totalAssetsMinted: statsDoc.totalAssetsMinted,
    };
    this.lastPublicStatsFetch = now;

    return this.cachedPublicStats;
  }

  /**
   * Real storage used across the whole Filebase account (every S3 bucket, every object),
   * so it matches the Filebase dashboard. Cached for 10 minutes; falls back to the
   * MongoDB bucket counters if S3 is unreachable.
   */
  async getGlobalUsedStorageBytes(forceRefresh = false): Promise<number> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.cachedFilebaseUsedBytes !== null &&
      now - this.lastFilebaseUsageFetch < 600000
    ) {
      return this.cachedFilebaseUsedBytes;
    }

    try {
      const s3Client = this.filebaseClient.getS3Client();
      const { Buckets } = await s3Client.send(new ListBucketsCommand({}));

      let totalBytes = 0;
      for (const b of Buckets || []) {
        if (!b.Name) continue;
        let continuationToken: string | undefined;
        do {
          const listRes = await s3Client.send(
            new ListObjectsV2Command({
              Bucket: b.Name,
              ContinuationToken: continuationToken,
            }),
          );
          for (const obj of listRes.Contents || []) {
            totalBytes += obj.Size || 0;
          }
          continuationToken = listRes.IsTruncated
            ? listRes.NextContinuationToken
            : undefined;
        } while (continuationToken);
      }

      this.cachedFilebaseUsedBytes = totalBytes;
      this.lastFilebaseUsageFetch = now;
      return totalBytes;
    } catch (err) {
      console.warn(
        'Failed to read global storage from Filebase S3, falling back to MongoDB counters:',
        err.message,
      );
      const usedStorageAgg = await this.bucketModel
        .aggregate([
          { $group: { _id: null, totalBytes: { $sum: '$usedSizeBytes' } } },
        ])
        .exec();
      return this.cachedFilebaseUsedBytes ?? (usedStorageAgg[0]?.totalBytes || 0);
    }
  }
}
