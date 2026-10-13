import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { User } from '../../users/schemas/user.schema';

export type BucketDocument = Bucket & Document;

@Schema({ timestamps: true })
export class Bucket {
  @Prop({ required: true, unique: true, lowercase: true })
  name: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: false,
    default: null,
    index: true,
  })
  owner?: User;

  @Prop({ required: true, default: 5 })
  maxSizeGb: number;

  @Prop({ required: true, default: 0 })
  usedSizeBytes: number;

  @Prop({ required: true })
  ipfsRpcToken: string;

  @Prop({ type: Date, required: false, default: null })
  expiresAt?: Date | null;
}

export const BucketSchema = SchemaFactory.createForClass(Bucket);
