import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      clientID: configService.get<string>('GOOGLE_CLIENT_ID') || 'mock-id',
      clientSecret:
        configService.get<string>('GOOGLE_CLIENT_SECRET') || 'mock-secret',
      callbackURL:
        configService.get<string>('GOOGLE_CALLBACK_URL') ||
        'http://localhost:3001/api/auth/google/callback',
      scope: ['email', 'profile'],
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: (err: any, user: any, info?: any) => void,
  ): Promise<any> {
    const { id, displayName, emails, photos } = profile;
    const email = emails?.[0]?.value;
    const avatarUrl = photos?.[0]?.value;

    if (!email) {
      return done(new Error('No email found in Google account'), null);
    }

    try {
      const user = await this.usersService.findOrCreateByGoogleId({
        googleId: id,
        email,
        displayName: displayName || email.split('@')[0],
        avatarUrl: avatarUrl || '',
      });
      done(null, user);
    } catch (err) {
      done(err, null);
    }
  }
}
