import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentPrincipal, Roles } from '../auth/auth.decorators.js';
import { reviewerFor, scopeFor, type Principal } from '../auth/principal.js';
import { demoEmailPreview } from '../demo/email-preview.js';
import { JsonContentGuard } from '../tickets/json-content.guard.js';
import {
  isCountsPayload,
  isReference,
  isTicketPayload,
  isUuid,
  parseListQuery,
  parseReviewDecision,
} from './passthrough.schemas.js';
import { ReplyDeliveryService } from '../mail/reply-delivery.service.js';
import { MSG_ERROR } from './triage-api.constants.js';
import { TriageClient, type TriageAnswer } from './triage-client.js';

/**
 * The Python service's read and review endpoints, offered to reviewers through the gateway.
 * Only reviewers and the demo visitor may call them (a submitter gets 403). The demo visitor is sent to Python with scope=demo and so
 * sees only demo tickets, as every real caller (users and API clients) is sent with scope=real: the wall is enforced by Python
 * (a ticket on the other side is a 404); this controller only says which side, taken from the authenticated principal. POST /tickets, the intake route, lives in
 * TicketsController; these paths do not overlap with it, and the reference route is
 * declared before the :id route so a reference can never be read as an id.
 */
const logger = new Logger('ReviewerTickets');

@Roles('reviewer', 'demo')
@Controller('tickets')
export class ReviewerTicketsController {
  constructor(
    @Inject(TriageClient) private readonly triage: TriageClient,
    @Inject(ReplyDeliveryService) private readonly replies: ReplyDeliveryService,
  ) {}

  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
    @CurrentPrincipal() principal: Principal,
  ) {
    const parsed = parseListQuery(query);
    if (!parsed.ok) {
      throw new BadRequestException({ detail: 'Invalid query', errors: parsed.problems });
    }
    this.send(
      response,
      await this.triage.call({
        method: 'GET',
        path: '/tickets',
        query: parsed.params,
        kind: 'read',
        scope: scopeFor(principal),
        route: 'GET /tickets',
        client: principal.label,
      }),
      principal,
    );
  }

  /** Declared before :id, so "counts" is never read as a ticket id. */
  @Get('counts')
  async counts(@Res() response: Response, @CurrentPrincipal() principal: Principal) {
    const answer = await this.triage.call({
      method: 'GET',
      path: '/tickets/counts',
      kind: 'read',
      scope: scopeFor(principal),
      route: 'GET /tickets/counts',
      client: principal.label,
    });
    if (answer.status >= 200 && answer.status < 300 && !isCountsPayload(answer.body)) {
      throw new BadGatewayException({ detail: MSG_ERROR });
    }
    response.status(answer.status).json(answer.body);
  }

  @Get('reference/:reference')
  async byReference(
    @Param('reference') reference: string,
    @Res() response: Response,
    @CurrentPrincipal() principal: Principal,
  ) {
    if (!isReference(reference)) {
      throw new BadRequestException({ detail: 'Malformed ticket reference' });
    }
    this.send(
      response,
      await this.triage.call({
        method: 'GET',
        path: `/tickets/reference/${reference}`,
        kind: 'read',
        scope: scopeFor(principal),
        route: 'GET /tickets/reference/:reference',
        client: principal.label,
      }),
      principal,
    );
  }

  @Get(':id')
  async byId(
    @Param('id') id: string,
    @Res() response: Response,
    @CurrentPrincipal() principal: Principal,
  ) {
    if (!isUuid(id)) throw new BadRequestException({ detail: 'Malformed ticket id' });
    this.send(
      response,
      await this.triage.call({
        method: 'GET',
        path: `/tickets/${id}`,
        kind: 'read',
        scope: scopeFor(principal),
        route: 'GET /tickets/:id',
        client: principal.label,
      }),
      principal,
    );
  }

  @Post(':id/review')
  @UseGuards(JsonContentGuard)
  async review(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() response: Response,
    @CurrentPrincipal() principal: Principal,
  ) {
    // Nothing is sent to Python until the id and the decision are both valid.
    if (!isUuid(id)) throw new BadRequestException({ detail: 'Malformed ticket id' });
    const decision = parseReviewDecision(body);
    if (!decision.ok) {
      throw new BadRequestException({ detail: 'Invalid review decision', errors: decision.problems });
    }
    const reviewer = reviewerFor(principal);
    const answer = await this.triage.call({
        method: 'POST',
        path: `/tickets/${id}/review`,
        // The client's validated decision, plus WHO is reviewing, taken from the authenticated principal.
        // The strict schema above already refused a `reviewer` field in the client's own body.
        body: { ...decision.data, reviewer },
        kind: 'review',
        scope: scopeFor(principal),
        route: 'POST /tickets/:id/review',
        client: principal.label,
        reviewer: reviewer.id,
    });
    // An approval or an edit (any 200 from a review that is not a rejection) may need an email. It never changes the answer.
    // A DEMO ticket is NEVER emailed: for the demo principal this is not even called (and onApproved refuses a demo ticket again).
    if (answer.status >= 200 && answer.status < 300 && scopeFor(principal) === 'real') await this.triggerReply(answer.body);
    this.send(response, answer, principal);
  }

  /**
   * Records the delivery and queues the email. If that fails the review stays successful: the failure is logged loudly and the
   * 5-minute sweep makes the delivery later. Nothing here ever logs the address or the reply.
   */
  private async triggerReply(ticket: unknown): Promise<void> {
    const t = ticket as { ticket_id?: unknown; reference?: unknown; status?: unknown; customer_email?: unknown; is_demo?: unknown } | null;
    if (!t || typeof t.ticket_id !== 'string' || typeof t.reference !== 'string' || typeof t.status !== 'string') return;
    try {
      await this.replies.onApproved({
        ticket_id: t.ticket_id,
        reference: t.reference,
        status: t.status,
        customer_email: typeof t.customer_email === 'string' ? t.customer_email : null,
        is_demo: t.is_demo === true,
      });
    } catch {
      logger.error(`Could not queue the reply email for ${t.reference} (ticket ${t.ticket_id}); the sweep will retry within minutes`);
    }
  }

  /**
   * Python's status and JSON body, as they are, if a successful answer has a well-formed reviewed_by. For the demo visitor a decided
   * ticket also carries `email_preview`: the email that WOULD have been sent (nothing ever is).
   */
  private send(response: Response, answer: TriageAnswer, principal: Principal): void {
    if (answer.status >= 200 && answer.status < 300 && !isTicketPayload(answer.body)) {
      throw new BadGatewayException({ detail: MSG_ERROR });
    }
    if (scopeFor(principal) === 'demo' && answer.status >= 200 && answer.status < 300 && !Array.isArray(answer.body)) {
      const preview = demoEmailPreview(answer.body);
      if (preview) {
        response.status(answer.status).json({ ...(answer.body as object), email_preview: preview });
        return;
      }
    }
    response.status(answer.status).json(answer.body);
  }
}
