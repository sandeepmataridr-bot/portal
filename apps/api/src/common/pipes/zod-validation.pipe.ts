import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates a request body/param against a shared-types zod schema — the
 * same schema React forms use, so server and client can never drift apart.
 * Applied per-route (e.g. `@Body(new ZodValidationPipe(loginSchema))`), not
 * globally: the global class-validator ValidationPipe in main.ts still runs
 * first but no-ops on these routes since their params are typed as plain
 * zod-inferred types, not classes.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Validation failed',
        issues: result.error.issues,
      });
    }
    return result.data;
  }
}
