import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { DeadLettersController } from './dead-letters.controller.js';

@Module({ imports: [QueueModule], controllers: [DeadLettersController] })
export class DeadLettersModule {}
