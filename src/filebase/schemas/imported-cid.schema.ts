import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { User } from '../../users/schemas/user.schema';

export type ImportedCidDocument = ImportedCid & Document;

@Schema({ timestamps: true, collection: 'importedcids' })
export class ImportedCid {
  @Prop({ required: true, index: true })
  cid: string;

  @Prop({ required: true, lowercase: true, index: true })
  bucketName: string;

  @Prop({ required: false, default: '' })
  name?: string;

  @Prop({ required: false, index: true })
  fileId?: string;

  @Prop({ required: false, index: true })
  folder?: string;

  @Prop({ required: false })
  mimeType?: string;

  @Prop({ required: false })
  fileType?: string;

  @Prop({ required: false })
  url?: string;

  @Prop({ required: true, default: 0 })
  sizeBytes: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: false, index: true })
  owner?: User;

  @Prop({ required: false, default: 'single' })
  importType?: string; // 'single' | 'bulk'

  @Prop({ required: false, default: 'pinned', index: true })
  status?: string;

  @Prop({ required: false })
  s3Key?: string;

  @Prop({ required: false, default: false })
  isExistingRef?: boolean;

  @Prop({ type: Object, required: false })
  metadata?: Record<string, any>;

  @Prop({ required: false, index: true })
  imageCid?: string;
}

export const ImportedCidSchema = SchemaFactory.createForClass(ImportedCid);
ImportedCidSchema.index({ cid: 1, bucketName: 1, owner: 1 });
ImportedCidSchema.index({ bucketName: 1, folder: 1 });
