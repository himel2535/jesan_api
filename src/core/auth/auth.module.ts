import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { EnvironmentVariables } from '../config/env.validation';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSettings } from './auth.settings';
import { OriginChecker } from './origin-checker';
import { PasswordService } from './password.service';
import { RevocationList } from './revocation-list';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

const SECOND_MS = 1000;

@Module({
  imports: [
    PermissionsModule,
    // Sign-in attempts per IP address per minute (applied to /auth/login only).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => [
        { ttl: 60 * SECOND_MS, limit: config.get('LOGIN_RATE_LIMIT', { infer: true }) },
      ],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthSettings,
    {
      provide: JwtService,
      inject: [AuthSettings],
      useFactory: (settings: AuthSettings) =>
        new JwtService({ secret: settings.jwtSecret, signOptions: { algorithm: 'HS256' } }),
    },
    AuthService,
    PasswordService,
    TokenService,
    SessionService,
    RevocationList,
    OriginChecker,
  ],
  exports: [
    AuthSettings,
    PasswordService,
    TokenService,
    SessionService,
    RevocationList,
    OriginChecker,
  ],
})
export class AuthModule {}
