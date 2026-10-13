import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PartnerDocument = Partner & Document;

@Schema({ timestamps: true })
export class Partner {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, trim: true })
  cid: string;

  @Prop({ required: true, trim: true })
  websiteUrl: string;

  @Prop({ default: 0 })
  order: number;

  @Prop({ default: true })
  isActive: boolean;
}

export const PartnerSchema = SchemaFactory.createForClass(Partner);
PartnerSchema.index({ order: 1, createdAt: -1 });
PartnerSchema.index({ isActive: 1 });
