import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Request,
  Query,
  Res,
} from '@nestjs/common';
import { PurchasesService } from './purchases.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { X402Service } from '../x402/x402.service';
import { ProjectMetadataResolver } from '../x402/project-metadata.resolver';

@Controller(['v3/purchases', 'purchases'])
export class PurchasesController {
  constructor(
    private readonly purchasesService: PurchasesService,
    private readonly x402Service: X402Service,
  ) {}

  @Get('prices')
  async getPrices() {
    return this.purchasesService.getPlanPrices();
  }

  private sendX402VerifyChallenge(res: any) {
    const requirements = this.x402Service.createRequirements({
      url: '/api/v3/purchases/x402-verify',
      amount: '1000000',
    });

    const bazaarExtension = ProjectMetadataResolver.buildBazaarExtensionFor('verifyPurchase', {
      method: 'GET',
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

  @Get('verify')
  async getVerifyChallenge(@Res() res: any) {
    return this.sendX402VerifyChallenge(res);
  }

  @UseGuards(JwtAuthGuard)
  @Post('verify')
  async verifyPurchase(
    @Request() req,
    @Body()
    body: {
      txId: string;
      planType: string;
      durationMonths: number;
      bucketName?: string;
    },
  ) {
    const { txId, planType, durationMonths, bucketName } = body;
    if (!txId || !planType || !durationMonths) {
      throw new Error('txId, planType, and durationMonths are required');
    }
    return this.purchasesService.verifyPurchase(
      req.user.id,
      txId,
      planType,
      Number(durationMonths),
      undefined,
      undefined,
      bucketName,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('x402-renew-by-wallet')
  async renewBucketByWallet(
    @Body()
    body: {
      walletAddress: string;
      proofTxn: string;
      x402Payload: any;
      bucketName: string;
      durationMonths: number;
      currency?: string;
    },
  ) {
    const {
      walletAddress,
      proofTxn,
      x402Payload,
      bucketName,
      durationMonths,
      currency,
    } = body;
    if (
      !walletAddress ||
      !proofTxn ||
      !x402Payload ||
      !bucketName ||
      !durationMonths
    ) {
      throw new Error(
        'walletAddress, proofTxn, x402Payload, bucketName, and durationMonths are required',
      );
    }
    return this.purchasesService.verifyWalletProofAndRenew(
      walletAddress,
      proofTxn,
      x402Payload,
      bucketName,
      Number(durationMonths),
      currency || 'USDC',
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('paid-uploads')
  async getPaidUploads(@Request() req) {
    return this.purchasesService.getPaidUploadsForUser(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('admin/api-key-usage')
  async getApiKeyUsageStats(@Request() req) {
    return this.purchasesService.getApiKeyUsageStats(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('admin/api-key-origins')
  async getApiKeyOriginLogs(
    @Request() req,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('isPublic') isPublic?: string,
    @Query('searchUrl') searchUrl?: string,
  ) {
    const isPublicBool =
      isPublic === 'true' ? true : isPublic === 'false' ? false : undefined;
    return this.purchasesService.getApiKeyOriginLogs({
      page,
      limit,
      isPublic: isPublicBool,
      searchUrl,
    });
  }
}
