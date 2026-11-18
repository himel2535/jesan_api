import { Global, Module } from '@nestjs/common';
import { DocumentCounterService } from './document-counter.service';
import { PeriodCounterService } from './period-counter.service';

@Global()
@Module({
  providers: [DocumentCounterService, PeriodCounterService],
  exports: [DocumentCounterService, PeriodCounterService],
})
export class NumberingModule {}
