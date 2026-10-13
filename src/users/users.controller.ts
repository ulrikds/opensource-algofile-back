import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  UseGuards,
  Request,
  BadRequestException,
  Param,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ConfigService } from '@nestjs/config';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getProfile(@Request() req) {
    const user = await this.usersService.findById(req.user.id);
    const hasGlobalKeys = !!(
      this.configService.get<string>('FILEBASE_ACCESS_KEY_ID') &&
      this.configService.get<string>('FILEBASE_SECRET_ACCESS_KEY')
    );
    const hasIpfsRpc = !!(
      this.configService.get<string>('FILEBASE_IPFS_RPC_ENDPOINT') &&
      this.configService.get<string>('FILEBASE_IPFS_RPC_TOKEN')
    );
    return {
      id: user._id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role || 'user',
      hasFilebaseCredentials: hasGlobalKeys,
      hasIpfsRpcToken: hasIpfsRpc,
      storageLimitGb: user.storageLimitGb,
      usedStorageBytes: user.usedStorageBytes,
      planType: user.planType,
      planExpiresAt: user.planExpiresAt,
      peraWalletAddress: user.peraWalletAddress,
      mintNetwork: user.mintNetwork || 'mainnet',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('mint-network')
  async updateMintNetwork(
    @Request() req,
    @Body() body: { mintNetwork: string },
  ) {
    const { mintNetwork } = body;
    if (mintNetwork !== 'mainnet' && mintNetwork !== 'testnet') {
      throw new BadRequestException('Network must be mainnet or testnet');
    }
    const user = await this.usersService.findById(req.user.id);
    user.mintNetwork = mintNetwork;
    await user.save();
    return { message: 'Mint network updated successfully', mintNetwork };
  }

  @UseGuards(JwtAuthGuard)
  @Post('credentials')
  async saveCredentials(
    @Request() req,
    @Body() body: { accessKey: string; secretKey: string },
  ) {
    const { accessKey, secretKey } = body;
    if (!accessKey || !secretKey) {
      throw new Error('Access Key and Secret Key are required');
    }
    await this.usersService.saveFilebaseCredentials(
      req.user.id,
      accessKey,
      secretKey,
    );
    return { message: 'Filebase credentials saved successfully' };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('credentials')
  async deleteCredentials(@Request() req) {
    await this.usersService.clearFilebaseCredentials(req.user.id);
    return { message: 'Filebase credentials removed successfully' };
  }

  @UseGuards(JwtAuthGuard)
  @Post('reset-plan')
  async resetPlan(@Request() req) {
    const user = await this.usersService.findById(req.user.id);
    user.planType = 'free';
    user.storageLimitGb = 1;
    user.planExpiresAt = null;
    user.usedStorageBytes = 0;
    await user.save();
    return {
      message: 'Plan successfully reset to Free Sandbox Tier.',
      user: {
        id: user._id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        storageLimitGb: user.storageLimitGb,
        usedStorageBytes: user.usedStorageBytes,
        planType: user.planType,
        planExpiresAt: user.planExpiresAt,
        peraWalletAddress: user.peraWalletAddress,
      },
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('api-keys')
  async createApiKey(
    @Request() req,
    @Body()
    body: {
      name: string;
      bucketId: string;
      isPaid?: boolean;
      customFeeUsd?: number;
      paymentCurrency?: string;
    },
  ) {
    const { name, bucketId, isPaid, customFeeUsd, paymentCurrency } = body;
    if (!name || !bucketId) {
      throw new BadRequestException('API Key name and bucketId are required');
    }
    const user = await this.usersService.findById(req.user.id);
    if (isPaid && user.role !== 'admin') {
      throw new BadRequestException(
        'Apenas administradores podem criar chaves de API pagas.',
      );
    }
    const result = await this.usersService.createApiKey(
      req.user.id,
      name,
      bucketId,
      isPaid,
      customFeeUsd,
      paymentCurrency,
    );
    return {
      message: 'API Key generated successfully',
      rawKey: result.rawKey,
      key: {
        id: result.keyRecord._id,
        name: result.keyRecord.name,
        prefix: result.keyRecord.prefix,
        isPaid: result.keyRecord.isPaid,
        customFeeUsd: result.keyRecord.customFeeUsd,
        paymentCurrency: result.keyRecord.paymentCurrency,
        createdAt: (result.keyRecord as any).createdAt,
        bucket: result.keyRecord.bucket
          ? {
              id: (result.keyRecord.bucket as any)._id,
              name: (result.keyRecord.bucket as any).name,
            }
          : null,
      },
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('api-keys')
  async listApiKeys(@Request() req) {
    const keys = await this.usersService.listApiKeys(req.user.id);
    return keys.map((k) => ({
      id: k._id,
      name: k.name,
      prefix: k.prefix,
      isPaid: k.isPaid,
      customFeeUsd: k.customFeeUsd,
      paymentCurrency: k.paymentCurrency,
      createdAt: (k as any).createdAt,
      lastUsedAt: k.lastUsedAt,
      bucket: k.bucket
        ? {
            id: (k.bucket as any)._id,
            name: (k.bucket as any).name,
          }
        : null,
    }));
  }

  @UseGuards(JwtAuthGuard)
  @Delete('api-keys/:id')
  async revokeApiKey(@Request() req, @Param('id') id: string) {
    if (!id) {
      throw new BadRequestException('API Key ID is required');
    }
    await this.usersService.revokeApiKey(req.user.id, id);
    return { message: 'API Key revoked successfully' };
  }

  @UseGuards(JwtAuthGuard)
  @Get('admin/stats')
  async getAdminStats(@Request() req) {
    const user = await this.usersService.findById(req.user.id);
    if (user.role !== 'admin') {
      throw new BadRequestException('Acesso negado: Apenas administradores.');
    }
    return this.usersService.getAdminStats();
  }

  @Get('public/stats')
  async getPublicStats() {
    return this.usersService.getPublicStats();
  }

  @UseGuards(JwtAuthGuard)
  @Post('role')
  async changeRole(@Request() req, @Body() body: { role: 'user' | 'admin' }) {
    const { role } = body;
    if (role !== 'user' && role !== 'admin') {
      throw new BadRequestException('Role must be user or admin');
    }
    const caller = await this.usersService.findById(req.user.id);
    if (caller.role !== 'admin') {
      throw new BadRequestException(
        'Acesso negado: Apenas administradores podem alterar funções.',
      );
    }
    const user = await this.usersService.findById(req.user.id);
    user.role = role;
    await user.save();
    return { message: `Role updated successfully to ${role}`, role: user.role };
  }
}
