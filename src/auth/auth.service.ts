import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserDocument } from '../users/schemas/user.schema';

@Injectable()
export class AuthService {
  constructor(private readonly jwtService: JwtService) {}

  generateJwt(user: UserDocument): { accessToken: string } {
    const payload = { email: user.email, sub: user._id.toString() };
    return {
      accessToken: this.jwtService.sign(payload),
    };
  }
}
