import { Module } from '@nestjs/common';
import { PermissionRegistry } from '../../core/permissions/permission-registry';
import { PermissionsModule } from '../../core/permissions/permissions.module';
import { DEALERSHIP_PERMISSIONS } from './dealership.permissions';

@Module({ imports: [PermissionsModule] })
export class DealershipModule {
  constructor(registry: PermissionRegistry) {
    registry.register(DEALERSHIP_PERMISSIONS);
  }
}
