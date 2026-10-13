import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { User } from '../../users/schemas/user.schema';

export type PinnedCidDocument = PinnedCid & Document;

@Schema({ timestamps: true })
export class PinnedCid {
  @Prop({ required: true, index: true })
  cid: string;

  @Prop({ required: true, lowercase: true, index: true })
  bucketName: string;

  @Prop({ required: false, default: '' })
  name?: string;

  @Prop({ required: false, index: true })
  fileId?: string;

  @Prop({ type: Number, required: false, default: null, index: true })
  assetId?: number | null;

  @Prop({ required: false })
  mimeType?: string;

  @Prop({ required: false })
  fileType?: string;

  @Prop({ required: false })
  url?: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: false })
  metadata?: Record<string, any>;

  @Prop({ required: true, default: 0 })
  sizeBytes: number;

  @Prop({ required: false, index: true })
  fileHash?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: false, index: true })
  owner?: User;

  @Prop({ required: false, default: false, index: true })
  isImported?: boolean;

  @Prop({ required: false, index: true })
  imageCid?: string;
}

export const PinnedCidSchema = SchemaFactory.createForClass(PinnedCid);
PinnedCidSchema.index({ cid: 1, bucketName: 1 });


