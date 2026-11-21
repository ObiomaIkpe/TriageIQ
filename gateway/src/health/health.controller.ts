import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { ReadyService } from './ready.service.js';

@Controller()
export class HealthController {
  constructor(@Inject(ReadyService) private readonly readyService: ReadyService) {}

  /** Liveness: the process is up. Checks no dependencies. */
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  /** Readiness: Redis and the Python service both answer. 503 otherwise. */
  @Get('ready')
  async ready() {
    const { ready, body } = await this.readyService.check();
    if (!ready) {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return body;
  }
}
