import { Module } from '@nestjs/common';
import { PasswordHasher } from './password-hasher.js';
import { UsersRepository } from './users.repository.js';

/** Reviewer accounts. Nothing in the app calls these yet; login (M4.1b) will. */
@Module({
  providers: [UsersRepository, PasswordHasher],
  exports: [UsersRepository, PasswordHasher],
})
export class UsersModule {}
