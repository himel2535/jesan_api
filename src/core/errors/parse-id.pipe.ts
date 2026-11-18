import { Injectable, ParseUUIDPipe } from '@nestjs/common';
import { badRequest } from './app-error';

/** ParseUUIDPipe for path ids, with a stable code. */
@Injectable()
export class ParseIdPipe extends ParseUUIDPipe {
  constructor() {
    super({ exceptionFactory: () => badRequest('ID_INVALID', 'The id in the path is not valid') });
  }
}
