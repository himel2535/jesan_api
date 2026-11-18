import { Module } from '@nestjs/common';
import { registerTenantModels } from '../database/tenant-scope';
import { ChangeHandlerRegistry } from './change-handler.registry';
import { ChangeRequestsController } from './change-requests.controller';
import { ChangeRequestsService } from './change-requests.service';

@Module({
  controllers: [ChangeRequestsController],
  providers: [ChangeHandlerRegistry, ChangeRequestsService],
  exports: [ChangeHandlerRegistry, ChangeRequestsService],
})
export class ApprovalsModule {
  constructor() {
    registerTenantModels(['ChangeRequest']);
  }
}
