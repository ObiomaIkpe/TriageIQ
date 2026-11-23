import { BadRequestException, ConflictException, Controller, Get, Inject, Param, Post, ServiceUnavailableException } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators.js';
import { QueueUnavailableError } from '../queue/with-timeout.js';
import { isUuid } from '../triage-api/passthrough.schemas.js';
import { ReplyDeliveryRepository, type DeliveryRow } from './reply-delivery.repository.js';
import { ReplyDeliveryService } from './reply-delivery.service.js';

export interface DeliveryView {
  status: 'none' | DeliveryRow['status'];
  attempts: number;
  sent_at: string | null;
  /** A short generic phrase (never an address or a server message). */
  error: string | null;
}

const NONE: DeliveryView = { status: 'none', attempts: 0, sent_at: null, error: null };

const view = (row: DeliveryRow | undefined): DeliveryView =>
  row ? { status: row.status, attempts: row.attempts, sent_at: row.sent_at ? row.sent_at.toISOString() : null, error: row.last_error } : NONE;

/**
 * How the email of an approved reply is going. Reviewers only. Two segments after /tickets/:id, so the existing
 * GET /tickets/:id route can never capture these (and the cookie Origin rule for writes is the global one).
 */
@Roles('reviewer')
@Controller('tickets')
export class DeliveryController {
  constructor(
    @Inject(ReplyDeliveryRepository) private readonly deliveries: ReplyDeliveryRepository,
    @Inject(ReplyDeliveryService) private readonly service: ReplyDeliveryService,
  ) {}

  @Get(':id/delivery')
  async status(@Param('id') id: string): Promise<DeliveryView> {
    if (!isUuid(id)) throw new BadRequestException({ detail: 'Malformed ticket id' });
    return view(await this.deliveries.get(id));
  }

  /** Only for a failed delivery: it goes back to queued with a fresh set of attempts. 409 for anything else. */
  @Post(':id/delivery/retry')
  async retry(@Param('id') id: string): Promise<DeliveryView> {
    if (!isUuid(id)) throw new BadRequestException({ detail: 'Malformed ticket id' });
    let retried: boolean;
    try {
      retried = await this.service.retry(id);
    } catch (error) {
      if (error instanceof QueueUnavailableError) throw new ServiceUnavailableException({ detail: 'Mail queue temporarily unavailable; please retry' });
      throw error;
    }
    if (!retried) throw new ConflictException({ detail: 'Only a failed delivery can be retried' });
    return view(await this.deliveries.get(id));
  }
}
