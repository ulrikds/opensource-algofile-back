import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
  Res,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthService } from './auth.service';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import type { Response } from 'express';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  @Get('google')
  @UseGuards(GoogleAuthGuard)
  async googleAuth() {
    // Google OAuth initiates. The Guard automatically redirects to Google Consent screen.
  }

  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  async googleAuthRedirect(@Req() req, @Res() res: Response) {
    const { accessToken } = this.authService.generateJwt(req.user);
    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    return res.redirect(`${frontendUrl}/auth/callback?token=${accessToken}`);
  }

  @Get('dev-login')
  async devLogin(@Res() res: Response) {
    const isDev = this.configService.get<string>('NODE_ENV') === 'development';
    if (!isDev) {
      throw new ForbiddenException(
        'Developer login is disabled in production.',
      );
    }

    const user = await this.usersService.findOrCreateByGoogleId({
      googleId: 'dev-google-id-999',
      email: 'devuser@algofile.com',
      displayName: 'Dev User',
      avatarUrl: '',
    });

    // Auto-seed filebase credentials for testing if configured in env
    const accessKey = this.configService.get<string>('FILEBASE_ACCESS_KEY_ID');
    const secretKey = this.configService.get<string>(
      'FILEBASE_SECRET_ACCESS_KEY',
    );
    if (
      accessKey &&
      secretKey &&
      (!user.filebaseAccessKey || !user.filebaseSecretKey)
    ) {
      await this.usersService.saveFilebaseCredentials(
        user._id.toString(),
        accessKey,
        secretKey,
      );
    }

    const { accessToken } = this.authService.generateJwt(user);
    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    return res.redirect(`${frontendUrl}/auth/callback?token=${accessToken}`);
  }

  @UseGuards(JwtAuthGuard)
  @Get('admin/users')
  async getAdminUsers(@Req() req) {
    const caller = await this.usersService.findById(req.user.id);
    if (caller.role !== 'admin') {
      throw new ForbiddenException('Acesso negado: Apenas administradores.');
    }
    const users = await this.usersService.findAll();
    return users.map((user) => ({
      id: user._id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role,
    }));
  }

  @UseGuards(JwtAuthGuard)
  @Post('admin/impersonate')
  async impersonateUser(@Req() req, @Body() body: { userId: string }) {
    const caller = await this.usersService.findById(req.user.id);
    if (caller.role !== 'admin') {
      throw new ForbiddenException('Acesso negado: Apenas administradores.');
    }
    if (!body.userId) {
      throw new BadRequestException('ID do usuário é obrigatório.');
    }
    const targetUser = await this.usersService.findById(body.userId);
    const { accessToken } = this.authService.generateJwt(targetUser);
    return { token: accessToken };
  }
}
