import { Module } from '@nestjs/common';
import { newReference } from './reference.js';
import { REFERENCE_GENERATOR, ReferenceService } from './reference.service.js';

@Module({
  providers: [ReferenceService, { provide: REFERENCE_GENERATOR, useValue: newReference }],
  exports: [ReferenceService],
})
export class ReferencesModule {}
