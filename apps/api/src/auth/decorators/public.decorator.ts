import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route as reachable without authentication (login, refresh). Every other route is denied by default. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
