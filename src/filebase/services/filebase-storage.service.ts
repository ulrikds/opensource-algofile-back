import { Injectable } from '@nestjs/common';
import { FilebaseUploadService } from './filebase-upload.service';
import { FilebaseFileOpsService } from './filebase-file-ops.service';
import { FilebaseFileExplorerService } from './filebase-file-explorer.service';
import { FilebaseMultipartService } from './filebase-multipart.service';

/**
 * FilebaseStorageService
 * Unified facade coordinating storage operations across specialized sub-services:
 * - FilebaseUploadService: buffer uploads, presigned URLs, and upload confirmations
 * - FilebaseFileOpsService: file and folder operations (create, delete, move, copy)
 * - FilebaseFileExplorerService: directory exploration, metadata inspection, and object streams
 * - FilebaseMultipartService: S3 multipart upload lifecycle
 */
@Injectable()
export class FilebaseStorageService {
  constructor(
    private readonly uploadService: FilebaseUploadService,
    private readonly fileOpsService: FilebaseFileOpsService,
    private readonly explorerService: FilebaseFileExplorerService,
    private readonly multipartService: FilebaseMultipartService,
  ) {}

  // ==========================================
  // Uploads & Presigned URLs
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
    return this.uploadService.uploadFile(
      userId,
      bucketName,
      key,
      fileBuffer,
      mimeType,
      options,
    );
  }

  getPresignedUploadUrl(
    userId: string,
    bucketName: string,
    key: string,
    contentType: string,
  ) {
    return this.uploadService.getPresignedUploadUrl(
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
    return this.uploadService.generateBucketPresignedUrl(
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
    return this.uploadService.generateBucketPresignedUrlsBulk(
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
    return this.uploadService.confirmDirectUpload(
      userId,
      bucketName,
      key,
      originalName,
      providedCid,
      providedSizeBytes,
    );
  }

  uploadFileViaApi(
    userId: string,
    bucketName: string,
    fileName: string,
    fileBuffer: Buffer,
    mimeType: string,
    folder?: string,
  ) {
    return this.uploadService.uploadFileViaApi(
      userId,
      bucketName,
      fileName,
      fileBuffer,
      mimeType,
      folder,
    );
  }

  confirmDirectUploadsBulk(
    userId: string,
    bucketName: string,
    items: Array<{ key: string; originalName?: string; cid?: string }>,
  ) {
    return this.uploadService.confirmDirectUploadsBulk(userId, bucketName, items);
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
    return this.uploadService.confirmPublicBulkUpload(
      userId,
      bucketName,
      items,
    );
  }

  // ==========================================
  // File & Folder Operations
  // ==========================================
  copyFile(
    sourceUserId: string,
    destUserId: string,
    bucketName: string,
    sourceKey: string,
    destKey: string,
  ) {
    return this.fileOpsService.copyFile(
      sourceUserId,
      destUserId,
      bucketName,
      sourceKey,
      destKey,
    );
  }

  deleteFile(userId: string, bucketName: string, key: string) {
    return this.fileOpsService.deleteFile(userId, bucketName, key);
  }

  createFolder(
    userId: string,
    bucketName: string,
    folderName: string,
    parentFolder?: string,
  ) {
    return this.fileOpsService.createFolder(
      userId,
      bucketName,
      folderName,
      parentFolder,
    );
  }

  deleteFolder(userId: string, bucketName: string, folderPath: string) {
    return this.fileOpsService.deleteFolder(userId, bucketName, folderPath);
  }

  deleteSingleFile(userId: string, bucketName: string, key: string) {
    return this.fileOpsService.deleteSingleFile(userId, bucketName, key);
  }

  moveFile(
    userId: string,
    bucketName: string,
    sourceKey: string,
    destFolder: string,
  ) {
    return this.fileOpsService.moveFile(
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
    return this.fileOpsService.moveFilesBulk(
      userId,
      bucketName,
      sourceKeys,
      destFolder,
    );
  }

  deleteFilesBulk(userId: string, bucketName: string, keys: string[]) {
    return this.fileOpsService.deleteFilesBulk(userId, bucketName, keys);
  }

  // ==========================================
  // File Explorer & Metadata
  // ==========================================
  getFileMetadata(
    userId: string,
    bucketName: string,
    key: string,
    maxRetries?: number,
    delayMs?: number,
  ) {
    return this.explorerService.getFileMetadata(
      userId,
      bucketName,
      key,
      maxRetries,
      delayMs,
    );
  }

  getFileSize(userId: string, bucketName: string, key: string) {
    return this.explorerService.getFileSize(userId, bucketName, key);
  }

  listBucketFiles(
    userId: string,
    bucketName: string,
    limit: number = 50,
    continuationToken?: string,
    folder?: string,
  ) {
    return this.explorerService.listBucketFiles(
      userId,
      bucketName,
      limit,
      continuationToken,
      folder,
    );
  }

  getObject(userId: string, bucketName: string, key: string) {
    return this.explorerService.getObject(userId, bucketName, key);
  }

  getObjectAcl(userId: string, bucketName: string, key: string) {
    return this.explorerService.getObjectAcl(userId, bucketName, key);
  }

  listObjectsV1(
    userId: string,
    bucketName: string,
    limit?: number,
    marker?: string,
  ) {
    return this.explorerService.listObjectsV1(
      userId,
      bucketName,
      limit,
      marker,
    );
  }

  // ==========================================
  // S3 Multipart Uploads
  // ==========================================
  createMultipartUpload(
    userId: string,
    bucketName: string,
    key: string,
    contentType?: string,
  ) {
    return this.multipartService.createMultipartUpload(
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
    return this.multipartService.uploadPart(
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
    return this.multipartService.completeMultipartUpload(
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
    return this.multipartService.abortMultipartUpload(
      userId,
      bucketName,
      key,
      uploadId,
    );
  }

  listMultipartUploads(userId: string, bucketName: string) {
    return this.multipartService.listMultipartUploads(userId, bucketName);
  }

  listParts(
    userId: string,
    bucketName: string,
    key: string,
    uploadId: string,
  ) {
    return this.multipartService.listParts(
      userId,
      bucketName,
      key,
      uploadId,
    );
  }
}
