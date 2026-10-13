import {
  Controller,
  Get,
  Post,
  UseGuards,
  Request,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  UnauthorizedException,
  HttpException,
  Res,
  Body,
} from '@nestjs/common';
import * as express from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { FilebaseService } from './filebase.service';
import { AcceptsPaidKeys, ApiKeyGuard } from '../auth/guards/api-key.guard';
import { PurchasesService } from '../purchases/purchases.service';
import { X402Service } from '../x402/x402.service';
import { ProjectMetadataResolver } from '../x402/project-metadata.resolver';
import { ConfigService } from '@nestjs/config';

const MAX_BULK_ITEMS = 4000;

@Controller(['v3/filebase', 'v3/algofile', 'filebase', 'algofile'])
export class ExternalFilebaseController {
  constructor(
    private readonly filebaseService: FilebaseService,
    private readonly purchasesService: PurchasesService,
    private readonly x402Service: X402Service,
    private readonly configService: ConfigService,
  ) {}

  @Get('pin')
  @Get('pin/bulk')
  @Get('buckets/:name/upload')
  @Get('buckets/:name/presigned-url')
  @Get('buckets/:name/presigned-urls-bulk')
  @Get('buckets/:name/confirm-upload')
  @Get('upload/bulk-presigned')
  @Get('upload/confirm-bulk')
  @Get('buckets/:name/multipart/create')
  @Get('buckets/:name/multipart/upload-part')
  @Get('buckets/:name/multipart/complete')
  @Get('buckets/:name/multipart/abort')
  async getFilebasePostRoutesChallenge(@Request() req: any, @Res() res: any) {
    const reqUrl = (req.originalUrl || req.url || '/api/v3/filebase/upload').toString();
    const requirements = this.x402Service.createRequirements({
      url: reqUrl,
      amount: '1000',
    });

    const bazaarExtension = ProjectMetadataResolver.buildBazaarExtension({
      method: 'GET',
      input: {},
      output: { success: true, cid: 'bafkreic...' },
    });

    return this.x402Service.send402Response(
      res,
      requirements,
      bazaarExtension,
      'Payment Required for AlgoFile Decentralized Storage ($0.001 USDC)',
    );
  }

