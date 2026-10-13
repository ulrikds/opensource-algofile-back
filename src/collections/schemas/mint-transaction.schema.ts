import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { Collection } from './collection.schema';

export type MintTransactionDocument = MintTransaction & Document;

@Schema({ timestamps: true })
export class MintTransaction {
  @Prop({ required: true, unique: true })
  txId: string;

  @Prop({ required: true })
  assetId: number;

  @Prop({ required: true })
  name: string;

  @Prop()
  unitName?: string;

  @Prop({ required: true })
  url: string;

  @Prop({ required: true, index: true })
  sender: string;

  @Prop({ required: true })
  metadataCid: string;

  @Prop({ type: String, default: 'mainnet' })
  network: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Collection',
    required: true,
    index: true,
  })
  collectionId: Collection;

  @Prop({ type: Number })
  round?: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export const MintTransactionSchema =
  SchemaFactory.createForClass(MintTransaction);
