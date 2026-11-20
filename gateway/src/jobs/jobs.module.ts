import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { JobsController } from './jobs.controller.js';

@Module({ imports: [QueueModule], controllers: [JobsController] })
export class JobsModule {}
