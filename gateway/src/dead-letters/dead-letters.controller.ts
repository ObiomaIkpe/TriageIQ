import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../auth/auth.decorators.js';
import { TriageQueueService } from '../queue/triage-queue.service.js';
import { QueueUnavailableError } from '../queue/with-timeout.js';
import { parsePage } from './pagination.js';

export const DEAD_LETTERS_UNAVAILABLE = 'Dead-letter list is temporarily unavailable; please retry';

/**
 * Jobs that failed for good (attempts used up, or a ticket the triage service rejects).
 * They carry ticket text and these routes have no login until M3.5, so the gateway port
 * must stay bound to localhost.
 */
@Roles('reviewer')
@Controller('dead-letters')
export class DeadLettersController {
  constructor(@Inject(TriageQueueService) private readonly queue: TriageQueueService) {}

  @Get()
  async list(@Query() query: Record<string, unknown>) {
    const page = parsePage(query);
    if (!page.ok) {
      throw new BadRequestException({ detail: 'Invalid query', errors: page.problems });
    }
    try {
      const { items, total } = await this.queue.listDeadLetters(page.limit, page.offset);
      return { items, total, limit: page.limit, offset: page.offset };
    } catch (error) {
      throw translate(error);
    }
  }

  /** Moves a failed job back to the queue under the same id, with all its attempts again. */
  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  async retry(@Param('id') id: string) {
    // The id is not echoed back in any error.
    if (!z.uuid().safeParse(id).success) {
      throw new BadRequestException({ detail: 'Malformed job id' });
    }
    let result;
    try {
      result = await this.queue.retryDeadLetter(id);
    } catch (error) {
      throw translate(error);
    }
    if (result === 'not-found') throw new NotFoundException({ detail: 'Job not found' });
    if (result === 'not-failed') {
      throw new ConflictException({ detail: 'Job is not in the dead-letter list' });
    }
    return { job_id: id, status: 'queued', status_url: `/jobs/${id}` };
  }
}

function translate(error: unknown): unknown {
  if (error instanceof QueueUnavailableError) {
    return new ServiceUnavailableException({ detail: DEAD_LETTERS_UNAVAILABLE });
  }
  return error;
}
