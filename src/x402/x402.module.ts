import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { X402Service } from './x402.service';
import { BazaarController } from './bazaar.controller';
import { V2CompatibilityController } from './v2-compatibility.controller';

@Module({
  imports: [ConfigModule],
  controllers: [BazaarController, V2CompatibilityController],
  providers: [X402Service],
  exports: [X402Service],
})
export class X402Module {}
