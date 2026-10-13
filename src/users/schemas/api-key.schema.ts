import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ApiKeyDocument = ApiKey & Document;

@Schema({ timestamps: true })
export class ApiKey {
  @Prop({ required: true, unique: true })
  hashedKey: string;

  @Prop({ required: true })
  prefix: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  owner: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Bucket', required: true, index: true })
  bucket: Types.ObjectId;

  @Prop({ type: Date, default: null })
  lastUsedAt: Date | null;

  @Prop({ type: Boolean, default: false })
  isPaid: boolean;

  @Prop({ type: Number, default: 0.025 })
  customFeeUsd: number;

  @Prop({ type: String, default: 'USDC' })
  paymentCurrency: string;
}

export const ApiKeySchema = SchemaFactory.createForClass(ApiKey);
