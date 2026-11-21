import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/auth.decorators.js';
import { OriginGuard } from '../auth/origin.guard.js';
import { IDEMPOTENCY_HEADER, parseIdempotencyKey } from '../idempotency/idempotency-key.js';
import { JsonContentGuard } from '../tickets/json-content.guard.js';
import { PublicEnabledGuard } from './public-enabled.guard.js';
import { PublicIntakeService } from './public-intake.service.js';
import { parsePublicTicket } from './public-ticket.schema.js';
import {
  MSG_ACCEPTED,
  MSG_DAILY_CAP,
  MSG_RATE_LIMITED,
  MSG_TURNSTILE_UNAVAILABLE,
  MSG_VERIFICATION_FAILED,
} from './public.constants.js';

const logger = new Logger('PublicTickets');

/**
 * The door customers use: no account, no key. Anyone on the internet can call it and every accepted ticket costs a
 * paid model call, so see PublicIntakeService for the order of the checks. Answers only what a customer needs: a
 * reference and a thank you. Never a job id, never anything about processing.
 */
@Controller('public/tickets')
export class PublicTicketsController {
  constructor(@Inject(PublicIntakeService) private readonly intake: PublicIntakeService) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  // Order matters: a disabled form is a plain 404, then the cheap Origin filter, then the content type.
  // The Origin check is NOT a security control here: a script (a bot) can send any Origin it likes. It only turns
  // away other websites' browsers early. What actually protects the spend is everything after it.
  @UseGuards(PublicEnabledGuard, OriginGuard, JsonContentGuard)
  async create(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
  ) {
    const key = parseIdempotencyKey(idempotencyKey);
    if (key.ok && key.key === undefined) {
      throw new BadRequestException({
        message: 'Please check the form and try again.',
        errors: [{ field: IDEMPOTENCY_HEADER, problem: 'is required' }],
      });
    }
    if (!key.ok) {
      throw new BadRequestException({ message: 'Please check the form and try again.', errors: key.problems });
    }
    const parsed = parsePublicTicket(body);
    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    if (!parsed.ok) {
      logger.warn(`public_ticket outcome=invalid ip=${ip}`);
      throw new BadRequestException({ message: 'Please check the form and try again.', errors: parsed.problems });
    }

    const outcome = await this.intake.accept(parsed.data, key.key as string, ip);
    switch (outcome.kind) {
      case 'accepted':
      case 'honeypot':
        return { reference: outcome.reference, message: MSG_ACCEPTED };
      case 'replay':
        response.setHeader('Idempotent-Replayed', 'true');
        return { reference: outcome.reference, message: MSG_ACCEPTED };
      case 'rate_limited_ip':
        response.setHeader('Retry-After', String(outcome.retryAfterSeconds));
        throw new HttpException({ message: MSG_RATE_LIMITED }, HttpStatus.TOO_MANY_REQUESTS);
      case 'turnstile_failed':
        throw new ForbiddenException({ message: MSG_VERIFICATION_FAILED });
      case 'turnstile_unavailable':
      case 'unavailable':
        throw new ServiceUnavailableException({ message: MSG_TURNSTILE_UNAVAILABLE });
      case 'daily_cap':
        response.setHeader('Retry-After', String(outcome.retryAfterSeconds));
        throw new ServiceUnavailableException({ message: MSG_DAILY_CAP });
      case 'conflict':
        // Same answer as POST /tickets gives for a reused key with different content.
        throw new UnprocessableEntityException({ message: 'This request key was already used with a different message.' });
    }
  }
}
