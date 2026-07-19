import { parse as parseYaml } from 'yaml';
import type { ZodType } from 'zod';

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;

export function parseMarkdown<T>(source: string, schema: ZodType<T>): { data: T; body: string } {
  const match = source.match(frontmatterPattern);

  if (!match) {
    throw new Error('Markdown source must start with YAML frontmatter delimited by ---');
  }

  return {
    data: schema.parse(parseYaml(match[1])),
    body: source.slice(match[0].length),
  };
}
