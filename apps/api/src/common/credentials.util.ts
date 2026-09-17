import { randomBytes } from 'node:crypto';

export function slugifyLoginId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return slug || 'doctor';
}

/** Random, non-guessable — never a fixed default like the reference app's "Doctor@123". */
export function generateTempPassword(): string {
  return `Temp-${randomBytes(6).toString('hex')}`;
}
