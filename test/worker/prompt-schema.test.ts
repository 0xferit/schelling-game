import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

async function getColumnNames(tableName: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `PRAGMA table_info(${tableName})`,
  ).all<{
    name: string;
  }>();
  return results.map((row) => row.name);
}

describe('prompt schema migrations', () => {
  it('renames vote_logs.question_id to prompt_id', async () => {
    const columns = await getColumnNames('vote_logs');

    expect(columns).toContain('prompt_id');
    expect(columns).not.toContain('question_id');
  });

  it('renames question_ratings to prompt_ratings with prompt_id', async () => {
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompt_ratings'",
    ).first<{ name: string }>();
    const legacyTable = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'question_ratings'",
    ).first<{ name: string }>();
    const columns = await getColumnNames('prompt_ratings');

    expect(table?.name).toBe('prompt_ratings');
    expect(legacyTable).toBeNull();
    expect(columns).toContain('prompt_id');
    expect(columns).not.toContain('question_id');
  });
});
