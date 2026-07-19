import { fileURLToPath } from 'node:url';

export function resolveValidationRoot(moduleUrl: string): string {
  return fileURLToPath(new URL('..', moduleUrl));
}
