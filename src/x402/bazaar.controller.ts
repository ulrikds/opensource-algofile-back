import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  Body,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { X402Service, declareDiscoveryExtension, X402PaymentRequirements, ProjectMetadataResolver } from './x402.service';
import { PRICING_CONFIG } from '../config/pricing.config';

@Controller(['v3/x402/bazaar', 'x402/bazaar'])
export class BazaarController {
  private readonly receiverWallet: string;

  constructor(
    private readonly x402Service: X402Service,
    private readonly configService: ConfigService,
  ) {
    this.receiverWallet =
      this.configService.get<string>('ALGORAND_RECEIVER_WALLET') ||
      this.configService.get<string>('AVM_ADDRESS') ||
      'T24X7CCVMNXYZ402BAZAARRECEIVERADDRESSDEMO12345';
  }

  /**
   * Health check endpoint - Free (No payment required)
   */
  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      service: 'AlgoFile x402 Bazaar Discovery Resource Server',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Storage Info Endpoint - AlgoFile Decentralized Storage Discovery ($0.001 ALGO)
   */
  @Get('storage-info')
  async getStorageInfo(@Req() req: Request, @Res() res: Response) {
    const requirements = this.x402Service.createRequirements({
      url: '/api/v3/x402/bazaar/storage-info',
      amount: '1000',
      payTo: this.receiverWallet,
    });

    const bazaarExtension = ProjectMetadataResolver.buildBazaarExtensionFor('storageInfo', {
      method: 'GET',
      input: {},
      output: {
        network: 'Algorand',
        ipfsGateway: 'https://algofile.myfilebase.com',
        ratePerGbUsd: 0.2,
        status: 'operational',
      },
    });

    const payload = this.x402Service.extractX402Payload(req);
    if (!payload) {
      return this.x402Service.send402Response(
        res,
        requirements,
        bazaarExtension,
        'Payment Required for AlgoFile Storage Info ($0.001)',
      );
    }

    const settle = await this.x402Service.verifyAndSettle(
      payload,
      requirements,
      bazaarExtension,
    );
    return res.json({
      network: 'Algorand',
      ipfsGateway: 'https://algofile.myfilebase.com',
      ratePerGbUsd: PRICING_CONFIG.BAZAAR_STORAGE_INFO_RATE_PER_GB,
      status: 'operational',
      settlement: settle,
    });
  }

  /**
   * Asset Info Endpoint - AlgoFile Single Asset Mint Storage Discovery ($0.001 USDC / 1000 atomic units)
   * Designed exclusively for mint-asset Bazaar catalog discovery.
   */
  @Get(['asset-storage-info', 'asset-info'])
  async getAssetInfo(@Req() req: Request, @Res() res: Response) {
    const requirements = this.x402Service.createRequirements({
      url: '/api/v3/x402/bazaar/asset-storage-info',
      amount: '1000',
      payTo: this.receiverWallet,
    });

    const bazaarExtension = ProjectMetadataResolver.buildBazaarExtensionFor('assetInfo', {
      method: 'GET',
      input: {},
      output: {
        network: 'Algorand',
        ipfsGateway: 'https://algofile.myfilebase.com',
        ratePerGbUsd: 0.4,
        status: 'operational',
      },
    });

    const payload = this.x402Service.extractX402Payload(req);
    if (!payload) {
      return this.x402Service.send402Response(
        res,
        requirements,
        bazaarExtension,
        'Payment Required for AlgoFile Storage Info ($0.001)',
      );
    }

    const settle = await this.x402Service.verifyAndSettle(
      payload,
      requirements,
      bazaarExtension,
    );
    return res.json({
      network: 'Algorand',
      ipfsGateway: 'https://algofile.myfilebase.com',
      ratePerGbUsd: 0.4,
      status: 'operational',
      settlement: settle,
    });
  }
}
