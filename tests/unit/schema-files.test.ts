import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DOMAIN_SCHEMAS,
  SCHEMA_FILE_NAMES,
  type DomainSchemaName,
} from '@narrative-studio/contracts';
import { REPO_ROOT } from '../helpers/cli.js';

const SCHEMA_DIR = path.join(REPO_ROOT, 'packages', 'contracts', 'schemas');

describe('emitted JSON Schema files stay in sync with TypeScript definitions', () => {
  const names = Object.keys(DOMAIN_SCHEMAS) as DomainSchemaName[];

  it('has a schema file for every domain object', () => {
    expect(names.length).toBeGreaterThanOrEqual(11);
    for (const name of names) {
      const file = path.join(SCHEMA_DIR, SCHEMA_FILE_NAMES[name]);
      expect(fs.existsSync(file), `${file} is missing; run pnpm schemas:emit`).toBe(true);
    }
  });

  it.each(names)('%s matches its emitted file', (name) => {
    const file = path.join(SCHEMA_DIR, SCHEMA_FILE_NAMES[name]);
    const fromDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    expect(fromDisk).toEqual(DOMAIN_SCHEMAS[name]);
  });
});
