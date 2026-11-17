import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { DealershipConfig, parseDealershipConfig } from '../dealership.config';

/** Reads the dealership settings of a business (units, code prefixes). */
@Injectable()
export class DealershipContext {
  constructor(private readonly prisma: PrismaService) {}

  async config(businessId: string): Promise<DealershipConfig> {
    const business = await this.prisma.client.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { config: true },
    });
    return parseDealershipConfig(business.config);
  }
}
