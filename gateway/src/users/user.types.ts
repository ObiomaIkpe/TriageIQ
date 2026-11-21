export const USER_ROLES = ['reviewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** A reviewer account, as every read except findByEmail returns it: never with the hash. */
export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  disabledAt: Date | null;
  passwordChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Only findByEmail returns this, because login needs the hash. */
export interface UserWithHash extends User {
  passwordHash: string;
}

export interface NewUser {
  email: string;
  displayName: string;
  passwordHash: string;
}

/** An account with this email already exists. */
export class DuplicateEmailError extends Error {
  constructor() {
    super('A user with this email already exists');
    this.name = 'DuplicateEmailError';
  }
}
