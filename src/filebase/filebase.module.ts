import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FilebaseService } from './filebase.service';
import { FilebaseController } from './filebase.controller';
import { ExternalFilebaseController } from './external-filebase.controller';
import { Bucket, BucketSchema } from './schemas/bucket.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  Collection,
  CollectionSchema,
} from '../collections/schemas/collection.schema';
import { PinnedCid, PinnedCidSchema } from './schemas/pinned-cid.schema';
import { ImportedCid, ImportedCidSchema } from './schemas/imported-cid.schema';
import { UsersModule } from '../users/users.module';
import { PurchasesModule } from '../purchases/purchases.module';
import { X402Module } from '../x402/x402.module';
import { FilebaseClientService } from './services/filebase-client.service';
import { FilebaseBucketService } from './services/filebase-bucket.service';
import { FilebaseStorageService } from './services/filebase-storage.service';
import { FilebasePinningService } from './services/filebase-pinning.service';
import { FilebaseUploadService } from './services/filebase-upload.service';
import { FilebaseFileOpsService } from './services/filebase-file-ops.service';
import { FilebaseFileExplorerService } from './services/filebase-file-explorer.service';
import { FilebaseMultipartService } from './services/filebase-multipart.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Bucket.name, schema: BucketSchema },
      { name: User.name, schema: UserSchema },
      { name: Collection.name, schema: CollectionSchema },
      { name: PinnedCid.name, schema: PinnedCidSchema },
      { name: ImportedCid.name, schema: ImportedCidSchema },
    ]),
    UsersModule,
    PurchasesModule,
    X402Module,
  ],
  providers: [
    FilebaseClientService,
    FilebaseBucketService,
    FilebaseStorageService,
    FilebasePinningService,
    FilebaseUploadService,
    FilebaseFileOpsService,
    FilebaseFileExplorerService,
    FilebaseMultipartService,
    FilebaseService,
  ],
  controllers: [FilebaseController, ExternalFilebaseController],
  exports: [
    FilebaseClientService,
    FilebaseBucketService,
    FilebaseStorageService,
    FilebasePinningService,
    FilebaseUploadService,
    FilebaseFileOpsService,
    FilebaseFileExplorerService,
    FilebaseMultipartService,
    FilebaseService,
    MongooseModule,
  ],
})
export class FilebaseModule {}
