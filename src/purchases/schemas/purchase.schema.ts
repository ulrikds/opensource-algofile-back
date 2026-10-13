import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { User } from '../../users/schemas/user.schema';

export type PurchaseDocument = Purchase & Document;

@Schema({ timestamps: true })
export class Purchase {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  user: User;

  @Prop({ required: true, unique: true })
  txId: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  currency: string; // 'ALGO' or 'USDC'

  @Prop({ required: true })
  planType: string; // '10gb', '25gb', '50gb'

  @Prop({ required: true })
  durationMonths: number; // 6, 12, 24

  @Prop({ required: true })
  priceUsd: number; // USD amount

  @Prop({ required: true })
  senderAddress: string; // Algorand wallet address that sent the transaction

  @Prop({ required: false })
  description?: string;

  @Prop({ type: String, default: 'mainnet' })
  network?: string;
}

export const PurchaseSchema = SchemaFactory.createForClass(Purchase);
