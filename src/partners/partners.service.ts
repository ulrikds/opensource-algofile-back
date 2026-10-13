import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Partner, PartnerDocument } from './schemas/partner.schema';
import { CreatePartnerDto } from './dto/create-partner.dto';
import { UpdatePartnerDto } from './dto/update-partner.dto';

@Injectable()
export class PartnersService {
  constructor(
    @InjectModel(Partner.name)
    private readonly partnerModel: Model<PartnerDocument>,
  ) {}

  async findActive(): Promise<Partner[]> {
    return this.partnerModel
      .find({ isActive: true })
      .sort({ order: 1, createdAt: -1 })
      .exec();
  }

  async findAll(): Promise<Partner[]> {
    return this.partnerModel
      .find()
      .sort({ order: 1, createdAt: -1 })
      .exec();
  }

  async findById(id: string): Promise<Partner> {
    const partner = await this.partnerModel.findById(id).exec();
    if (!partner) {
      throw new NotFoundException(`Partner with ID ${id} not found.`);
    }
    return partner;
  }

  async create(dto: CreatePartnerDto): Promise<Partner> {
    if (!dto.name || !dto.cid || !dto.websiteUrl) {
      throw new BadRequestException('Partner name, IPFS CID, and website URL are required.');
    }

    // Clean CID string if user accidentally included gateway URL
    let cleanCid = dto.cid.trim();
    if (cleanCid.includes('/ipfs/')) {
      cleanCid = cleanCid.split('/ipfs/')[1].split('/')[0].split('?')[0].split('#')[0];
    } else if (cleanCid.startsWith('ipfs://')) {
      cleanCid = cleanCid.replace('ipfs://', '').split('/')[0];
    }

    const newPartner = new this.partnerModel({
      name: dto.name.trim(),
      cid: cleanCid,
      websiteUrl: dto.websiteUrl.trim(),
      order: typeof dto.order === 'number' ? dto.order : 0,
      isActive: dto.isActive !== undefined ? dto.isActive : true,
    });

    return newPartner.save();
  }

  async update(id: string, dto: UpdatePartnerDto): Promise<Partner> {
    const partner = await this.partnerModel.findById(id).exec();
    if (!partner) {
      throw new NotFoundException(`Partner with ID ${id} not found.`);
    }

    if (dto.name !== undefined) {
      partner.name = dto.name.trim();
    }
    if (dto.cid !== undefined) {
      let cleanCid = dto.cid.trim();
      if (cleanCid.includes('/ipfs/')) {
        cleanCid = cleanCid.split('/ipfs/')[1].split('/')[0].split('?')[0].split('#')[0];
      } else if (cleanCid.startsWith('ipfs://')) {
        cleanCid = cleanCid.replace('ipfs://', '').split('/')[0];
      }
      partner.cid = cleanCid;
    }
    if (dto.websiteUrl !== undefined) {
      partner.websiteUrl = dto.websiteUrl.trim();
    }
    if (dto.order !== undefined) {
      partner.order = dto.order;
    }
    if (dto.isActive !== undefined) {
      partner.isActive = dto.isActive;
    }

    return partner.save();
  }

  async delete(id: string): Promise<{ success: boolean; message: string }> {
    const result = await this.partnerModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Partner with ID ${id} not found.`);
    }
    return { success: true, message: 'Partner removed successfully.' };
  }
}
