import { existsSync } from 'node:fs';

const contentDirectory = new URL('../src/content/', import.meta.url);

if (existsSync(contentDirectory)) {
  console.error(
    'Content validation is not implemented until Task 2: src/content exists and requires the Task 2 validator.',
  );
  process.exitCode = 1;
} else {
  console.info('No content directory exists; content validation is deferred to Task 2.');
}
