import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { User } from '../../users/schemas/user.schema';

export type CollectionDocument = Collection & Document;

@Schema()
class Asset {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  imageKey: string;

  @Prop({ required: true })
  imageCid: string;

  @Prop({ required: true })
  imageUrl: string;

  @Prop({ required: true })
  metadataKey: string;

  @Prop({ required: true })
  metadataCid: string;

  @Prop({ required: true })
  metadataUrl: string;

  @Prop({ type: Number, default: null })
  assetId: number | null;

  @Prop()
  mimeType?: string;

  @Prop({ required: false })
  imageHash?: string;

  @Prop({ required: false })
  metadataHash?: string;

  @Prop({ type: Number, required: false })
  imageSize?: number;

  @Prop({ type: Number, required: false })
  metadataSize?: number;

  @Prop({ type: Number, default: 1 })
  sendNumber?: number;

  @Prop({ type: String, default: '1st Send' })
  sendLabel?: string;

  @Prop({ type: Date, default: Date.now })
  uploadedAt?: Date;
}

const AssetSchema = SchemaFactory.createForClass(Asset);

@Schema({ timestamps: true })
export class Collection {
  @Prop({ required: true })
  name: string;

  @Prop()
  description: string;

  @Prop({ required: true, index: true })
  bucketName: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  owner: User;

  @Prop({ type: [AssetSchema], default: [] })
  assets: Asset[];

  @Prop({ type: String, default: 'arc19' })
  metadataStandard: string;

  @Prop({ type: Boolean, default: false })
  uploadInterrupted: boolean;
}

export const CollectionSchema = SchemaFactory.createForClass(Collection);
CollectionSchema.index({ 'assets.metadataHash': 1 });
CollectionSchema.index({ 'assets.imageHash': 1 });
CollectionSchema.index({ 'assets.imageCid': 1 });
CollectionSchema.index({ 'assets.metadataCid': 1 });

