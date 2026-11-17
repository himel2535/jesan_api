import { Global, Module } from '@nestjs/common';
import { DocumentCounterService } from './document-counter.service';

@Global()
@Module({
  providers: [DocumentCounterService],
  exports: [DocumentCounterService],
})
export class NumberingModule {}
