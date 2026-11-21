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
import { CurrentClient } from '../auth/auth.decorators.js';
import type { AuthenticatedClient } from '../auth/auth.types.js';
import { IDEMPOTENCY_HEADER, parseIdempotencyKey } from '../idempotency/idempotency-key.js';
import { IdempotencyConflictError, IdempotencyService } from '../idempotency/idempotency.service.js';
import { TriageQueueService } from '../queue/triage-queue.service.js';
import { QueueUnavailableError } from '../queue/with-timeout.js';
import { JsonContentGuard } from './json-content.guard.js';
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
    @CurrentClient() client: AuthenticatedClient,
  ) {
    const key = parseIdempotencyKey(idempotencyKey);
    if (!key.ok) {
      throw new BadRequestException({ detail: `Invalid ${IDEMPOTENCY_HEADER}`, errors: key.problems });
    }
    const parsed = parseTicket(body);
    if (!parsed.ok) {
      throw new BadRequestException({ detail: 'Invalid ticket', errors: parsed.problems });
    }

    let jobId: string;
    try {
      if (key.key === undefined) {
        ({ jobId } = await this.queue.enqueue(parsed.data, client.name));
      } else {
        const submitted = await this.idempotency.submit(client.name, key.key, parsed.data);
        jobId = submitted.jobId;
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
    return { job_id: jobId, status: 'queued', status_url: statusUrl };
  }
}
