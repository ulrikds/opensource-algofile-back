import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GlobalStatsDocument = GlobalStats & Document;

@Schema({ timestamps: true })
export class GlobalStats {
  @Prop({ required: true, default: 0 })
  totalWallets: number;

  @Prop({ required: true, default: 0 })
  totalUsedStorageBytes: number;

  @Prop({ required: true, default: 0 })
  totalBoughtStorageGb: number;

  @Prop({ required: true, default: 0 })
  totalAssetsMinted: number;

  @Prop({ required: true, default: 0 })
  totalBuckets: number;
}

export const GlobalStatsSchema = SchemaFactory.createForClass(GlobalStats);
