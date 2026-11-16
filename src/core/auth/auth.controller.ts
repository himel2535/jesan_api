import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/public.decorator';
import type { AppRequest, AuthContext } from '../common/request-context';
import { CurrentAuth } from '../permissions/current.decorators';
import { REFRESH_COOKIE } from './auth.constants';
import { AuthService, PublicUser } from './auth.service';
import { AuthSettings } from './auth.settings';
import { clearAuthCookies, readCookie, setAuthCookies } from './cookies';
import { ChangePasswordDto, LoginDto } from './dto/auth.dto';
import { extractAccessToken } from './jwt-auth.guard';
import { OriginChecker } from './origin-checker';
import { ClientMeta, SessionService } from './session.service';
import { TokenService } from './token.service';

function clientMeta(request: AppRequest): ClientMeta {
  return { ip: request.ip, userAgent: request.get('user-agent') };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly settings: AuthSettings,
    private readonly origins: OriginChecker,
  ) {}

  /** Email or phone plus password. The tokens travel in httpOnly cookies only. */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginDto,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: PublicUser }> {
    this.origins.assertAllowed(request);
    const result = await this.auth.login(body.identifier, body.password, clientMeta(request));
    setAuthCookies(response, this.settings, result);
    return { user: result.user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'ok' }> {
    this.origins.assertAllowed(request);
    const refreshToken = readCookie(request, REFRESH_COOKIE);
    if (!refreshToken) {
      throw new UnauthorizedException();
    }
    try {
      const tokens = await this.auth.refresh(refreshToken, clientMeta(request));
      setAuthCookies(response, this.settings, tokens);
    } catch (error) {
      clearAuthCookies(response, this.settings);
      throw error;
    }
    return { status: 'ok' };
  }

  /** Ends this device's session. Always succeeds, so it is safe to call twice. */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    this.origins.assertAllowed(request);
    const refreshToken = readCookie(request, REFRESH_COOKIE);
    const endedByRefresh = refreshToken
      ? await this.sessions.revokeByRefreshToken(refreshToken, 'logout')
      : null;

    const found = extractAccessToken(request);
    const payload = found ? this.tokens.verifyAccessToken(found.token) : null;
    if (payload && payload.sid !== endedByRefresh) {
      await this.sessions.revoke(payload.sid, 'logout');
    }
    clearAuthCookies(response, this.settings);
  }

  /** The user, the businesses they may enter, and their role and permissions in each. */
  @Get('me')
  me(@CurrentAuth() auth: AuthContext) {
    return this.auth.me(auth.userId);
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body() body: ChangePasswordDto,
    @Req() request: AppRequest,
  ): Promise<void> {
    await this.auth.changePassword(
      auth.userId,
      auth.sessionId,
      body.currentPassword,
      body.newPassword,
      clientMeta(request),
    );
  }
}
