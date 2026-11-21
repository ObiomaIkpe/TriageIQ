import {
  BadRequestException,
  Controller,
  Get,
  InternalServerErrorException,
  Inject,
  Logger,
  NotFoundException,
  Param,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { TriageQueueService, type JobSnapshot } from '../queue/triage-queue.service.js';
import { QueueUnavailableError } from '../queue/with-timeout.js';
import { mapJobState, shortReason } from './job-status.js';

export const STATUS_UNAVAILABLE = 'Job status is temporarily unavailable; please retry';

const logger = new Logger('Jobs');

@Controller('jobs')
export class JobsController {
  constructor(@Inject(TriageQueueService) private readonly queue: TriageQueueService) {}

  @Get(':id')
  async get(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    // The id is not echoed back in any error.
    if (!z.uuid().safeParse(id).success) {
      throw new BadRequestException({ detail: 'Malformed job id' });
    }

    let snapshot: JobSnapshot | undefined;
    try {
      snapshot = await this.queue.findJob(id);
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        throw new ServiceUnavailableException({ detail: STATUS_UNAVAILABLE });
      }
      throw error;
    }

    // 'unknown' means the job was removed between the lookup and the state check.
    if (!snapshot || snapshot.state === 'unknown') {
      throw new NotFoundException({ detail: 'Job not found' });
    }

    // A submitter sees only its own jobs (owner = the bare client name, as every existing job holds it). Another client's job, and a job from before clients
    // existed (no `client`), answer exactly like a missing one: 404, never 403, so job ids
    // cannot be probed. The check comes before anything else about the job is looked at.
    if (principal.role !== 'reviewer' && snapshot.data?.client !== principal.ownerId) {
      throw new NotFoundException({ detail: 'Job not found' });
    }
    const status = mapJobState(snapshot.state);
    if (!status) {
      logger.error(`Unmapped BullMQ job state: ${snapshot.state}`);
      throw new InternalServerErrorException({ detail: 'Job is in an unexpected state' });
    }

    return {
      job_id: id,
      status,
      received_at: snapshot.data?.received_at,
      ...(status === 'done' ? { result: snapshot.returnvalue ?? null } : {}),
      ...(status === 'failed' ? { error: shortReason(snapshot.failedReason) } : {}),
    };
  }
}
