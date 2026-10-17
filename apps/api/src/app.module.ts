import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AccountingController } from './accounting/accounting.controller';
import { JournalService } from './accounting/journal.service';
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
import { StockService } from './inventory/stock.service';
import { InvoicingService } from './sales/billing/invoicing.service';
import { CollectionsService } from './sales/collections/collections.service';
import { CollectionsController, DeliveriesController, FulfilmentController, ReturnsController } from './sales/fulfilment.controllers';
import { FulfilmentService } from './sales/fulfilment/fulfilment.service';
import { ReturnsService } from './sales/returns/returns.service';
import { CatalogService } from './sales/catalog/catalog.service';
import { SalesCustomersService } from './sales/customers/sales-customers.service';
import { OrdersService } from './sales/orders/orders.service';
import { PricingService } from './sales/pricing.service';
import { SalesContextService } from './sales/sales-context.service';
import { CatalogController, OrdersController, SalesCustomersController } from './sales/sales.controllers';
import { CommissionsService } from './sales/commissions/commissions.service';
import {
  CommissionsController,
  LocationsController,
  PayrollHandoffController,
  QuotationsController,
  TargetsController,
  TerritoriesController,
  VisitsController,
} from './sales/field.controllers';
import { QuotationsService } from './sales/quotations/quotations.service';
import { TargetsService } from './sales/targets/targets.service';
import { TerritoriesService } from './sales/territories/territories.service';
import { VisitsService } from './sales/visits/visits.service';
import { SyncController } from './sales/sync/sync.controller';
import { SyncService } from './sales/sync/sync.service';
import { ThemeController } from './core/theme/theme.controller';
import { ReportsController } from './sales/reports/reports.controller';
import { ReportsService } from './sales/reports/reports.service';

@Global()
@Module({
  providers: [DatabaseService, AuditService, NumberingService, SubscriptionService, JournalService, StockService],
  exports: [DatabaseService, AuditService, NumberingService, SubscriptionService, JournalService, StockService],
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
    FulfilmentController,
    DeliveriesController,
    ReturnsController,
    CollectionsController,
    QuotationsController,
    VisitsController,
    TerritoriesController,
    LocationsController,
    TargetsController,
    CommissionsController,
    PayrollHandoffController,
    SyncController,
    ThemeController,
    ReportsController,
    AccountingController,
  ],
  providers: [
    TenantProvisioningService,
    SalesContextService,
    PricingService,
    OrdersService,
    SalesCustomersService,
    CatalogService,
    InvoicingService,
    FulfilmentService,
    ReturnsService,
    CollectionsService,
    CommissionsService,
    TargetsService,
    VisitsService,
    TerritoriesService,
    QuotationsService,
    SyncService,
    ReportsService,
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
