import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/** argon2id — replaces the reference app's HMAC-SHA256 + single shared pepper. */
@Injectable()
export class PasswordService {
  async hash(plainPassword: string): Promise<string> {
    return argon2.hash(plainPassword, { type: argon2.argon2id });
  }

  async verify(hash: string, plainPassword: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plainPassword);
    } catch {
      return false;
    }
  }
}
