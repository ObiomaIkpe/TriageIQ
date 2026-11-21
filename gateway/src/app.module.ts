import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configModuleOptions } from './config/config.options.js';
import { HealthModule } from './health/health.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { RedisModule } from './redis/redis.module.js';
import { TicketsModule } from './tickets/tickets.module.js';
import { WorkerModule } from './worker/worker.module.js';

@Module({
  imports: [
    // Validates the environment as this file loads. A bad setting stops the app from starting.
    ConfigModule.forRoot(configModuleOptions),
    RedisModule,
    HealthModule,
    TicketsModule,
    JobsModule,
    WorkerModule,
  ],
})
export class AppModule {}
