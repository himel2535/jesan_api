import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AccessAdminService } from './access-admin.service';
import { RolesController } from './roles.controller';
import { UsersController } from './users.controller';

@Module({
  imports: [AuthModule, PermissionsModule],
  controllers: [RolesController, UsersController],
  providers: [AccessAdminService],
})
export class AccessModule {}
