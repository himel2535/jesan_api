import { Injectable } from '@nestjs/common';
import { BusinessAccess } from '../../../core/common/request-context';
import { PrismaService } from '../../../core/database/prisma.service';
import { ListQueryDto } from './dto/requests';
import { PAGE_SIZE, activeFilter, notFound } from './master-data.common';

const select = {
  id: true,
  code: true,
  nameEn: true,
  nameBn: true,
  phone: true,
  address: true,
  isPrincipal: true,
  isActive: true,
} as const;

/** Read-only for now: the principal supplier comes from the business config (seed). */
@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(access: BusinessAccess, query: ListQueryDto) {
    const db = this.prisma.forBusiness(access.businessId);
    const where = activeFilter(query.active);
    const [items, total] = await Promise.all([
      db.supplier.findMany({
        where,
        orderBy: [{ isPrincipal: 'desc' }, { nameEn: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select,
      }),
      db.supplier.count({ where }),
    ]);
    return { items, page: query.page, pageSize: PAGE_SIZE, total };
  }

  async get(access: BusinessAccess, id: string) {
    const row = await this.prisma
      .forBusiness(access.businessId)
      .supplier.findUnique({ where: { id }, select });
    return row ?? notFound('Supplier');
  }
}
