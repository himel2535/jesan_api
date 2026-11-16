import { Controller, Get } from '@nestjs/common';
import { Type } from 'class-transformer';
import { AnyBusinessMember, RequirePermission } from '../src/core/permissions/decorators';
import { SerializeWith } from '../src/core/permissions/serialize/serialize.interceptor';
import { VisibleWith } from '../src/core/permissions/serialize/visible-with';
import { Expose } from 'class-transformer';

/** What a stock line may show: the quantity to everyone, money only with the right permission. */
export class SampleStockLineDto {
  @Expose() productName!: string;
  @Expose() quantity!: number;
  @VisibleWith('product.cost.view') unitCost!: number;
  @VisibleWith('profit.view') margin!: number;
}

export class SampleStockDto {
  @Expose()
  @Type(() => SampleStockLineDto)
  items!: SampleStockLineDto[];

  @VisibleWith('profit.view') totalMargin!: number;
}

/**
 * Stand-in for a future business endpoint, used only by tests. It returns more
 * than it should (an internal field) to show that undeclared fields never leave.
 */
@Controller('b/:businessSlug/sample')
export class SampleController {
  @Get('stock')
  @RequirePermission('stock.view')
  @SerializeWith(SampleStockDto)
  stock() {
    return {
      items: [
        { productName: 'OPC', quantity: 120, unitCost: 570, margin: 30, internalNote: 'hidden' },
        { productName: 'PCC', quantity: 80, unitCost: 560, margin: 25, internalNote: 'hidden' },
      ],
      totalMargin: 5000,
      supplierSecret: 'hidden',
    };
  }

  @Get('commission')
  @RequirePermission('commission.view')
  commission() {
    return { commission: 'only the platform owner may see this' };
  }

  @Get('members')
  @AnyBusinessMember()
  members() {
    return { ok: true };
  }

  /** No permission stated: refused for everybody. */
  @Get('forgotten')
  forgotten() {
    return { ok: true };
  }
}
