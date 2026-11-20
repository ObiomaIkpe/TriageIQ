import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { TriageQueueService } from '../queue/triage-queue.service.js';
import { QueueUnavailableError } from '../queue/with-timeout.js';
import { JsonContentGuard } from './json-content.guard.js';
import { parseTicket } from './ticket.schema.js';

export const INTAKE_UNAVAILABLE = 'Ticket intake is temporarily unavailable; please retry';

@Controller('tickets')
export class TicketsController {
  constructor(@Inject(TriageQueueService) private readonly queue: TriageQueueService) {}

  /** Validates a ticket, queues it, and answers 202 with a job id to poll. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JsonContentGuard)
  async create(@Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const parsed = parseTicket(body);
    if (!parsed.ok) {
      throw new BadRequestException({ detail: 'Invalid ticket', errors: parsed.problems });
    }

    let jobId: string;
    try {
      ({ jobId } = await this.queue.enqueue(parsed.data));
    } catch (error) {
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
