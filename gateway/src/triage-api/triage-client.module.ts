import { Module } from '@nestjs/common';
import { FETCH } from '../health/health.constants.js';
import { DEFAULT_TRIAGE_API_TIMEOUTS, TRIAGE_API_TIMEOUTS } from './triage-api.constants.js';
import { TriageClient } from './triage-client.js';

/** The client for the Python service's read and review endpoints, shared by the reviewer routes and the email worker. */
@Module({
  providers: [
    TriageClient,
    { provide: FETCH, useValue: globalThis.fetch.bind(globalThis) },
    { provide: TRIAGE_API_TIMEOUTS, useValue: DEFAULT_TRIAGE_API_TIMEOUTS },
  ],
  exports: [TriageClient],
})
export class TriageClientModule {}
