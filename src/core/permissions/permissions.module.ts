import { Module } from '@nestjs/common';
import { AccessResolver } from './access-resolver.service';
import { CORE_PERMISSIONS } from './core-permissions';
import { PermissionRegistry } from './permission-registry';
import { PermissionSyncService } from './permission-sync.service';

@Module({
  providers: [PermissionRegistry, AccessResolver, PermissionSyncService],
  exports: [PermissionRegistry, AccessResolver, PermissionSyncService],
})
export class PermissionsModule {
  constructor(registry: PermissionRegistry) {
    registry.register(CORE_PERMISSIONS);
  }
}
