import {
  Controller,
  Get,
  Post,
  Body,
  Request,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { PurchasesService } from './purchases.service';
import { X402Service, ProjectMetadataResolver } from '../x402/x402.service';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';

@Controller(['v3/purchases', 'purchases'])
export class X402PurchasesController {
  constructor(
    private readonly purchasesService: PurchasesService,
    private readonly x402Service: X402Service,
  ) {}

  private sendX402VerifyChallenge(res: any) {
    const requirements = this.x402Service.createRequirements({
      url: '/api/v3/purchases/x402-verify',
      amount: '1000000',
    });

    const bazaarExtension = ProjectMetadataResolver.buildBazaarExtensionFor('verifyPurchase', {
      method: 'POST',
      bodyType: 'json',
      input: { planType: '10gb', durationMonths: 6 },
      output: { success: true, bucketName: 'algofile-bucket' },
    });

    return this.x402Service.send402Response(
      res,
      requirements,
      bazaarExtension,
      'Payment Required for AlgoFile Storage Bucket Provisioning ($1.00 USDC)',
    );
  }

  @Get('x402-verify')
  async getX402VerifyChallenge(@Request() req: any, @Res() res: any) {
    return this.sendX402VerifyChallenge(res);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Post('x402-verify')
  async verifyX402Purchase(
    @Request() req: any,
    @Res() res: any,
    @Body()
    body: {
      x402Payload?: any;
      planType?: string;
      durationMonths?: number;
      currency?: string;
      bucketName?: string;
    },
  ) {
    const x402Payload = this.x402Service.extractX402Payload(req, body);
    if (!x402Payload) {
      return this.sendX402VerifyChallenge(res);
    }

    const { planType, durationMonths, currency, bucketName } = body || {};
    // Only a token verified by OptionalJwtAuthGuard counts; decoding an unverified JWT here let anyone
    // attribute a purchase to another user's id. Anonymous buyers are identified by their paying wallet.
    const userId = req.user?.id || 'x402-public-user';

    const result = await this.purchasesService.verifyX402Purchase(
      userId,
      x402Payload,
      planType || '10gb',
      Number(durationMonths || 6),
      currency || 'USDC',
      undefined,
      undefined,
      bucketName,
    );

    return res.status(200).json(result);
  }

  @Get('x402-renew-by-wallet')
  async getX402RenewByWalletChallenge(@Res() res: any) {
    return this.sendX402VerifyChallenge(res);
  }

  @Get('paid-uploads/latest')
  async getLatestPaidUploads(
    @Query('network') network?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
    @Query('withTotal') withTotal?: string,
  ) {
    return this.purchasesService.getLatestPaidUploads(
      network,
      limit ? Number(limit) : 50,
      skip ? Number(skip) : 0,
      withTotal === 'true',
    );
  }

  @Get('latest')
  async getLatestPurchases(
    @Query('network') network?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
    @Query('withTotal') withTotal?: string,
  ) {
    return this.purchasesService.getLatestPurchases(
      network,
      limit ? Number(limit) : 50,
      skip ? Number(skip) : 0,
      withTotal === 'true',
    );
  }

  @Get('by-wallet')
  async getPurchasesWithoutWallet(
    @Query('network') network?: string,
    @Query('skip') skip?: string,
    @Query('limit') limit?: string,
    @Query('withTotal') withTotal?: string,
  ) {
    return this.purchasesService.getPurchasesByWallet('', network, skip ? Number(skip) : 0, limit ? Number(limit) : 50, withTotal === 'true');
  }

  @Get('by-wallet/:walletAddress')
  async getPurchasesByWallet(
    @Param('walletAddress') walletAddress: string,
    @Query('network') network?: string,
    @Query('skip') skip?: string,
    @Query('limit') limit?: string,
    @Query('withTotal') withTotal?: string,
  ) {
    return this.purchasesService.getPurchasesByWallet(walletAddress, network, skip ? Number(skip) : 0, limit ? Number(limit) : 50, withTotal === 'true');
  }

  @Get('paid-uploads/by-wallet')
  async getPaidUploadsWithoutWallet(
    @Query('network') network?: string,
    @Query('skip') skip?: string,
    @Query('limit') limit?: string,
    @Query('withTotal') withTotal?: string,
  ) {
    return this.purchasesService.getPaidUploadsByWallet('', network, skip ? Number(skip) : 0, limit ? Number(limit) : 50, withTotal === 'true');
  }

  @Get('paid-uploads/by-wallet/:walletAddress')
  async getPaidUploadsByWallet(
    @Param('walletAddress') walletAddress: string,
    @Query('network') network?: string,
    @Query('skip') skip?: string,
    @Query('limit') limit?: string,
    @Query('withTotal') withTotal?: string,
  ) {
    return this.purchasesService.getPaidUploadsByWallet(walletAddress, network, skip ? Number(skip) : 0, limit ? Number(limit) : 50, withTotal === 'true');
  }
}
