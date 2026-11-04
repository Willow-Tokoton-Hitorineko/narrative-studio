import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import * as ajvFormatsModule from 'ajv-formats';
import { DOMAIN_SCHEMAS, type DomainSchemaName } from './schemas.js';
import { ContractViolationError } from './errors.js';

/**
 * `ajv` is a CommonJS package. The named `Ajv2020` export exists both in its
 * typings and at runtime, so it is imported by name; `ajv-formats` only has a
 * default export, which is unwrapped explicitly for Node ESM interop.
 */
const addFormats = (
  (ajvFormatsModule as unknown as { default?: (ajv: unknown) => unknown }).default ??
  (ajvFormatsModule as unknown as (ajv: unknown) => unknown)
);

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
  validateFormats: true,
  addUsedSchema: false,
});

if (typeof addFormats === 'function') {
  addFormats(ajv);
} else {
  throw new Error('ajv-formats could not be loaded');
}

const validators = new Map<DomainSchemaName, ValidateFunction>();

function getValidator(name: DomainSchemaName): ValidateFunction {
  const cached = validators.get(name);
  if (cached) return cached;
  const compiled = ajv.compile(DOMAIN_SCHEMAS[name]);
  validators.set(name, compiled);
  return compiled;
}

export interface ContractValidationResult {
  ok: boolean;
  errors: string[];
}

function formatErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map((error) => {
    const path = error.instancePath === '' ? '(root)' : error.instancePath;
    const extra =
      error.params && Object.keys(error.params).length > 0
        ? ` ${JSON.stringify(error.params)}`
        : '';
    return `${path} ${error.message ?? 'is invalid'}${extra}`;
  });
}

export function validateContract(name: DomainSchemaName, value: unknown): ContractValidationResult {
  const validate = getValidator(name);
  const ok = validate(value) as boolean;
  return { ok, errors: ok ? [] : formatErrors(validate) };
}

/**
 * Validates an object against a domain contract and returns it typed.
 * Throws `ContractViolationError` (code `CONTRACT_VIOLATION`) on failure.
 */
export function assertContract<T>(name: DomainSchemaName, value: unknown): T {
  const result = validateContract(name, value);
  if (!result.ok) throw new ContractViolationError(name, result.errors);
  return value as T;
}

export const validateProject = (value: unknown) => validateContract('project', value);
export const validateChapter = (value: unknown) => validateContract('chapter', value);
export const validateRevision = (value: unknown) => validateContract('revision', value);
export const validateOperation = (value: unknown) => validateContract('operation', value);
export const validateApproval = (value: unknown) => validateContract('approval', value);
export const validateProjectionStatus = (value: unknown) => validateContract('projectionStatus', value);
export const validateManifest = (value: unknown) => validateContract('manifest', value);
export const validateJournal = (value: unknown) => validateContract('journal', value);
export const validateProposal = (value: unknown) => validateContract('proposal', value);
export const validateImportMetadata = (value: unknown) => validateContract('importMetadata', value);
export const validateNarrativeCanon = (value: unknown) => validateContract('narrativeCanon', value);
export const validateVoiceCorpus = (value: unknown) => validateContract('voiceCorpus', value);
export const validateCoevolutionState = (value: unknown) => validateContract('coevolutionState', value);
export const validateStyleConstitution = (value: unknown) => validateContract('styleConstitution', value);
export const validateVaultDescriptor = (value: unknown) => validateContract('vaultDescriptor', value);
export const validateSnapshotManifest = (value: unknown) => validateContract('snapshotManifest', value);
export const validateEditorialJob = (value: unknown) => validateContract('editorialJob', value);
export const validatePreferenceObservation = (value: unknown) =>
  validateContract('preferenceObservation', value);
export const validateProjectionEnvelope = (value: unknown) => validateContract('projectionEnvelope', value);
