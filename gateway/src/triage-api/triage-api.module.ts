import { Module } from '@nestjs/common';
import { FETCH } from '../health/health.constants.js';
import { DEFAULT_TRIAGE_API_TIMEOUTS, TRIAGE_API_TIMEOUTS } from './triage-api.constants.js';
import { ReviewerTicketsController } from './reviewer-tickets.controller.js';
import { TriageClient } from './triage-client.js';

@Module({
  controllers: [ReviewerTicketsController],
  providers: [
    TriageClient,
    { provide: FETCH, useValue: globalThis.fetch.bind(globalThis) },
    { provide: TRIAGE_API_TIMEOUTS, useValue: DEFAULT_TRIAGE_API_TIMEOUTS },
  ],
})
export class TriageApiModule {}
