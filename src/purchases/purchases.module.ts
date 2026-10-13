import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PurchasesController } from './purchases.controller';
import { X402PurchasesController } from './x402-purchases.controller';
import { PurchasesService } from './purchases.service';
import { Purchase, PurchaseSchema } from './schemas/purchase.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Bucket, BucketSchema } from '../filebase/schemas/bucket.schema';
import { PaidUpload, PaidUploadSchema } from './schemas/paid-upload.schema';
import { ApiKeyLog, ApiKeyLogSchema } from './schemas/api-key-log.schema';
import { X402Module } from '../x402/x402.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Purchase.name, schema: PurchaseSchema },
      { name: User.name, schema: UserSchema },
      { name: Bucket.name, schema: BucketSchema },
      { name: PaidUpload.name, schema: PaidUploadSchema },
      { name: ApiKeyLog.name, schema: ApiKeyLogSchema },
    ]),
    X402Module,
  ],
  controllers: [PurchasesController, X402PurchasesController],
  providers: [PurchasesService],
  exports: [PurchasesService, MongooseModule],
})
export class PurchasesModule {}
