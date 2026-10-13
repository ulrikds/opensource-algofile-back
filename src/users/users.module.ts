import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User, UserSchema } from './schemas/user.schema';
import { ApiKey, ApiKeySchema } from './schemas/api-key.schema';
import { Bucket, BucketSchema } from '../filebase/schemas/bucket.schema';
import { GlobalStats, GlobalStatsSchema } from './schemas/global-stats.schema';
import {
  MintTransaction,
  MintTransactionSchema,
} from '../collections/schemas/mint-transaction.schema';
import {
  ActiveWallet,
  ActiveWalletSchema,
} from './schemas/active-wallet.schema';
import { FilebaseClientService } from '../filebase/services/filebase-client.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: ApiKey.name, schema: ApiKeySchema },
      { name: Bucket.name, schema: BucketSchema },
      { name: GlobalStats.name, schema: GlobalStatsSchema },
      { name: MintTransaction.name, schema: MintTransactionSchema },
      { name: ActiveWallet.name, schema: ActiveWalletSchema },
    ]),
  ],
  providers: [UsersService, FilebaseClientService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
