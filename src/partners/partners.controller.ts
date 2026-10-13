import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { PartnersService } from './partners.service';
import { UsersService } from '../users/users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreatePartnerDto } from './dto/create-partner.dto';
import { UpdatePartnerDto } from './dto/update-partner.dto';

@Controller('partners')
export class PartnersController {
  constructor(
    private readonly partnersService: PartnersService,
    private readonly usersService: UsersService,
  ) {}

  private async assertAdmin(userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user || user.role !== 'admin') {
      throw new ForbiddenException('Access denied: Only administrators can manage partners.');
    }
  }

  // Public endpoint for home / explorer page carousel
  @Get()
  async getActivePartners() {
    return this.partnersService.findActive();
  }

  // Admin endpoint: list all partners (including inactive ones)
  @UseGuards(JwtAuthGuard)
  @Get('admin')
  async getAllPartners(@Req() req) {
    await this.assertAdmin(req.user.id);
    return this.partnersService.findAll();
  }

  // Admin endpoint: create a partner
  @UseGuards(JwtAuthGuard)
  @Post()
  async createPartner(@Req() req, @Body() body: CreatePartnerDto) {
    await this.assertAdmin(req.user.id);
    return this.partnersService.create(body);
  }

  // Admin endpoint: update a partner
  @UseGuards(JwtAuthGuard)
  @Put(':id')
  async updatePartner(
    @Req() req,
    @Param('id') id: string,
    @Body() body: UpdatePartnerDto,
  ) {
    await this.assertAdmin(req.user.id);
    return this.partnersService.update(id, body);
  }

  // Admin endpoint: delete a partner
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async deletePartner(@Req() req, @Param('id') id: string) {
    await this.assertAdmin(req.user.id);
    return this.partnersService.delete(id);
  }
}
