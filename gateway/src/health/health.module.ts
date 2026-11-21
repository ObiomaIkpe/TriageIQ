import { Module } from '@nestjs/common';
import { DEFAULT_READY_TIMEOUT_MS, FETCH, READY_TIMEOUT_MS } from './health.constants.js';
import { HealthController } from './health.controller.js';
import { ReadyService } from './ready.service.js';

@Module({
  controllers: [HealthController],
  providers: [
    ReadyService,
    // The built-in fetch. Provided through DI so tests can swap in a fake.
    { provide: FETCH, useValue: globalThis.fetch.bind(globalThis) },
    { provide: READY_TIMEOUT_MS, useValue: DEFAULT_READY_TIMEOUT_MS },
  ],
})
export class HealthModule {}
