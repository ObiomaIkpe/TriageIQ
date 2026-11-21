import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configModuleOptions } from './config/config.options.js';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DeadLettersModule } from './dead-letters/dead-letters.module.js';
import { HealthModule } from './health/health.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { PublicTicketsModule } from './public-tickets/public-tickets.module.js';
import { RedisModule } from './redis/redis.module.js';
import { TicketsModule } from './tickets/tickets.module.js';
import { TriageApiModule } from './triage-api/triage-api.module.js';
import { UsersModule } from './users/users.module.js';
import { WorkerModule } from './worker/worker.module.js';

@Module({
  imports: [
    // Validates the environment as this file loads. A bad setting stops the app from starting.
    ConfigModule.forRoot(configModuleOptions),
    RedisModule,
    DatabaseModule,
    UsersModule,
    AuthModule,
    HealthModule,
    TicketsModule,
    PublicTicketsModule,
    TriageApiModule,
    JobsModule,
    DeadLettersModule,
    WorkerModule,
  ],
})
export class AppModule {}
