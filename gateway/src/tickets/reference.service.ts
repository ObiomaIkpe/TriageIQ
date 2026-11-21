import { Inject, Injectable, Logger } from '@nestjs/common';
import { PG_POOL, type DbPool } from '../database/database.constants.js';
import { newReference } from './reference.js';

/** Injection token for the function that makes a candidate reference. Only tests replace it. */
export const REFERENCE_GENERATOR = Symbol('REFERENCE_GENERATOR');
export const MAX_RESERVE_TRIES = 5;

/** No reference could be reserved (five collisions in a row, or the database failed). The caller answers 503. */
export class ReferenceUnavailableError extends Error {
  constructor() {
    super('could not reserve a ticket reference');
    this.name = 'ReferenceUnavailableError';
  }
}

const logger = new Logger('References');

/**
 * Reserves a ticket reference in the gateway database before it is used: INSERT ... ON CONFLICT DO NOTHING
 * RETURNING, so a reference that is already taken returns no row and a new candidate is tried (up to 5 tries
 * in all). Reservations are never released. Reserve only for a NEW submission: a replay reuses the reference
 * stored with its Idempotency-Key, and a honeypot's fake reference is never reserved.
 */
@Injectable()
export class ReferenceService {
  constructor(
    @Inject(PG_POOL) private readonly pool: DbPool,
    @Inject(REFERENCE_GENERATOR) private readonly generate: () => string = newReference,
  ) {}

  /** Reserves `first` if it is free (else new candidates) and returns the reference that is now reserved. */
  async reserve(first?: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_RESERVE_TRIES; attempt += 1) {
      const candidate = attempt === 1 && first !== undefined ? first : this.generate();
      let reserved: boolean;
      try {
        const result = await this.pool.query(
          'INSERT INTO ticket_references (reference) VALUES ($1) ON CONFLICT (reference) DO NOTHING RETURNING reference',
          [candidate],
        );
        reserved = result.rows.length === 1;
      } catch (error) {
        // A short code only: the message could carry connection details.
        logger.error(`Could not reserve a ticket reference (database error ${(error as { code?: string }).code ?? 'unknown'})`);
        throw new ReferenceUnavailableError();
      }
      if (reserved) return candidate;
      logger.warn(`Ticket reference collision (try ${attempt} of ${MAX_RESERVE_TRIES}): ${candidate}`);
    }
    logger.error(`COULD NOT RESERVE A TICKET REFERENCE after ${MAX_RESERVE_TRIES} collisions in a row: the reference space may be nearly full`);
    throw new ReferenceUnavailableError();
  }
}
