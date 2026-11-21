import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentPrincipal } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { IDEMPOTENCY_HEADER, parseIdempotencyKey } from '../idempotency/idempotency-key.js';
import { IdempotencyConflictError, IdempotencyService } from '../idempotency/idempotency.service.js';
import { TriageQueueService } from '../queue/triage-queue.service.js';
import { QueueUnavailableError } from '../queue/with-timeout.js';
import { JsonContentGuard } from './json-content.guard.js';
import { newReference } from './reference.js';
import { parseTicket } from './ticket.schema.js';

export const INTAKE_UNAVAILABLE = 'Ticket intake is temporarily unavailable; please retry';

@Controller('tickets')
export class TicketsController {
  constructor(
    @Inject(TriageQueueService) private readonly queue: TriageQueueService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Validates a ticket, queues it, and answers 202 with a job id to poll.
   * With an Idempotency-Key header the ticket is queued at most once per key: a repeat with
   * the same key and ticket gets the same job id back (header Idempotent-Replayed: true).
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JsonContentGuard)
  async create(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    const key = parseIdempotencyKey(idempotencyKey);
    if (!key.ok) {
      throw new BadRequestException({ detail: `Invalid ${IDEMPOTENCY_HEADER}`, errors: key.problems });
    }
    const parsed = parseTicket(body);
    if (!parsed.ok) {
      throw new BadRequestException({ detail: 'Invalid ticket', errors: parsed.problems });
    }

    // The reference is made here, at accept time, for every ticket (one code path), and goes to Python with the job.
    const reference = newReference();
    let jobId: string;
    let answeredReference: string | undefined = reference;
    try {
      if (key.key === undefined) {
        ({ jobId } = await this.queue.enqueue(parsed.data, principal.ownerId, undefined, { reference }));
      } else {
        const submitted = await this.idempotency.submit(principal.id, key.key, parsed.data, principal.ownerId, { reference });
        jobId = submitted.jobId;
        // A replay answers with the reference the first request got (undefined only for keys stored before this existed).
        answeredReference = submitted.reference;
        if (submitted.replayed) response.setHeader('Idempotent-Replayed', 'true');
      }
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new UnprocessableEntityException({ detail: error.message });
      }
      if (error instanceof QueueUnavailableError) {
        throw new ServiceUnavailableException({ detail: INTAKE_UNAVAILABLE });
      }
      throw error;
    }

    const statusUrl = `/jobs/${jobId}`;
    response.setHeader('Location', statusUrl);
    return {
      job_id: jobId,
      ...(answeredReference === undefined ? {} : { reference: answeredReference }),
      status: 'queued',
      status_url: statusUrl,
    };
  }
}
