import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  Request,
  BadRequestException,
  Res,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { CollectionsService } from './collections.service';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { X402Service, ProjectMetadataResolver } from '../x402/x402.service';

@Controller(['v3/collections', 'collections'])
export class ExternalCollectionsController {
  constructor(
    private readonly collectionsService: CollectionsService,
    private readonly x402Service: X402Service,
  ) {}

  @Get('provision-bundle-bucket-x402')
  async getProvisionBundleBucketX402Challenge(@Res() res: any) {
    const requirements = this.x402Service.createRequirements({
      url: '/api/v3/collections/provision-bundle-bucket-x402',
      amount: '1000000',
    });

    const bazaarExtension = ProjectMetadataResolver.buildBazaarExtensionFor('bucketProvision', {
      method: 'POST',
      bodyType: 'json',
      input: { totalGb: 10, durationMonths: 6 },
      output: { bucketName: 'algofile-bucket' },
    });

    return this.x402Service.send402Response(
      res,
      requirements,
      bazaarExtension,
      'Payment Required for AlgoFile Storage Bucket Provisioning ($1.00 USDC)',
    );
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Post('provision-bundle-bucket-x402')
  async provisionBundleBucketX402(
    @Request() req,
    @Body('x402Payload') x402Payload: any,
    @Body('totalGb') totalGb: number,
    @Body('durationMonths') durationMonths: number,
    @Body('mintType') mintType?: string,
    @Body('projectName') projectName?: string,
    @Body('projectDescription') projectDescription?: string,
    @Body('projectIcon') projectIcon?: string,
  ) {
    if (!x402Payload || totalGb === undefined || !durationMonths) {
      throw new BadRequestException('x402Payload, totalGb, and durationMonths are required');
    }
    // Only a token verified by OptionalJwtAuthGuard counts; decoding an unverified JWT here let anyone
    // attribute a purchase to another user's id. Anonymous buyers are identified by their paying wallet.
    const userId = req.user?.id || 'x402-public-user';
    return this.collectionsService.provisionBundleBucketX402(
      userId,
      x402Payload,
      totalGb,
      Number(durationMonths),
      mintType,
      projectName,
      projectDescription,
      projectIcon,
    );
  }

  private sendCollectionUploadChallenge(res: any, urlPath: string) {
    const requirements = this.x402Service.createRequirements({
      url: urlPath,
      amount: '1000',
    });

    const bazaarExtension = ProjectMetadataResolver.buildBazaarExtension({
      method: 'POST',
      bodyType: 'form-data',
      input: {},
      output: { success: true, collectionId: 'col_123' },
    });

    return this.x402Service.send402Response(
      res,
      requirements,
      bazaarExtension,
      'Payment Required for AlgoFile Collection Upload ($0.001 USDC)',
    );
  }

  @Get('upload-collection')
  async getUploadCollectionX402Challenge(@Res() res: any) {
    return this.sendCollectionUploadChallenge(res, '/api/v3/collections/upload-collection');
  }

  @UseGuards(ApiKeyGuard)
  @Post('upload-collection')
  @UseInterceptors(
    FilesInterceptor('files', 4000, {
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async apiUploadCollection(
    @Request() req,
    @Body('name') name: string,
    @Body('description') description: string,
    @Body('metadataStandard') metadataStandard?: string,
    @Body('collectionId') collectionId?: string,
    @Body('sendNumber') sendNumber?: string,
    @Body('sendLabel') sendLabel?: string,
    @UploadedFiles() files?: any[],
  ) {
    const allFiles = files || [];

    const imageFiles = allFiles.filter(
      (f) =>
        f.mimetype.startsWith('image/') ||
        /\.(png|jpe?g|gif|webp|svg)$/i.test(f.originalname),
    );
    const jsonFiles = allFiles.filter(
      (f) =>
        f.mimetype === 'application/json' ||
        f.originalname.endsWith('.json'),
    );

    if (imageFiles.length > 2000 || jsonFiles.length > 2000) {
      throw new BadRequestException(
        'Upload limit exceeded: Maximum 2000 images and 2000 JSON metadata files allowed per batch.',
      );
    }

    if (imageFiles.length === 0) {
      throw new BadRequestException('At least one image file must be uploaded.');
    }

    const parsedMetadata = new Map<string, any>();
    for (const jsonFile of jsonFiles) {
      try {
        const text = jsonFile.buffer.toString('utf-8');
        const json = JSON.parse(text);
        const namePrefix = jsonFile.originalname
          .replace(/\.[^/.]+$/, '')
          .toLowerCase();
        parsedMetadata.set(namePrefix, json);
      } catch (err) {
        throw new BadRequestException(
          `Failed to parse JSON file ${jsonFile.originalname}: ${err.message}`,
        );
      }
    }

    const metadataArray: any[] = [];
    for (const imgFile of imageFiles) {
      const namePrefix = imgFile.originalname
        .replace(/\.[^/.]+$/, '')
        .toLowerCase();
      const customMeta = parsedMetadata.get(namePrefix) || {};

      const traits: Record<string, any> = {};

      if (customMeta.properties?.traits && typeof customMeta.properties.traits === 'object') {
        Object.assign(traits, customMeta.properties.traits);
      } else if (customMeta.traits && typeof customMeta.traits === 'object' && !Array.isArray(customMeta.traits)) {
        Object.assign(traits, customMeta.traits);
      }

      const assetAttributes = customMeta.attributes || customMeta.traits;
      if (Array.isArray(assetAttributes)) {
        for (const attr of assetAttributes) {
          if (attr && typeof attr === 'object') {
            const traitType = attr.trait_type || attr.traitType || attr.name || attr.key;
            const traitValue = attr.value;
            if (traitType && traitValue !== undefined) {
              traits[traitType] = traitValue;
            }
          }
        }
      }

      const existingProperties = typeof customMeta.properties === 'object' && customMeta.properties ? customMeta.properties : {};

      const metaObj = {
        ...customMeta,
        name: customMeta.name || imgFile.originalname.replace(/\.[^/.]+$/, ''),
        description: customMeta.description || `Asset of ${name || 'API Collection'}`,
        properties: {
          ...existingProperties,
          traits: Object.keys(traits).length > 0 ? traits : existingProperties.traits || {},
        },
      };

      delete metaObj.attributes;
      delete metaObj.traits;

      metadataArray.push(metaObj);
    }

    const bucketName = req.user.apiKeyBucket;
    if (!bucketName) {
      throw new BadRequestException('No storage bucket bound to this API Key');
    }

    const collectionName = name || 'API Collection';
    const collectionDesc = description || '';
    const standard = metadataStandard || 'arc19';
    const parsedSendNumber = sendNumber ? Number(sendNumber) : undefined;

    return this.collectionsService.createCollection(
      req.user.id,
      req.user.email,
      bucketName,
      collectionName,
      collectionDesc,
      imageFiles,
      JSON.stringify(metadataArray),
      standard,
      undefined,
      undefined,
      undefined,
      collectionId,
      parsedSendNumber,
      sendLabel,
    );
  }

  @Get('transfer-asset-ids')
  async getTransferAssetIdsX402Challenge(@Res() res: any) {
    return this.sendCollectionUploadChallenge(res, '/api/v3/collections/transfer-asset-ids');
  }

  @UseGuards(ApiKeyGuard)
  @Post('transfer-asset-ids')
  async apiTransferAssetIds(
    @Request() req,
    @Body('oldCollectionId') oldCollectionId?: string,
    @Body('oldCollectionName') oldCollectionName?: string,
    @Body('newCollectionId') newCollectionId?: string,
    @Body('newCollectionName') newCollectionName?: string,
    @Body('matchBy') matchBy?: 'name' | 'index',
    @Body('customMappings')
    customMappings?: Array<{
      name?: string;
      oldAssetId?: number;
      newAssetId?: number;
    }>,
    @Body('unmintOld') unmintOld?: boolean,
    @Body('mnemonic') mnemonic?: string,
    @Body('network') network?: 'mainnet' | 'testnet',
  ) {
    return this.collectionsService.transferAssetIds(req.user.id, {
      oldCollectionId,
      oldCollectionName,
      newCollectionId,
      newCollectionName,
      matchBy,
      customMappings,
      unmintOld: unmintOld !== false,
      mnemonic,
      network,
    });
  }
}
