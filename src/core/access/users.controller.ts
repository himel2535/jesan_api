import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AppRequest, AuthContext, BusinessAccess } from '../common/request-context';
import { CurrentAccess, CurrentAuth } from '../permissions/current.decorators';
import { RequirePermission } from '../permissions/decorators';
import { AccessAdminService, ActorInfo } from './access-admin.service';
import { UserThrottlerGuard } from './user-throttler.guard';

/** Lookups allowed per user per minute. */
const LOOKUP_LIMIT_PER_MINUTE = 20;
import {
  CreateUserDto,
  LookupUserDto,
  PageQueryDto,
  ResetPasswordDto,
  RoleKeyDto,
  SetStatusDto,
} from './dto/access.dto';

function actorOf(auth: AuthContext, request: AppRequest): ActorInfo {
  return { userId: auth.userId, ip: request.ip };
}

/**
 * Settings: who works in a business. Listing needs `users.view`; every change
 * needs `users.manage`, which only the platform owner holds.
 */
@Controller('b/:businessSlug/users')
export class UsersController {
  constructor(private readonly admin: AccessAdminService) {}

  @Get()
  @RequirePermission('users.view')
  list(@CurrentAccess() access: BusinessAccess, @Query() query: PageQueryDto) {
    return this.admin.listUsers(access, query.page);
  }

  @Post()
  @RequirePermission('users.manage')
  create(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateUserDto,
    @Req() request: AppRequest,
  ) {
    return this.admin.createUser(access, body, actorOf(auth, request));
  }

  /** Find an existing user by email or phone (POST keeps them out of URLs and logs). */
  @Post('lookup')
  @HttpCode(200)
  @RequirePermission('users.manage')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: LOOKUP_LIMIT_PER_MINUTE, ttl: 60_000 } })
  lookup(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Body() body: LookupUserDto,
    @Req() request: AppRequest,
  ) {
    return this.admin.lookupUser(access, body.identifier, actorOf(auth, request));
  }

  @Post(':userId/access')
  @HttpCode(200)
  @RequirePermission('users.manage')
  grant(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: RoleKeyDto,
    @Req() request: AppRequest,
  ) {
    return this.admin.grantAccess(access, userId, body.roleKey, actorOf(auth, request));
  }

  @Patch(':userId/role')
  @RequirePermission('users.manage')
  changeRole(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: RoleKeyDto,
    @Req() request: AppRequest,
  ) {
    return this.admin.grantAccess(access, userId, body.roleKey, actorOf(auth, request));
  }

  @Delete(':userId/access')
  @HttpCode(204)
  @RequirePermission('users.manage')
  removeAccess(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() request: AppRequest,
  ) {
    return this.admin.removeAccess(access, userId, actorOf(auth, request));
  }

  @Patch(':userId/status')
  @HttpCode(204)
  @RequirePermission('users.manage')
  setStatus(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: SetStatusDto,
    @Req() request: AppRequest,
  ) {
    return this.admin.setStatus(access, userId, body.isActive, actorOf(auth, request));
  }

  @Post(':userId/reset-password')
  @HttpCode(204)
  @RequirePermission('users.manage')
  resetPassword(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: ResetPasswordDto,
    @Req() request: AppRequest,
  ) {
    return this.admin.resetPassword(access, userId, body.newPassword, actorOf(auth, request));
  }
}
