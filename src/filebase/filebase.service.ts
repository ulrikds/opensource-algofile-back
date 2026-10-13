import {
  Injectable,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Bucket, BucketDocument } from './schemas/bucket.schema';
import { FilebaseClientService } from './services/filebase-client.service';
import { FilebaseBucketService } from './services/filebase-bucket.service';
import { FilebaseStorageService } from './services/filebase-storage.service';
import { FilebasePinningService } from './services/filebase-pinning.service';

@Injectable()
export class FilebaseService implements OnApplicationBootstrap {
  constructor(
    @InjectModel(Bucket.name)
    private readonly bucketModel: Model<BucketDocument>,
    private readonly clientService: FilebaseClientService,
    private readonly bucketService: FilebaseBucketService,
    private readonly storageService: FilebaseStorageService,
    private readonly pinningService: FilebasePinningService,
  ) {}

  async onApplicationBootstrap() {
    await this.bucketService.seedBuckets();
    try {
      const command = new CreateBucketCommand({
        Bucket: 'algofile-bucket-custom',
      });
      await this.clientService.getS3Client().send(command);
    } catch (err) {
      // Ignore if it already exists
    }

    // Configure CORS for custom bucket
    await this.bucketService.configureBucketCors('algofile-bucket-custom');

    // Configure CORS and sync RPC tokens for all registered buckets
    try {
      const allBuckets = await this.bucketModel.find().exec();
      for (const bucket of allBuckets) {
        await this.bucketService.configureBucketCors(bucket.name);
        const correctToken = this.pinningService.getBucketRpcToken(
          bucket.name,
          bucket.ipfsRpcToken,
        );
        if (correctToken && bucket.ipfsRpcToken !== correctToken) {
          bucket.ipfsRpcToken = correctToken;
          await bucket.save();
          console.log(
            `[FilebaseService] Auto-updated IPFS RPC token for bucket '${bucket.name}'.`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `Failed to retrieve/configure CORS or tokens on buckets: ${err.message}`,
      );
    }
  }

  // ==========================================
  // Client & Ownership Delegates
  // ==========================================
  getUserHash(userId: string): string {
    return this.clientService.getUserHash(userId);
  }

  isCustomStorageBucket(bucket: any, name: string): boolean {
    return this.clientService.isCustomStorageBucket(bucket, name);
  }

  getS3Params(bucketName: string, userId: string, key?: string) {
    return this.clientService.getS3Params(bucketName, userId, key);
  }

  verifyBucketOwnership(userId: string, bucketName: string) {
    return this.clientService.verifyBucketOwnership(userId, bucketName);
  }

  // ==========================================
  // IPFS & Pinning Delegates
  // ==========================================
  getGatewayUrl(cid: string): string {
    return this.pinningService.getGatewayUrl(cid);
  }

  getGatewayUrlsForCid(cid: string): string[] {
    return this.pinningService.getGatewayUrlsForCid(cid);
  }

  getIpfsSizeCheckUrl(cid: string): string {
    return this.pinningService.getIpfsSizeCheckUrl(cid);
  }

  saveCidRecord(data: {
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
  }) {
    return this.pinningService.saveCidRecord(data);
  }

  findExistingCid(fileBuffer?: Buffer, cid?: string, providedFileHash?: string) {
    return this.pinningService.findExistingCid(fileBuffer, cid, providedFileHash);
  }

  findCidRecord(cid: string) {
    return this.pinningService.findCidRecord(cid);
  }

  resolveCidFromProvider(cid: string) {
    return this.pinningService.resolveCidFromProvider(cid);
  }

  cleanCid(raw: string): string {
    return this.pinningService.cleanCid(raw);
  }

  isValidCid(cid: string): boolean {
    return this.pinningService.isValidCid(cid);
  }

  getBucketRpcToken(bucketName: string, existingToken?: string): string {
    return this.pinningService.getBucketRpcToken(bucketName, existingToken);
  }

  checkExistingCidsInProject(cids: string[]) {
    return this.pinningService.checkExistingCidsInProject(cids);
  }

  resolveAssetMetadataBulk(cids: string[]) {
    return this.pinningService.resolveAssetMetadataBulk(cids);
  }

  pinCid(userId: string, bucketName: string, cid: string, name?: string, folder?: string) {
    return this.pinningService.pinCid(userId, bucketName, cid, name, folder);
  }

  getCreatorFolder(creatorAddress: string, bucketName?: string) {
    return this.pinningService.getCreatorFolder(creatorAddress, bucketName);
  }

  pinCidsBulk(
    userId: string,
    bucketName: string,
    cids: string[],
    names?: string[],
    folder?: string,
    autoPinImages?: boolean,
    creatorAddress?: string,
  ) {
    return this.pinningService.pinCidsBulk(
      userId,
      bucketName,
      cids,
      names,
      folder,
      autoPinImages,
      creatorAddress,
    );
  }

  listPinnedCids(userId: string, bucketName?: string) {
    return this.pinningService.listPinnedCids(userId, bucketName);
  }

  unpinCid(userId: string, pinId: string) {
    return this.pinningService.unpinCid(userId, pinId);
  }

  // ==========================================
  // Bucket Management Delegates
  // ==========================================
  recalculateUserStorageBytes(userId: string): Promise<number> {
    return this.bucketService.recalculateUserStorageBytes(userId);
  }

  recalculateBucketSizeBytes(
    bucketName: string,
    userId?: string,
  ): Promise<number> {
    return this.bucketService.recalculateBucketSizeBytes(bucketName, userId);
  }

  recalculateFreeBucketPoolStorage(): Promise<number> {
    return this.bucketService.recalculateFreeBucketPoolStorage();
  }

  listBuckets(userId: string) {
    return this.bucketService.listBuckets(userId);
  }

  listBucketsForAdmin(userId: string) {
    return this.bucketService.listBucketsForAdmin(userId);
  }

  updateBucketExpirationByAdmin(
    userId: string,
    bucketId: string,
    expiresAt: Date | null,
  ) {
    return this.bucketService.updateBucketExpirationByAdmin(
      userId,
      bucketId,
      expiresAt,
    );
  }

  findBucketsByWallet(walletAddress: string) {
    return this.bucketService.findBucketsByWallet(walletAddress);
  }

  renameBucket(userId: string, oldName: string, newName: string) {
    return this.bucketService.renameBucket(userId, oldName, newName);
  }

  createBucket(userId: string, bucketName: string, maxSizeGb: number = 5) {
    return this.bucketService.createBucket(userId, bucketName, maxSizeGb);
  }

  deleteBucket(userId: string, bucketName: string) {
    return this.bucketService.deleteBucket(userId, bucketName);
  }

  emptyBucket(userId: string, bucketName: string) {
    return this.bucketService.emptyBucket(userId, bucketName);
  }

  syncBucketStorage(userId: string, bucketName: string) {
    return this.bucketService.syncBucketStorage(userId, bucketName);
  }

  incrementBucketSize(bucketName: string, sizeBytes: number) {
    return this.bucketService.incrementBucketSize(bucketName, sizeBytes);
  }

  configureBucketCors(bucketName: string): Promise<void> {
    return this.bucketService.configureBucketCors(bucketName);
  }

  seedBuckets() {
    return this.bucketService.seedBuckets();
  }

  headBucket(userId: string, bucketName: string) {
    return this.bucketService.headBucket(userId, bucketName);
  }

  getBucketLocation(userId: string, bucketName: string) {
    return this.bucketService.getBucketLocation(userId, bucketName);
  }

  getBucketAcl(userId: string, bucketName: string) {
    return this.bucketService.getBucketAcl(userId, bucketName);
  }

  putBucketAcl(userId: string, bucketName: string, acl: string) {
    return this.bucketService.putBucketAcl(userId, bucketName, acl);
  }

  getBucketCors(userId: string, bucketName: string) {
    return this.bucketService.getBucketCors(userId, bucketName);
  }

  putBucketCors(userId: string, bucketName: string, corsRules: any[]) {
    return this.bucketService.putBucketCors(userId, bucketName, corsRules);
  }

  deleteBucketCors(userId: string, bucketName: string) {
    return this.bucketService.deleteBucketCors(userId, bucketName);
  }

  getBucketLifecycle(userId: string, bucketName: string) {
    return this.bucketService.getBucketLifecycle(userId, bucketName);
  }

  getBucketLifecycleConfiguration(userId: string, bucketName: string) {
    return this.bucketService.getBucketLifecycleConfiguration(
      userId,
      bucketName,
    );
  }

  getBucketVersioning(userId: string, bucketName: string) {
    return this.bucketService.getBucketVersioning(userId, bucketName);
  }

  getBucketLogging(userId: string, bucketName: string) {
    return this.bucketService.getBucketLogging(userId, bucketName);
  }

  // ==========================================
  // Storage & File Operations Delegates
  // ==========================================
  uploadFile(
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
  ) {
    return this.storageService.uploadFile(
      userId,
      bucketName,
      key,
      fileBuffer,
      mimeType,
      options,
    );
  }

  copyFile(
    sourceUserId: string,
    destUserId: string,
    bucketName: string,
    sourceKey: string,
    destKey: string,
  ) {
    return this.storageService.copyFile(
      sourceUserId,
      destUserId,
      bucketName,
      sourceKey,
      destKey,
    );
  }

  getPresignedUploadUrl(
    userId: string,
    bucketName: string,
    key: string,
    contentType: string,
  ) {
    return this.storageService.getPresignedUploadUrl(
      userId,
      bucketName,
      key,
      contentType,
    );
  }

  generateBucketPresignedUrl(
    userId: string,
    bucketName: string,
    fileName: string,
    contentType?: string,
    folder?: string,
    fileHash?: string,
    sizeBytes?: number,
  ) {
    return this.storageService.generateBucketPresignedUrl(
      userId,
      bucketName,
      fileName,
      contentType,
      folder,
      fileHash,
      sizeBytes,
    );
  }

  generateBucketPresignedUrlsBulk(
    userId: string,
    bucketName: string,
    items: Array<{
      fileName: string;
      contentType?: string;
      fileHash?: string;
      sizeBytes?: number;
    }>,
    folder?: string,
  ) {
    return this.storageService.generateBucketPresignedUrlsBulk(
      userId,
      bucketName,
      items,
      folder,
    );
  }

  confirmDirectUpload(
    userId: string,
    bucketName: string,
    key: string,
    originalName?: string,
    providedCid?: string,
    providedSizeBytes?: number,
  ) {
    return this.storageService.confirmDirectUpload(
      userId,
      bucketName,
      key,
      originalName,
      providedCid,
      providedSizeBytes,
    );
  }

  confirmDirectUploadsBulk(
    userId: string,
    bucketName: string,
    items: Array<{ key: string; originalName?: string; cid?: string }>,
  ) {
    return this.storageService.confirmDirectUploadsBulk(userId, bucketName, items);
  }

  getFileMetadata(
    userId: string,
    bucketName: string,
    key: string,
    maxRetries?: number,
    delayMs?: number,
  ) {
    return this.storageService.getFileMetadata(
      userId,
      bucketName,
      key,
      maxRetries,
      delayMs,
    );
  }

  getFileSize(userId: string, bucketName: string, key: string) {
    return this.storageService.getFileSize(userId, bucketName, key);
  }

  deleteFile(userId: string, bucketName: string, key: string) {
    return this.storageService.deleteFile(userId, bucketName, key);
  }

  listBucketFiles(
    userId: string,
    bucketName: string,
    limit: number = 50,
    continuationToken?: string,
    folder?: string,
  ) {
    return this.storageService.listBucketFiles(
      userId,
      bucketName,
      limit,
      continuationToken,
      folder,
    );
  }

  createFolder(
    userId: string,
    bucketName: string,
    folderName: string,
    parentFolder?: string,
  ) {
    return this.storageService.createFolder(
      userId,
      bucketName,
      folderName,
      parentFolder,
    );
  }

  deleteFolder(userId: string, bucketName: string, folderPath: string) {
    return this.storageService.deleteFolder(userId, bucketName, folderPath);
  }

  deleteSingleFile(userId: string, bucketName: string, key: string) {
    return this.storageService.deleteSingleFile(userId, bucketName, key);
  }

  moveFile(
    userId: string,
    bucketName: string,
    sourceKey: string,
    destFolder: string,
  ) {
    return this.storageService.moveFile(
      userId,
      bucketName,
      sourceKey,
      destFolder,
    );
  }

  moveFilesBulk(
    userId: string,
    bucketName: string,
    sourceKeys: string[],
    destFolder: string,
  ) {
    return this.storageService.moveFilesBulk(
      userId,
      bucketName,
      sourceKeys,
      destFolder,
    );
  }

  deleteFilesBulk(userId: string, bucketName: string, keys: string[]) {
    return this.storageService.deleteFilesBulk(userId, bucketName, keys);
  }

  uploadFileViaApi(
    userId: string,
    bucketName: string,
    fileName: string,
    fileBuffer: Buffer,
    mimeType: string,
    folder?: string,
  ) {
    return this.storageService.uploadFileViaApi(
      userId,
      bucketName,
      fileName,
      fileBuffer,
      mimeType,
      folder,
    );
  }

  getObject(userId: string, bucketName: string, key: string) {
    return this.storageService.getObject(userId, bucketName, key);
  }

  getObjectAcl(userId: string, bucketName: string, key: string) {
    return this.storageService.getObjectAcl(userId, bucketName, key);
  }

  createMultipartUpload(
    userId: string,
    bucketName: string,
    key: string,
    contentType?: string,
  ) {
    return this.storageService.createMultipartUpload(
      userId,
      bucketName,
      key,
      contentType,
    );
  }

  uploadPart(
    userId: string,
    bucketName: string,
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ) {
    return this.storageService.uploadPart(
      userId,
      bucketName,
      key,
      uploadId,
      partNumber,
      body,
    );
  }

  completeMultipartUpload(
    userId: string,
    bucketName: string,
    key: string,
    uploadId: string,
    parts: Array<{ ETag: string; PartNumber: number }>,
  ) {
    return this.storageService.completeMultipartUpload(
      userId,
      bucketName,
      key,
      uploadId,
      parts,
    );
  }

  abortMultipartUpload(
    userId: string,
    bucketName: string,
    key: string,
    uploadId: string,
  ) {
    return this.storageService.abortMultipartUpload(
      userId,
      bucketName,
      key,
      uploadId,
    );
  }

  listMultipartUploads(userId: string, bucketName: string) {
    return this.storageService.listMultipartUploads(userId, bucketName);
  }

  listParts(
    userId: string,
    bucketName: string,
    key: string,
    uploadId: string,
  ) {
    return this.storageService.listParts(userId, bucketName, key, uploadId);
  }

  listObjectsV1(
    userId: string,
    bucketName: string,
    limit?: number,
    marker?: string,
  ) {
    return this.storageService.listObjectsV1(
      userId,
      bucketName,
      limit,
      marker,
    );
  }

  confirmPublicBulkUpload(
    userId: string,
    bucketName: string,
    items: Array<{
      key: string;
      originalName?: string;
      cid?: string;
    }>,
  ) {
    return this.storageService.confirmPublicBulkUpload(
      userId,
      bucketName,
      items,
    );
  }
}
