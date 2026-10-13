import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ActiveWalletDocument = ActiveWallet & Document;

@Schema({ timestamps: true })
export class ActiveWallet {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  address: string;
}

export const ActiveWalletSchema = SchemaFactory.createForClass(ActiveWallet);
