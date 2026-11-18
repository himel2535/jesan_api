import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AccessModule } from './core/access/access.module';
import { ApprovalsModule } from './core/approvals/approvals.module';
import { AuditModule } from './core/audit/audit.module';
import { AuthModule } from './core/auth/auth.module';
import { JwtAuthGuard } from './core/auth/jwt-auth.guard';
import { validateEnv } from './core/config/env.validation';
import { DatabaseModule } from './core/database/database.module';
import { HealthModule } from './core/health/health.module';
import { NumberingModule } from './core/numbering/numbering.module';
import { BusinessAccessGuard } from './core/permissions/business-access.guard';
import { PermissionGuard } from './core/permissions/permission.guard';
import { PermissionsModule } from './core/permissions/permissions.module';
import { SerializeInterceptor } from './core/permissions/serialize/serialize.interceptor';
import { DealershipModule } from './modules/dealership/dealership.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DatabaseModule,
    AuditModule,
    NumberingModule,
    PermissionsModule,
    AuthModule,
    AccessModule,
    ApprovalsModule,
    HealthModule,
    DealershipModule,
  ],
  providers: [
    // Order matters: sign in first, then business access, then the permission.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: BusinessAccessGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: SerializeInterceptor },
  ],
})
export class AppModule {}
