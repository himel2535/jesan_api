import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type { AppRequest, AuthContext, BusinessAccess } from '../common/request-context';
import { CurrentAccess, CurrentAuth } from '../permissions/current.decorators';
import { RequirePermission } from '../permissions/decorators';
import { AccessAdminService } from './access-admin.service';
import { SetRolePermissionsDto } from './dto/access.dto';

/** Settings: what each role may do in a business. Platform owner only (`roles.manage`). */
@Controller('b/:businessSlug/roles')
export class RolesController {
  constructor(private readonly admin: AccessAdminService) {}

  @Get('permissions')
  @RequirePermission('roles.manage')
  matrix(@CurrentAccess() access: BusinessAccess) {
    return this.admin.getRoleMatrix(access);
  }

  @Put(':roleKey/permissions')
  @RequirePermission('roles.manage')
  setPermissions(
    @CurrentAccess() access: BusinessAccess,
    @CurrentAuth() auth: AuthContext,
    @Param('roleKey') roleKey: string,
    @Body() body: SetRolePermissionsDto,
    @Req() request: AppRequest,
  ) {
    return this.admin.setRolePermissions(access, roleKey, body.permissions, {
      userId: auth.userId,
      ip: request.ip,
    });
  }
}
