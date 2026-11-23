import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module.js';
import { ReviewerTicketsController } from './reviewer-tickets.controller.js';
import { TriageClientModule } from './triage-client.module.js';

@Module({
  imports: [TriageClientModule, MailModule],
  controllers: [ReviewerTicketsController],
})
export class TriageApiModule {}
