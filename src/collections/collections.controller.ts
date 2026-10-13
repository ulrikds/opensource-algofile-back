import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  UploadedFile,
  Request,
  Patch,
  Delete,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { FilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { CollectionsService } from './collections.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SkipThrottle } from '@nestjs/throttler';

@SkipThrottle()
@Controller('collections')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async list(@Request() req) {
    return this.collectionsService.listCollections(req.user.id);
  }

  @Get('transactions')
  async getMintTransactions(
    @Query('sender') sender?: string,
    @Query('txId') txId?: string,
    @Query('network') network?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
    @Query('withTotal') withTotal?: string,
  ) {
    return this.collectionsService.getMintTransactions({
      sender,
      txId,
      network,
      limit: limit ? Number(limit) : 50,
      skip: skip ? Number(skip) : 0,
      withTotal: withTotal === 'true',
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async getOne(@Request() req, @Param('id') id: string) {
    return this.collectionsService.findCollectionById(id, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('provision-bundle-bucket')
  async provisionBundleBucket(
    @Request() req,
    @Body('paymentTxId') paymentTxId: string,
    @Body('totalGb') totalGb: number,
    @Body('durationMonths') durationMonths: number,
    @Body('mintType') mintType?: string,
  ) {
    if (!paymentTxId || !totalGb || !durationMonths) {
      throw new Error('paymentTxId, totalGb, and durationMonths are required');
    }
    return this.collectionsService.provisionBundleBucket(
      req.user.id,
      paymentTxId,
      totalGb,
      Number(durationMonths),
      mintType,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('upload-asset')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }),
  )
  async uploadAsset(
    @Request() req,
    @Body('bucketName') bucketName: string,
    @Body('collectionName') collectionName: string,
    @Body('metadata') metadata: string,
    @UploadedFile() file: any,
    @Body('metadataStandard') metadataStandard?: string,
  ) {
    if (!file || !bucketName || !collectionName) {
      throw new Error('file, bucketName, and collectionName are required');
    }
    const parsedMeta = metadata ? JSON.parse(metadata) : {};
    return this.collectionsService.uploadSingleAsset(
      req.user.id,
      req.user.email,
      bucketName,
      collectionName,
      file,
      parsedMeta,
      metadataStandard,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('presigned-url')
  async getPresignedUrl(
    @Request() req,
    @Body('bucketName') bucketName: string,
    @Body('collectionName') collectionName: string,
    @Body('fileName') fileName: string,
    @Body('contentType') contentType: string,
  ) {
    if (!bucketName || !collectionName || !fileName || !contentType) {
      throw new BadRequestException(
        'bucketName, collectionName, fileName, and contentType are required',
      );
    }
    return this.collectionsService.generatePresignedUrl(
      req.user.id,
      req.user.email,
      bucketName,
      collectionName,
      fileName,
      contentType,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('register-asset')
  async registerAsset(
    @Request() req,
    @Body('bucketName') bucketName: string,
    @Body('collectionName') collectionName: string,
    @Body('imageKey') imageKey: string,
    @Body('imageHash') imageHash: string,
    @Body('fileName') fileName: string,
    @Body('mimeType') mimeType: string,
    @Body('metadata') metadata: any,
    @Body('metadataStandard') metadataStandard?: string,
    @Body('imageCid') imageCid?: string,
  ) {
    if (
      !bucketName ||
      !collectionName ||
      !imageKey ||
      !imageHash ||
      !fileName ||
      !mimeType
    ) {
      throw new BadRequestException(
        'bucketName, collectionName, imageKey, imageHash, fileName, and mimeType are required',
      );
    }
    const parsedMeta =
      typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    return this.collectionsService.registerUploadedAsset(
      req.user.id,
      req.user.email,
      bucketName,
      collectionName,
      imageKey,
      imageHash,
      fileName,
      mimeType,
      parsedMeta,
      metadataStandard,
      imageCid,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('presigned-urls-bulk')
  async generatePresignedUrlsBulk(
    @Request() req,
    @Body('bucketName') bucketName: string,
    @Body('collectionName') collectionName: string,
    @Body('items') items: Array<{ fileName: string; contentType?: string }>,
  ) {
    if (!bucketName || !collectionName || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestException(
        'bucketName, collectionName, and a non-empty items array are required',
      );
    }
    return this.collectionsService.generatePresignedUrlsBulk(
      req.user.id,
      req.user.email,
      bucketName,
      collectionName,
      items,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('register-assets-bulk')
  async registerAssetsBulk(
    @Request() req,
    @Body('collectionId') collectionId: string,
    @Body('bucketName') bucketName: string,
    @Body('collectionName') collectionName: string,
    @Body('items')
    items: Array<{
      imageKey: string;
      imageHash: string;
      fileName: string;
      mimeType: string;
      metadata: any;
      imageCid?: string;
    }>,
    @Body('metadataStandard') metadataStandard?: string,
    @Body('sendNumber') sendNumber?: number,
    @Body('sendLabel') sendLabel?: string,
  ) {
    if (
      !collectionId ||
      !bucketName ||
      !collectionName ||
      !Array.isArray(items) ||
      items.length === 0
    ) {
      throw new BadRequestException(
        'collectionId, bucketName, collectionName, and a non-empty items array are required',
      );
    }
    return this.collectionsService.registerUploadedAssetsBulk(
      req.user.id,
      req.user.email,
      collectionId,
      bucketName,
      collectionName,
      items,
      metadataStandard,
      sendNumber ? Number(sendNumber) : undefined,
      sendLabel,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('verify-metadata-bulk')
  async verifyMetadataBulk(@Body('items') items: Array<any>) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('A non-empty items array is required');
    }
    return this.collectionsService.verifyMetadataBulk(items);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  @UseInterceptors(
    FilesInterceptor('files', undefined, {
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async create(
    @Request() req,
    @Body('bucketName') bucketName: string,
    @Body('name') name: string,
    @Body('description') description: string,
    @Body('metadata') metadata: string,
    @Body('metadataStandard') metadataStandard: string,
    @Body('assets') assets?: string,
    @Body('uploadInterrupted') uploadInterrupted?: any,
    @Body('isSingleAsset') isSingleAsset?: any,
    @UploadedFiles() files?: any[],
  ) {
    if (!bucketName || !name) {
      throw new Error('Bucket name and Collection name are required');
    }
    const parsedAssets = assets ? JSON.parse(assets) : undefined;
    const isInterrupted =
      uploadInterrupted === 'true' || uploadInterrupted === true;
    const isSingle = isSingleAsset === 'true' || isSingleAsset === true;
    return this.collectionsService.createCollection(
      req.user.id,
      req.user.email,
      bucketName,
      name,
      description,
      files || [],
      metadata,
      metadataStandard,
      parsedAssets,
      isInterrupted,
      isSingle,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('bundle')
  @UseInterceptors(
    FilesInterceptor('files', undefined, {
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async createBundle(
    @Request() req,
    @Body('name') name: string,
    @Body('description') description: string,
    @Body('metadata') metadata: string,
    @Body('metadataStandard') metadataStandard: string,
    @Body('paymentTxId') paymentTxId: string,
    @Body('planType') planType: string,
    @Body('durationMonths') durationMonths: string,
    @Body('assets') assets?: string,
    @UploadedFiles() files?: any[],
  ) {
    if (!name || !paymentTxId || !planType || !durationMonths) {
      throw new Error(
        'Collection name, paymentTxId, planType, and durationMonths are required',
      );
    }
    const parsedAssets = assets ? JSON.parse(assets) : undefined;
    return this.collectionsService.createCollectionWithBundle(
      req.user.id,
      req.user.email,
      paymentTxId,
      planType,
      Number(durationMonths),
      name,
      description,
      files || [],
      metadata,
      metadataStandard,
      parsedAssets,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/mint')
  async updateMintedAssets(
    @Request() req,
    @Param('id') id: string,
    @Body('minted')
    minted: Array<{ imageCid: string; assetId: number; txId?: string }>,
    @Body('txIds') txIds?: string[],
    @Body('sender') sender?: string,
    @Body('network') network?: string,
  ) {
    if (!minted || !Array.isArray(minted)) {
      throw new Error('Minted assets list must be provided as an array');
    }
    return this.collectionsService.updateMintedAssets(
      id,
      req.user.id,
      minted,
      txIds,
      sender,
      network,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('initialize')
  async initialize(
    @Request() req,
    @Body('bucketName') bucketName: string,
    @Body('name') name: string,
    @Body('description') description: string,
    @Body('metadataStandard') metadataStandard: string,
  ) {
    if (!bucketName || !name) {
      throw new Error('bucketName and name are required');
    }
    return this.collectionsService.initializeCollection(
      req.user.id,
      bucketName,
      name,
      description,
      metadataStandard,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/add-asset')
  async addAsset(
    @Request() req,
    @Param('id') id: string,
    @Body('asset') asset: any,
  ) {
    if (!asset) {
      throw new Error('asset object is required');
    }
    return this.collectionsService.addAssetToCollection(id, req.user.id, asset);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/finalize')
  async finalize(@Request() req, @Param('id') id: string) {
    return this.collectionsService.finalizeCollection(id, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('update-metadata-bulk')
  async updateMetadataBulk(
    @Request() req,
    @Body('collectionId') collectionId: string,
    @Body('sendNumber') sendNumber?: number,
    @Body('items') items?: Array<{ fileName: string; metadata: any }>,
  ) {
    if (!collectionId || !items || !Array.isArray(items)) {
      throw new BadRequestException('collectionId and items array are required');
    }
    return this.collectionsService.updateMetadataBulk(
      req.user.id,
      collectionId,
      sendNumber ? Number(sendNumber) : null,
      items,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async delete(@Request() req, @Param('id') id: string) {
    return this.collectionsService.deleteCollection(id, req.user.id);
  }
}
