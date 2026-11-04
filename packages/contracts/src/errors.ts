/**
 * Contract-level error types. Kept dependency-free so every package can throw
 * and catch the same shapes without importing the Story Core.
 */
export type ErrorCode =
  | 'CONTRACT_VIOLATION'
  | 'INVALID_ARGUMENT'
  | 'PATH_UNSAFE'
  | 'PATH_OUTSIDE_ROOT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'CAS_MISMATCH'
  | 'WRITER_LOCKED'
  | 'CORRUPTION'
  | 'UNAUTHORIZED'
  | 'PROJECTION_FAILED'
  | 'JOB_CANCELLED'
  | 'IO_ERROR'
  | 'INTERNAL';

export class NarrativeStudioError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class ContractViolationError extends NarrativeStudioError {
  constructor(objectName: string, errors: string[], details: Record<string, unknown> = {}) {
    super('CONTRACT_VIOLATION', `Contract violation for ${objectName}: ${errors.join('; ')}`, {
      objectName,
      errors,
      ...details,
    });
  }
}

export class InvalidArgumentError extends NarrativeStudioError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('INVALID_ARGUMENT', message, details);
  }
}

export class PathUnsafeError extends NarrativeStudioError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PATH_UNSAFE', message, details);
  }
}

export class PathOutsideRootError extends NarrativeStudioError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PATH_OUTSIDE_ROOT', message, details);
  }
}

export class NotFoundError extends NarrativeStudioError {
  constructor(what: string, details: Record<string, unknown> = {}) {
    super('NOT_FOUND', `${what} was not found`, details);
  }
}

export class AlreadyExistsError extends NarrativeStudioError {
  constructor(what: string, details: Record<string, unknown> = {}) {
    super('ALREADY_EXISTS', `${what} already exists`, details);
  }
}

export class CasMismatchError extends NarrativeStudioError {
  constructor(expected: string | null, actual: string | null, details: Record<string, unknown> = {}) {
    super(
      'CAS_MISMATCH',
      `Base revision mismatch: expected ${expected ?? '(none)'} but vault head is ${actual ?? '(none)'}`,
      { expected, actual, ...details },
    );
  }
}

export class WriterLockedError extends NarrativeStudioError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('WRITER_LOCKED', message, details);
  }
}

export class CorruptionError extends NarrativeStudioError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('CORRUPTION', message, details);
  }
}

export class UnauthorizedError extends NarrativeStudioError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('UNAUTHORIZED', message, details);
  }
}

export class ProjectionError extends NarrativeStudioError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PROJECTION_FAILED', message, details);
  }
}

export class JobCancelledError extends NarrativeStudioError {
  constructor(jobId: string, details: Record<string, unknown> = {}) {
    super('JOB_CANCELLED', `Job ${jobId} was cancelled`, { jobId, ...details });
  }
}

export function isNarrativeStudioError(error: unknown): error is NarrativeStudioError {
  return error instanceof NarrativeStudioError;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
