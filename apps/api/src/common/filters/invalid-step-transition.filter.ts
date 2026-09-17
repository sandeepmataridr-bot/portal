import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { InvalidStepTransitionError } from '@infusion/shared-types';

/**
 * Converts a skipped-workflow-step attempt into a typed 409, per the plan's
 * "every skip-attempt returns a typed 409 with a specific error code (not a
 * generic failure)" requirement — never a bare 500.
 */
@Catch(InvalidStepTransitionError)
export class InvalidStepTransitionFilter implements ExceptionFilter {
  catch(exception: InvalidStepTransitionError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(409).json({
      statusCode: 409,
      code: exception.code,
      message: exception.message,
      from: exception.from,
      to: exception.to,
    });
  }
}
