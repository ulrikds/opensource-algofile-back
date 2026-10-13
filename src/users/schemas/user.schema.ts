import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true })
  googleId: string;

  @Prop({ required: true, unique: true })
  email: string;

  @Prop({ required: true })
  displayName: string;

  @Prop()
  avatarUrl: string;

  // Filebase Credentials (Encrypted)
  @Prop({ type: String, default: null })
  filebaseAccessKey: string | null;

  @Prop({ type: String, default: null })
  filebaseSecretKey: string | null;

  // IV used for symmetric encryption of credentials
  @Prop({ type: String, default: null })
  filebaseIv: string | null;

  // Storage and Plan Details
  @Prop({ type: Number, default: 1 })
  storageLimitGb: number;

  @Prop({ type: Number, default: 0 })
  usedStorageBytes: number;

  @Prop({ type: String, default: 'free' })
  planType: string;

  @Prop({ type: Date, default: null })
  planExpiresAt: Date | null;

  @Prop({ type: String, default: null, index: true })
  peraWalletAddress: string | null;

  @Prop({ type: String, default: 'user', enum: ['user', 'admin'] })
  role: 'user' | 'admin';

  @Prop({ type: String, default: 'mainnet' })
  mintNetwork: string;
}

export const UserSchema = SchemaFactory.createForClass(User);