  @UseGuards(ApiKeyGuard)
  @AcceptsPaidKeys()
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }),
  )
  async apiUpload(
    @Request() req,
    @UploadedFile() file: any,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided under the field "file"');
    }
    const targetBucketName = req.user.apiKeyBucket;
    if (!targetBucketName) {
      throw new BadRequestException('No storage bucket bound to this API Key');
    }

    const apiKeyRecord = req.user.apiKeyRecord;
    const network = (
      this.configService.get<string>('ALGORAND_NETWORK') || 'testnet'
    ).toLowerCase();

    if (apiKeyRecord && apiKeyRecord.isPaid && network === 'testnet') {
      const isImage = file.mimetype && file.mimetype.startsWith('image/');
      const isJson = file.mimetype === 'application/json' || (file.originalname && file.originalname.endsWith('.json'));
      if (!isImage && !isJson) {
        throw new BadRequestException(
          'Upload blocked: Paid API keys on Testnet are restricted to image and JSON files only.',
        );
      }
      const maxSizeBytes = 10 * 1024 * 1024;
      if (file.buffer.length > maxSizeBytes) {
        throw new BadRequestException(
          'Upload blocked: Paid API keys on Testnet are restricted to a maximum size of 10MB.',
        );
      }
    }

    if (apiKeyRecord && apiKeyRecord.isPaid) {
      const fileSizeGb = file.buffer.length / (1024 * 1024 * 1024);
      const baseFee =
        apiKeyRecord.customFeeUsd !== undefined
          ? apiKeyRecord.customFeeUsd
          : 0.025;

      let ratePerGb = 0.4;
      if (
        apiKeyRecord.name === 'algofilerouteapi1y' ||
        apiKeyRecord.prefix === 'algofilerouteapi1y'
      ) {
        ratePerGb = 0.8;
      } else if (
        apiKeyRecord.name === 'algofilerouteapi2y' ||
        apiKeyRecord.prefix === 'algofilerouteapi2y'
      ) {
        ratePerGb = 1.6;
      } else if (
        apiKeyRecord.name === 'algofilerouteapi6m' ||
        apiKeyRecord.prefix === 'algofilerouteapi6m'
      ) {
        ratePerGb = 0.4;
      }

      const expectedPriceUsd = baseFee + fileSizeGb * ratePerGb;

      const currency = (
        apiKeyRecord.paymentCurrency ||
        (req.headers['x-preferred-currency'] as string) ||
        (req.query?.currency as string) ||
        'USDC'
      ).toUpperCase();

      const algoNetwork = this.purchasesService.getNetwork();
      const usdcAssetId = this.purchasesService.getUsdcAssetId();
      const receiverWallet = this.purchasesService.getReceiverWallet();

      let amountAtomic = Math.round(expectedPriceUsd * 1_000_000).toString();
      let assetId = usdcAssetId.toString();

      if (currency === 'ALGO') {
        const algoPrice = await this.purchasesService.getAlgoPriceUsd();
        const expectedAlgo = expectedPriceUsd / algoPrice;
        amountAtomic = Math.round(expectedAlgo * 1_000_000).toString();
        assetId = '0';
      }

      const caip2Network = this.x402Service.getCaip2Network(algoNetwork);
      const backendUrl =
        this.configService.get<string>('BACKEND_URL') || 'https://api.algofile.io';

      const requirements: any = this.x402Service.createRequirements({
        url: `${backendUrl}/api/v3/algofile/upload`,
        amount: amountAtomic,
        asset: assetId,
        payTo: receiverWallet,
        network: caip2Network,
        tag: 'x402-global-challenge',
        extra: {
          tag: 'x402-global-challenge',
          fileName: file.originalname,
          fileSizeGb,
          priceUsd: expectedPriceUsd,
          platform: 'AlgoFile Storage Network',
        },
      });

      const x402Payload = this.x402Service.extractX402Payload(req);

      if (!x402Payload) {
        const bazaarExtension = ProjectMetadataResolver.buildBazaarExtension({
          method: 'POST',
          bodyType: 'form-data',
          input: { file: '<binary>' },
          output: { success: true, cid: 'bafkreic...' },
        });

        this.x402Service.send402Response(
          res,
          requirements,
          bazaarExtension,
          `Payment Required: This API key is a Paid API Key. Uploader must pay $${Number(baseFee)} + $${ratePerGb.toFixed(2)}/GB to upload.`,
        );
        return;
      }

      const settleResult = await this.x402Service.verifyAndSettle(
        x402Payload,
        requirements,
      );
      const txId = settleResult.txId;

      const uploaderAddress =
        this.x402Service.extractSenderFromPayload(x402Payload) || 'x402_verified';

      const ownerId =
        apiKeyRecord.owner && apiKeyRecord.owner._id
          ? apiKeyRecord.owner._id.toString()
          : apiKeyRecord.owner
            ? apiKeyRecord.owner.toString()
            : '';
      const apiKeyId = apiKeyRecord._id
        ? apiKeyRecord._id.toString()
        : apiKeyRecord.toString();
      const bucketId =
        apiKeyRecord.bucket && apiKeyRecord.bucket._id
          ? apiKeyRecord.bucket._id.toString()
          : apiKeyRecord.bucket
            ? apiKeyRecord.bucket.toString()
            : '';

      let durationMonths: number | undefined = undefined;
      let mintType: string | undefined = undefined;

      const keyName = (apiKeyRecord.name || '').toLowerCase();
      const keyPrefix = (apiKeyRecord.prefix || '').toLowerCase();

      if (
        keyName === 'algofilerouteapi6m' ||
        keyPrefix === 'algofilerouteapi6m'
      ) {
        durationMonths = 6;
      } else if (
        keyName === 'algofilerouteapi1y' ||
        keyPrefix === 'algofilerouteapi1y'
      ) {
        durationMonths = 12;
      } else if (
        keyName === 'algofilerouteapi2y' ||
        keyPrefix === 'algofilerouteapi2y'
      ) {
        durationMonths = 24;
      } else if (
        keyName === 'algofilerouteapi' ||
        keyPrefix === 'algofilerouteapi'
      ) {
        durationMonths = 6;
      }

      mintType = 'asset';

      const projectUrl = (
        req.headers['origin'] ||
        req.headers['referer'] ||
        ''
      ).toString();

      await this.purchasesService.recordPaidUpload({
        ownerId,
        apiKeyId,
        bucketId,
        fileName: file.originalname,
        fileSizeGb,
        amountPaidUsd: expectedPriceUsd,
        currency,
        txId,
        uploaderAddress,
        network,
        durationMonths,
        mintType,
        projectUrl,
      });
    }

    const resolvedBucketName =
      apiKeyRecord && apiKeyRecord.isPaid && network === 'testnet'
        ? (
          this.configService.get<string>('BUCKET_FREE_NAME') ||
          'algofile-bucket-free'
        )
          .toLowerCase()
          .trim()
        : targetBucketName;

    return this.filebaseService.uploadFileViaApi(
      req.user.id,
      resolvedBucketName,
      file.originalname,
      file.buffer,
      file.mimetype,
    );
  }

  @UseGuards(ApiKeyGuard)
  @AcceptsPaidKeys()
  @Post('upload/bulk-presigned')
  async apiUploadBulkPresigned(
    @Request() req,
    @Res({ passthrough: true }) res: express.Response,
    @Body()
    body: {
      items: Array<{
        fileName: string;
        sizeBytes: number;
        contentType?: string;
      }>;
      currency?: string;
    },
  ) {
    const apiKeyRecord = req.user?.apiKeyRecord;
    if (!apiKeyRecord) {
      throw new UnauthorizedException('API key context missing');
    }

    const items = body?.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException(
        'items array is required and must contain at least 1 item ({ fileName, sizeBytes, contentType })',
      );
    }
    if (items.length > MAX_BULK_ITEMS) {
      throw new BadRequestException(`At most ${MAX_BULK_ITEMS} items per request`);
    }

    for (const item of items) {
      if (!item.fileName || typeof item.fileName !== 'string') {
        throw new BadRequestException('Each item must have a valid fileName string.');
      }
      if (!Number.isInteger(item.sizeBytes) || item.sizeBytes <= 0) {
        throw new BadRequestException(
          `Item '${item.fileName}' must have a positive sizeBytes number.`,
        );
      }
    }

    const network = (
      this.configService.get<string>('ALGORAND_NETWORK') || 'testnet'
    ).toLowerCase();

    if (apiKeyRecord && apiKeyRecord.isPaid && network === 'testnet') {
      for (const item of items) {
        const isImage = item.contentType && item.contentType.startsWith('image/');
        const isJson = item.contentType === 'application/json' || (item.fileName && item.fileName.endsWith('.json'));
        if (!isImage && !isJson) {
          throw new BadRequestException(
            `Upload blocked: Paid API keys on Testnet are restricted to image and JSON files (${item.fileName}).`,
          );
        }
        const maxSizeBytes = 10 * 1024 * 1024;
        if (item.sizeBytes > maxSizeBytes) {
          throw new BadRequestException(
            `Upload blocked: Paid API keys on Testnet are restricted to 10MB per file (${item.fileName}).`,
          );
        }
      }
    }

    const totalSizeBytes = items.reduce((acc, i) => acc + i.sizeBytes, 0);
    const totalSizeGb = totalSizeBytes / (1024 * 1024 * 1024);

    let expectedPriceUsd = 0;
    let currency = 'USDC';
    let amountAtomic = '0';
    let assetId = '0';
    let receiverWallet = '';
    let caip2Network = 'algorand:testnet';

    if (apiKeyRecord && apiKeyRecord.isPaid) {
      const baseFee =
        apiKeyRecord.customFeeUsd !== undefined
          ? apiKeyRecord.customFeeUsd
          : 0.025;

      let ratePerGb = 0.4;
      const keyName = (apiKeyRecord.name || '').toLowerCase();
      const keyPrefix = (apiKeyRecord.prefix || '').toLowerCase();

      if (
        keyName === 'algofilerouteapi1y' ||
        keyPrefix === 'algofilerouteapi1y'
      ) {
        ratePerGb = 0.8;
      } else if (
        keyName === 'algofilerouteapi2y' ||
        keyPrefix === 'algofilerouteapi2y'
      ) {
        ratePerGb = 1.6;
      } else if (
        keyName === 'algofilerouteapi6m' ||
        keyPrefix === 'algofilerouteapi6m'
      ) {
        ratePerGb = 0.4;
      }

      expectedPriceUsd = baseFee + totalSizeGb * ratePerGb;

      currency = (
        apiKeyRecord.paymentCurrency ||
        (req.headers['x-preferred-currency'] as string) ||
        (req.query?.currency as string) ||
        body?.currency ||
        'USDC'
      ).toUpperCase();

      const algoNetwork = this.purchasesService.getNetwork();
      const usdcAssetId = this.purchasesService.getUsdcAssetId();
      receiverWallet = this.purchasesService.getReceiverWallet();

      amountAtomic = Math.round(expectedPriceUsd * 1_000_000).toString();
      assetId = usdcAssetId.toString();

      if (currency === 'ALGO') {
        const algoPrice = await this.purchasesService.getAlgoPriceUsd();
        const expectedAlgo = expectedPriceUsd / algoPrice;
        amountAtomic = Math.round(expectedAlgo * 1_000_000).toString();
        assetId = '0';
      }

      caip2Network = this.x402Service.getCaip2Network(algoNetwork);
      const backendUrl =
        this.configService.get<string>('BACKEND_URL') || 'https://api.algofile.io';

      const requirements: any = this.x402Service.createRequirements({
        url: `${backendUrl}/api/v3/algofile/upload-folder`,
        amount: amountAtomic,
        asset: assetId,
        payTo: receiverWallet,
        network: caip2Network,
        tag: 'x402-global-challenge',
        extra: {
          tag: 'x402-global-challenge',
          totalFiles: items.length,
          totalSizeBytes,
          totalSizeGb,
          priceUsd: expectedPriceUsd,
          platform: 'AlgoFile Storage Network',
        },
      });

      const x402Payload = this.x402Service.extractX402Payload(req);

      if (!x402Payload) {
        const bazaarExtension = ProjectMetadataResolver.buildBazaarExtension({
          method: 'POST',
          bodyType: 'json',
          input: { items: body?.items || [] },
          output: { success: true, items: [] },
        });

        this.x402Service.send402Response(
          res,
          requirements,
          bazaarExtension,
          `Payment Required: Bulk upload of ${items.length} file(s) (${totalSizeGb.toFixed(4)} GB) requires on-chain payment of $${expectedPriceUsd.toFixed(4)} USD.`,
        );
        return;
      }

      const settleResult = await this.x402Service.verifyAndSettle(
        x402Payload,
        requirements,
      );
      const txId = settleResult.txId;

      const uploaderAddress =
        this.x402Service.extractSenderFromPayload(x402Payload) || 'x402_verified';

      const ownerId =
        apiKeyRecord.owner && apiKeyRecord.owner._id
          ? apiKeyRecord.owner._id.toString()
          : apiKeyRecord.owner
            ? apiKeyRecord.owner.toString()
            : '';
      const apiKeyId = apiKeyRecord._id
        ? apiKeyRecord._id.toString()
        : apiKeyRecord.toString();
      const bucketId =
        apiKeyRecord.bucket && apiKeyRecord.bucket._id
          ? apiKeyRecord.bucket._id.toString()
          : apiKeyRecord.bucket
            ? apiKeyRecord.bucket.toString()
            : '';

      let durationMonths: number | undefined = undefined;
      let mintType: string | undefined = undefined;

      if (
        keyName === 'algofilerouteapi6m' ||
        keyPrefix === 'algofilerouteapi6m'
      ) {
        durationMonths = 6;
      } else if (
        keyName === 'algofilerouteapi1y' ||
        keyPrefix === 'algofilerouteapi1y'
      ) {
        durationMonths = 12;
      } else if (
        keyName === 'algofilerouteapi2y' ||
        keyPrefix === 'algofilerouteapi2y'
      ) {
        durationMonths = 24;
      } else if (
        keyName === 'algofilerouteapi' ||
        keyPrefix === 'algofilerouteapi'
      ) {
        durationMonths = 6;
      }

      mintType = 'folder';

      const projectUrl = (
        req.headers['origin'] ||
        req.headers['referer'] ||
        ''
      ).toString();

      await this.purchasesService.recordPaidUpload({
        ownerId,
        apiKeyId,
        bucketId,
        fileName: `Folder (${items.length} files)`,
        fileSizeGb: totalSizeGb,
        amountPaidUsd: expectedPriceUsd,
        currency,
        txId,
        uploaderAddress,
        network,
        durationMonths,
        mintType,
        projectUrl,
      });
    }

    const resolvedBucketName = this.resolveApiKeyBucket(req);

    // sizeBytes is what the caller paid for: it is signed into each URL, so S3 rejects bigger uploads.
    const presigned = await this.filebaseService.generateBucketPresignedUrlsBulk(
      req.user.id,
      resolvedBucketName,
      items.map(({ fileName, sizeBytes, contentType }) => ({ fileName, sizeBytes, contentType })),
    );
    return { bucketName: resolvedBucketName, items: presigned };
  }

  /**
   * Step 3 of the bulk flow: after the PUTs to the presigned URLs, resolves each file's CID
   * and registers the pins. Nothing is charged here; the files were paid for in bulk-presigned.
   */
  @UseGuards(ApiKeyGuard)
  @AcceptsPaidKeys()
  @Post('upload/confirm-bulk')
  async apiConfirmBulkUpload(
    @Request() req,
    @Body() body: { items: Array<{ key: string; originalName?: string; cid?: string }> },
  ) {
    const items = body?.items;
    if (!Array.isArray(items) || items.length === 0 || items.some((i) => !i?.key)) {
      throw new BadRequestException('items array with a key per item is required');
    }
    if (items.length > MAX_BULK_ITEMS) {
      throw new BadRequestException(`At most ${MAX_BULK_ITEMS} items per request`);
    }
    // The bucket always comes from the API key, never from the body.
    return this.filebaseService.confirmPublicBulkUpload(
      req.user.id,
      this.resolveApiKeyBucket(req),
      items,
    );
  }

  /** Paid keys on testnet write to the free bucket; everything else uses the key's own bucket. */
  private resolveApiKeyBucket(req: any): string {
    const apiKeyRecord = req.user?.apiKeyRecord;
    const network = (
      this.configService.get<string>('ALGORAND_NETWORK') || 'testnet'
    ).toLowerCase();
    if (apiKeyRecord?.isPaid && network === 'testnet') {
      return (
        this.configService.get<string>('BUCKET_FREE_NAME') || 'algofile-bucket-free'
      )
        .toLowerCase()
        .trim();
    }
    const targetBucketName = req.user?.apiKeyBucket;
    if (!targetBucketName) {
      throw new BadRequestException('No storage bucket bound to this API Key');
    }
    return targetBucketName;
  }
}
