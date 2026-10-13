import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type ApiKeyLogDocument = ApiKeyLog & Document;

@Schema({ timestamps: true })
export class ApiKeyLog {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'ApiKey', required: false, index: true })
  apiKey?: any;

  @Prop({ type: String, required: true, index: true })
  apiKeyName: string;

  @Prop({ type: Boolean, default: false, index: true })
  isPublic: boolean;

  @Prop({ type: String, required: false, default: '' })
  origin: string;

  @Prop({ type: String, required: false, default: '' })
  referer: string;

  @Prop({ type: String, required: true, default: 'Direct API Call (No Origin)', index: true })
  projectUrl: string;

  @Prop({ type: String, required: true, default: '/' })
  endpoint: string;

  @Prop({ type: String, required: true, default: 'GET' })
  method: string;

  @Prop({ type: String, required: false, default: '' })
  ip: string;

  @Prop({ type: String, required: false, default: '' })
  userAgent: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: false, index: true })
  owner?: any;
}

export const ApiKeyLogSchema = SchemaFactory.createForClass(ApiKeyLog);

// Index for query optimization
ApiKeyLogSchema.index({ createdAt: -1 });
ApiKeyLogSchema.index({ projectUrl: 1, isPublic: 1 });
