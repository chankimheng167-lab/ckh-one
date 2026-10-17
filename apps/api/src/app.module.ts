import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuditService } from './common/audit.service';
import { AllExceptionsFilter } from './common/errors';
import { loadConfig } from './config';
import { AccessGuard } from './core/auth/access.guard';
import { AuthController } from './core/auth/auth.controller';
import { HealthController } from './core/health.controller';
import { MasterDataController } from './core/masterdata/masterdata.controller';
import { NumberingService } from './core/numbering.service';
import { PlatformController } from './core/platform/platform.controller';
import { TenantProvisioningService } from './core/platform/tenant-provisioning.service';
import { SubscriptionService } from './core/subscriptions/subscription.service';
import { TenantAdminController } from './core/tenant-admin/tenant-admin.controller';
import { DatabaseService } from './db/database.service';
import { CatalogService } from './sales/catalog/catalog.service';
import { SalesCustomersService } from './sales/customers/sales-customers.service';
import { OrdersService } from './sales/orders/orders.service';
import { PricingService } from './sales/pricing.service';
import { SalesContextService } from './sales/sales-context.service';
import { CatalogController, OrdersController, SalesCustomersController } from './sales/sales.controllers';

@Global()
@Module({
  providers: [DatabaseService, AuditService, NumberingService, SubscriptionService],
  exports: [DatabaseService, AuditService, NumberingService, SubscriptionService],
})
export class CoreInfraModule {}

@Module({
  imports: [
    CoreInfraModule,
    JwtModule.registerAsync({
      global: true,
      useFactory: () => {
        const cfg = loadConfig();
        return { secret: cfg.jwtSecret, signOptions: { expiresIn: cfg.jwtTtlSeconds } };
      },
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    PlatformController,
    TenantAdminController,
    MasterDataController,
    SalesCustomersController,
    CatalogController,
    OrdersController,
  ],
  providers: [
    TenantProvisioningService,
    SalesContextService,
    PricingService,
    OrdersService,
    SalesCustomersService,
    CatalogService,
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
