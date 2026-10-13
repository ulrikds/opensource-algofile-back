import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { FilebaseModule } from './filebase/filebase.module';
import { CollectionsModule } from './collections/collections.module';
import { PurchasesModule } from './purchases/purchases.module';
import { X402Module } from './x402/x402.module';
import { PartnersModule } from './partners/partners.module';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import {
  OFFICIAL_KEY_NAMES,
  rateLimitTracker,
  resolveApiKey,
} from './auth/guards/api-key.guard';

import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        uri:
          configService.get<string>('MONGO_URI') ||
          'mongodb://localhost:27017/algofile',
      }),
    }),
    // ponytail: in-memory storage is per instance; move to a Redis storage if you run more than one replica.
    ThrottlerModule.forRoot({
      throttlers: [
        // Per client IP, per endpoint.
        { name: 'default', ttl: 60_000, limit: 100 },
        {
          // Shared public keys (algofilerouteapi*): one budget per client IP across all endpoints, 10 min cooldown.
          name: 'publicKey',
          ttl: 60_000,
          limit: 10,
          blockDuration: 10 * 60_000,
          skipIf: (ctx) =>
            !OFFICIAL_KEY_NAMES.includes(
              resolveApiKey(ctx.switchToHttp().getRequest()) ?? '',
            ),
          generateKey: (_ctx, tracker, name) => `${name}-${tracker}`,
        },
      ],
      getTracker: rateLimitTracker,
    }),
    AuthModule,
    UsersModule,
    FilebaseModule,
    CollectionsModule,
    PurchasesModule,
    X402Module,
    PartnersModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
