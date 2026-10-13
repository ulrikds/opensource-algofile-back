import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { User } from '../../users/schemas/user.schema';
import { ApiKey } from '../../users/schemas/api-key.schema';
import { Bucket } from '../../filebase/schemas/bucket.schema';

export type PaidUploadDocument = PaidUpload & Document;

@Schema({ timestamps: true })
export class PaidUpload {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  owner: User; // Beneficiary of the payment (the API key owner)

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'ApiKey', required: false, index: true })
  apiKey?: ApiKey; // The paid API key used (optional)

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Bucket', required: true, index: true })
  bucket: Bucket; // The target S3 bucket

  @Prop({ required: true })
  fileName: string;

  @Prop({ required: true })
  fileSizeGb: number;

  @Prop({ required: true })
  amountPaidUsd: number; // Price calculated at $0.40/GB

  @Prop({ required: true })
  currency: string; // 'USDC' or 'ALGO'

  @Prop({ required: true, unique: true })
  txId: string; // Transaction hash from Algorand

  @Prop({ required: true })
  uploaderAddress: string; // Uploader's wallet address

  @Prop({ required: false })
  projectUrl?: string; // URL of the project communicating with the API

  @Prop({ type: String, default: 'mainnet' })
  network: string; // 'mainnet' or 'testnet'

  @Prop({ type: Number })
  durationMonths?: number; // Plan duration in months (optional)

  @Prop({ type: String })
  mintType?: string; // 'asset' or 'collection' (optional)
}

export const PaidUploadSchema = SchemaFactory.createForClass(PaidUpload);
