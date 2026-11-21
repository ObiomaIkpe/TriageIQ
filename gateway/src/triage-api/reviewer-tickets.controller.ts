import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentClient, Roles } from '../auth/auth.decorators.js';
import type { AuthenticatedClient } from '../auth/auth.types.js';
import { JsonContentGuard } from '../tickets/json-content.guard.js';
import {
  isReference,
  isUuid,
  parseListQuery,
  parseReviewDecision,
} from './passthrough.schemas.js';
import { TriageClient, type TriageAnswer } from './triage-client.js';

/**
 * The Python service's read and review endpoints, offered to reviewers through the gateway.
 * Only reviewers may call them (a submitter gets 403). POST /tickets, the intake route, lives in
 * TicketsController; these four paths do not overlap with it, and the reference route is
 * declared before the :id route so a reference can never be read as an id.
 */
@Roles('reviewer')
@Controller('tickets')
export class ReviewerTicketsController {
  constructor(@Inject(TriageClient) private readonly triage: TriageClient) {}

  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
    @CurrentClient() client: AuthenticatedClient,
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
        route: 'GET /tickets',
        client: client.name,
      }),
    );
  }

  @Get('reference/:reference')
  async byReference(
    @Param('reference') reference: string,
    @Res() response: Response,
    @CurrentClient() client: AuthenticatedClient,
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
        route: 'GET /tickets/reference/:reference',
        client: client.name,
      }),
    );
  }

  @Get(':id')
  async byId(
    @Param('id') id: string,
    @Res() response: Response,
    @CurrentClient() client: AuthenticatedClient,
  ) {
    if (!isUuid(id)) throw new BadRequestException({ detail: 'Malformed ticket id' });
    this.send(
      response,
      await this.triage.call({
        method: 'GET',
        path: `/tickets/${id}`,
        kind: 'read',
        route: 'GET /tickets/:id',
        client: client.name,
      }),
    );
  }

  @Post(':id/review')
  @UseGuards(JsonContentGuard)
  async review(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() response: Response,
    @CurrentClient() client: AuthenticatedClient,
  ) {
    // Nothing is sent to Python until the id and the decision are both valid.
    if (!isUuid(id)) throw new BadRequestException({ detail: 'Malformed ticket id' });
    const decision = parseReviewDecision(body);
    if (!decision.ok) {
      throw new BadRequestException({ detail: 'Invalid review decision', errors: decision.problems });
    }
    this.send(
      response,
      await this.triage.call({
        method: 'POST',
        path: `/tickets/${id}/review`,
        body: decision.data,
        kind: 'review',
        route: 'POST /tickets/:id/review',
        client: client.name,
      }),
    );
  }

  /** Python's status and JSON body, as they are. */
  private send(response: Response, answer: TriageAnswer): void {
    response.status(answer.status).json(answer.body);
  }
}
