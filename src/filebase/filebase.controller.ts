import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FilebaseService } from './filebase.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SkipThrottle, Throttle } from '@nestjs/throttler';

// Matches the 2,000 images + 2,000 JSON files a collection batch may carry.
const MAX_BULK_ITEMS = 4000;

@SkipThrottle()
@Controller(['filebase', 'algofile'])
export class FilebaseController {
  constructor(private readonly filebaseService: FilebaseService) {}

  @UseGuards(JwtAuthGuard)
  @Get('buckets')
  async listBuckets(@Request() req) {
    return this.filebaseService.listBuckets(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('admin/buckets-expiration')
  async listAdminBucketsExpiration(@Request() req) {
    return this.filebaseService.listBucketsForAdmin(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('admin/buckets-expiration/:id')
  async updateAdminBucketExpiration(
    @Request() req,
    @Param('id') id: string,
    @Body() body: { expiresAt: string | null },
  ) {
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    return this.filebaseService.updateBucketExpirationByAdmin(
      req.user.id,
      id,
      expiresAt,
    );
  }

  @Get('buckets/by-wallet')
  async findBucketsWithoutWallet() {
    return this.filebaseService.findBucketsByWallet('');
  }

  @Get('buckets/by-wallet/:walletAddress')
  async findBucketsByWallet(@Param('walletAddress') walletAddress: string) {
    return this.filebaseService.findBucketsByWallet(walletAddress);
  }

  @UseGuards(JwtAuthGuard)
  @Post('buckets')
  async createBucket(
    @Request() req,
    @Body() body: { name: string; maxSizeGb?: number },
  ) {
    const { name, maxSizeGb } = body;
    if (!name) {
      throw new Error('Bucket name is required');
    }
    return this.filebaseService.createBucket(req.user.id, name, maxSizeGb);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('buckets/rename')
  async renameBucket(
    @Request() req,
    @Body() body: { oldName: string; newName: string },
  ) {
    const { oldName, newName } = body;
    if (!oldName || !newName) {
      throw new Error('oldName and newName are required');
    }
    return this.filebaseService.renameBucket(req.user.id, oldName, newName);
  }

  @UseGuards(JwtAuthGuard)
  @Get('buckets/:name/files')
  async listBucketFiles(
    @Request() req,
    @Param('name') name: string,
    @Query('limit') limit?: string,
    @Query('next') next?: string,
    @Query('folder') folder?: string,
  ) {
    if (!name) {
      throw new Error('Bucket name is required');
    }
    const limitNum = limit ? Math.max(1, parseInt(limit, 10)) : 50;
    return this.filebaseService.listBucketFiles(
      req.user.id,
      name,
      limitNum,
      next,
      folder,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('buckets/:name/folders')
  async createFolder(
    @Request() req,
    @Param('name') name: string,
    @Body() body: { folderName: string; parentFolder?: string },
  ) {
    if (!name) {
      throw new BadRequestException('Bucket name is required');
    }
    if (!body?.folderName) {
      throw new BadRequestException('folderName is required');
    }
    return this.filebaseService.createFolder(
      req.user.id,
      name,
      body.folderName,
      body.parentFolder,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete('buckets/:name/folders')
  async deleteFolder(
    @Request() req,
    @Param('name') name: string,
    @Body() body: { folderPath: string },
    @Query('folderPath') queryFolderPath?: string,
  ) {
    if (!name) {
      throw new BadRequestException('Bucket name is required');
    }
    const folderPath = body?.folderPath || queryFolderPath;
    if (!folderPath) {
      throw new BadRequestException('folderPath is required');
    }
    return this.filebaseService.deleteFolder(req.user.id, name, folderPath);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('buckets/:name/files/single')
  async deleteSingleFile(
    @Request() req,
    @Param('name') name: string,
    @Query('key') key?: string,
    @Body() body?: { key?: string },
  ) {
    if (!name) {
      throw new BadRequestException('Bucket name is required');
    }
    const targetKey = key || body?.key;
    if (!targetKey) {
      throw new BadRequestException('File key is required');
    }
    return this.filebaseService.deleteSingleFile(req.user.id, name, targetKey);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('buckets/:name/files/move')
  async moveFile(
    @Request() req,
    @Param('name') name: string,
    @Body() body: { sourceKey: string; destFolder: string },
  ) {
    if (!name) {
      throw new BadRequestException('Bucket name is required');
    }
    if (!body?.sourceKey) {
      throw new BadRequestException('sourceKey is required');
    }
    return this.filebaseService.moveFile(
      req.user.id,
      name,
      body.sourceKey,
      body.destFolder,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch('buckets/:name/files/move-bulk')
  async moveFilesBulk(
    @Request() req,
    @Param('name') name: string,
    @Body() body: { sourceKeys: string[]; destFolder: string },
  ) {
    if (!name) {
      throw new BadRequestException('Bucket name is required');
    }
    if (!body?.sourceKeys || !Array.isArray(body.sourceKeys) || body.sourceKeys.length === 0) {
      throw new BadRequestException('sourceKeys array is required');
    }
    return this.filebaseService.moveFilesBulk(
      req.user.id,
      name,
      body.sourceKeys,
      body.destFolder,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete('buckets/:name/files/bulk')
  async deleteFilesBulk(
    @Request() req,
    @Param('name') name: string,
    @Body() body: { keys: string[] },
  ) {
    if (!name) {
      throw new BadRequestException('Bucket name is required');
    }
    if (!body?.keys || !Array.isArray(body.keys) || body.keys.length === 0) {
      throw new BadRequestException('keys array is required');
    }
    return this.filebaseService.deleteFilesBulk(req.user.id, name, body.keys);
  }

  // Routes below make the server download CIDs through our billed gateways, so they opt back into throttling.
  @UseGuards(JwtAuthGuard)
  @SkipThrottle({ default: false })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('pin')
  async pinCid(
    @Request() req,
    @Body() body: { bucketName: string; cid: string; name?: string; folder?: string },
  ) {
    const { bucketName, cid, name, folder } = body;
    if (!bucketName || !cid) {
      throw new BadRequestException('Bucket name and CID are required');
    }
    return this.filebaseService.pinCid(req.user.id, bucketName, cid, name, folder);
  }

  @UseGuards(JwtAuthGuard)
  @Get('pins/creator-folder')
  async getCreatorFolder(
    @Query('creatorAddress') creatorAddress: string,
    @Query('bucketName') bucketName?: string,
  ) {
    if (!creatorAddress) {
      throw new BadRequestException('Creator address is required');
    }
    return this.filebaseService.getCreatorFolder(creatorAddress, bucketName);
  }

  @UseGuards(JwtAuthGuard)
  @SkipThrottle({ default: false })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('pin/bulk')
  async pinCidsBulk(
    @Request() req,
    @Body()
    body: {
      bucketName: string;
      cids: string[];
      names?: string[];
      folder?: string;
      autoPinImages?: boolean;
      creatorAddress?: string;
    },
  ) {
    const { bucketName, cids, names, folder, autoPinImages, creatorAddress } = body;
    if (!bucketName || !cids || !Array.isArray(cids) || cids.length === 0) {
      throw new BadRequestException(
        'Bucket name and an array of CIDs are required',
      );
    }
    return this.filebaseService.pinCidsBulk(
      req.user.id,
      bucketName,
      cids,
      names,
      folder,
      autoPinImages,
      creatorAddress,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('pins/check-existing')
  async checkExistingCidsInProject(
    @Request() req,
    @Body() body: { cids: string[] },
  ) {
    if (!body?.cids || !Array.isArray(body.cids)) {
      throw new BadRequestException('cids array is required');
    }
    return this.filebaseService.checkExistingCidsInProject(body.cids);
  }

  @UseGuards(JwtAuthGuard)
  @SkipThrottle({ default: false })
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(['pins/resolve-metadata', 'assets/resolve-metadata'])
  async resolveAssetMetadataBulk(
    @Request() req,
    @Body() body: { cids: string[] },
  ) {
    if (!body?.cids || !Array.isArray(body.cids)) {
      throw new BadRequestException('cids array is required');
    }
    if (body.cids.length > 200) {
      throw new BadRequestException('At most 200 CIDs per request');
    }
    return this.filebaseService.resolveAssetMetadataBulk(body.cids);
  }

  @UseGuards(JwtAuthGuard)
  @Get('pins')
  async listPinnedCids(
    @Request() req,
    @Query('bucketName') bucketName?: string,
  ) {
    return this.filebaseService.listPinnedCids(req.user.id, bucketName);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('pins/:id')
  async unpinCid(@Request() req, @Param('id') id: string) {
    if (!id) {
      throw new BadRequestException('Pin ID is required');
    }
    return this.filebaseService.unpinCid(req.user.id, id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('buckets/:name')
  async deleteBucket(@Request() req, @Param('name') name: string) {
    if (!name) {
      throw new Error('Bucket name is required');
    }
    return this.filebaseService.deleteBucket(req.user.id, name);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('buckets/:name/files')
  async emptyBucket(@Request() req, @Param('name') name: string) {
    if (!name) {
      throw new Error('Bucket name is required');
    }
    return this.filebaseService.emptyBucket(req.user.id, name);
  }

  @UseGuards(JwtAuthGuard)
  @Post('buckets/:name/sync')
  async syncBucketStorage(@Request() req, @Param('name') name: string) {
    if (!name) {
      throw new BadRequestException('Bucket name is required');
    }
    return this.filebaseService.syncBucketStorage(req.user.id, name);
  }

  @UseGuards(JwtAuthGuard)
  @Post('buckets/:name/upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }),
  )
  async uploadFile(
    @Request() req,
    @Param('name') name: string,
    @UploadedFile() file: any,
    @Query('folder') folder?: string,
  ) {
    if (!name) {
      throw new BadRequestException('Bucket name is required');
    }
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    return this.filebaseService.uploadFileViaApi(
      req.user.id,
      name,
      file.originalname,
      file.buffer,
      file.mimetype,
      folder,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('buckets/:name/presigned-url')
  async getBucketPresignedUrl(
    @Request() req,
    @Param('name') name: string,
    @Body()
    body: {
      fileName: string;
      contentType?: string;
      folder?: string;
      fileHash?: string;
      sizeBytes?: number;
    },
  ) {
    if (!name || !body?.fileName) {
      throw new BadRequestException('Bucket name and fileName are required');
    }
    return this.filebaseService.generateBucketPresignedUrl(
      req.user.id,
      name,
      body.fileName,
      body.contentType,
      body.folder,
      body.fileHash,
      body.sizeBytes,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('buckets/:name/presigned-urls-bulk')
  async getBucketPresignedUrlsBulk(
    @Request() req,
    @Param('name') name: string,
    @Body()
    body: {
      items: Array<{
        fileName: string;
        contentType?: string;
        fileHash?: string;
        sizeBytes?: number;
      }>;
      folder?: string;
    },
  ) {
    if (!name || !body?.items || !Array.isArray(body.items)) {
      throw new BadRequestException('Bucket name and items array are required');
    }
    if (body.items.length > MAX_BULK_ITEMS) {
      throw new BadRequestException(`At most ${MAX_BULK_ITEMS} items per request`);
    }
    return this.filebaseService.generateBucketPresignedUrlsBulk(
      req.user.id,
      name,
      body.items,
      body.folder,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('buckets/:name/confirm-upload')
  async confirmDirectUpload(
    @Request() req,
    @Param('name') name: string,
    @Body()
    body: {
      key: string;
      originalName?: string;
      cid?: string;
      sizeBytes?: number;
    },
  ) {
    if (!name || !body?.key) {
      throw new BadRequestException('Bucket name and key are required');
    }
    return this.filebaseService.confirmDirectUpload(
      req.user.id,
      name,
      body.key,
      body.originalName,
      body.cid,
      body.sizeBytes,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(['buckets/:name/confirm-uploads-bulk', 'buckets/:name/confirm-upload-bulk'])
  async confirmDirectUploadBulk(
    @Request() req,
    @Param('name') name: string,
    @Body()
    body: {
      items: Array<{
        key: string;
        originalName?: string;
        cid?: string;
        sizeBytes?: number;
      }>;
    },
  ) {
    if (!name || !body?.items || !Array.isArray(body.items)) {
      throw new BadRequestException('Bucket name and items array are required');
    }
    if (body.items.length > MAX_BULK_ITEMS) {
      throw new BadRequestException(`At most ${MAX_BULK_ITEMS} items per request`);
    }
    return this.filebaseService.confirmDirectUploadsBulk(req.user.id, name, body.items);
  }
}
