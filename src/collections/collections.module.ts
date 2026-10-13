import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CollectionsService } from './collections.service';
import { CollectionsController } from './collections.controller';
import { ExternalCollectionsController } from './external-collections.controller';
import { Collection, CollectionSchema } from './schemas/collection.schema';
import {
  MintTransaction,
  MintTransactionSchema,
} from './schemas/mint-transaction.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { FilebaseModule } from '../filebase/filebase.module';
import { PurchasesModule } from '../purchases/purchases.module';
import { X402Module } from '../x402/x402.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Collection.name, schema: CollectionSchema },
      { name: MintTransaction.name, schema: MintTransactionSchema },
      { name: User.name, schema: UserSchema },
    ]),
    FilebaseModule,
    PurchasesModule,
    X402Module,
    UsersModule,
  ],
  providers: [CollectionsService],
  controllers: [CollectionsController, ExternalCollectionsController],
})
export class CollectionsModule {}
