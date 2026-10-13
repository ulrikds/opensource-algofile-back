import { Injectable } from '@nestjs/common';
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  HeadObjectCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Bucket, BucketDocument } from '../schemas/bucket.schema';
import { User, UserDocument } from '../../users/schemas/user.schema';
import { FilebaseClientService } from './filebase-client.service';

@Injectable()
export class FilebaseMultipartService {
  constructor(
    @InjectModel(Bucket.name)
    private readonly bucketModel: Model<BucketDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly clientService: FilebaseClientService,
  ) {}

  async createMultipartUpload(
    userId: string,
    bucketName: string,
    key: string,
    contentType?: string,
  ) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket, s3Key } = await this.clientService.getS3Params(bucketName, userId, key);
    const command = new CreateMultipartUploadCommand({
      Bucket: s3Bucket,
      Key: s3Key,
      ContentType: contentType,
    });
    return this.clientService.getS3Client().send(command);
  }

  async uploadPart(
    userId: string,
    bucketName: string,
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket, s3Key } = await this.clientService.getS3Params(bucketName, userId, key);
    const command = new UploadPartCommand({
      Bucket: s3Bucket,
      Key: s3Key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
    });
    return this.clientService.getS3Client().send(command);
  }

  async completeMultipartUpload(
    userId: string,
    bucketName: string,
    key: string,
    uploadId: string,
    parts: Array<{ ETag: string; PartNumber: number }>,
  ) {
    const bucket = await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket, s3Key } = await this.clientService.getS3Params(bucketName, userId, key);
    const command = new CompleteMultipartUploadCommand({
      Bucket: s3Bucket,
      Key: s3Key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    });
    const result = await this.clientService.getS3Client().send(command);

    // Track physical upload size
    let sizeBytes = 0;
    try {
      const headResponse = await this.clientService.getS3Client().send(
        new HeadObjectCommand({
          Bucket: s3Bucket,
          Key: s3Key,
        }),
      );
      sizeBytes = headResponse.ContentLength || 0;
    } catch (err) {
      console.warn(
        `Could not get size for completed multipart key ${key}: ${err.message}`,
      );
    }

    if (sizeBytes > 0) {
      const isFreeBucket = !bucket.owner;
      if (isFreeBucket) {
        await this.userModel
          .updateOne({ _id: userId }, { $inc: { usedStorageBytes: sizeBytes } })
          .exec();
      } else {
        await this.bucketModel
          .updateOne(
            { _id: bucket._id },
            { $inc: { usedSizeBytes: sizeBytes } },
          )
          .exec();
        await this.userModel
          .updateOne({ _id: userId }, { $inc: { usedStorageBytes: sizeBytes } })
          .exec();
      }
    }

    return result;
  }

  async abortMultipartUpload(
    userId: string,
    bucketName: string,
    key: string,
    uploadId: string,
  ) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket, s3Key } = await this.clientService.getS3Params(bucketName, userId, key);
    const command = new AbortMultipartUploadCommand({
      Bucket: s3Bucket,
      Key: s3Key,
      UploadId: uploadId,
    });
    return this.clientService.getS3Client().send(command);
  }

  async listMultipartUploads(userId: string, bucketName: string) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    // Every tenant shares one physical S3 bucket; without the prefix this lists everyone's uploads.
    const { s3Bucket, s3Key } = await this.clientService.getS3Params(bucketName, userId, '_');
    const command = new ListMultipartUploadsCommand({
      Bucket: s3Bucket,
      Prefix: s3Key!.slice(0, -1),
    });
    return this.clientService.getS3Client().send(command);
  }

  async listParts(
    userId: string,
    bucketName: string,
    key: string,
    uploadId: string,
  ) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket, s3Key } = await this.clientService.getS3Params(bucketName, userId, key);
    const command = new ListPartsCommand({
      Bucket: s3Bucket,
      Key: s3Key,
      UploadId: uploadId,
    });
    return this.clientService.getS3Client().send(command);
  }
}
