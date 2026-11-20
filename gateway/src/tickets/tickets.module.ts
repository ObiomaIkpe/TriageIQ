import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { TicketsController } from './tickets.controller.js';

@Module({ imports: [QueueModule], controllers: [TicketsController] })
export class TicketsModule {}
