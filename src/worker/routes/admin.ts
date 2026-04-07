import type { Env } from '../../types/worker-env';
import {
  errorResponse,
  escapeCsvField,
  getRequiredString,
  jsonResponse,
  normalizeWalletAddress,
  readJsonObjectBody,
  requireAdmin,
} from './_helpers';

export async function handleExportVotesCsv(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const { results } = await env.DB.prepare(
    'SELECT * FROM vote_logs ORDER BY id ASC',
  ).all();
  const columns = [
    'id',
    'match_id',
    'game_number',
    'prompt_id',
    'account_id',
    'display_name_snapshot',
    'prompt_type',
    'revealed_option_index',
    'revealed_option_label',
    'revealed_input_text',
    'revealed_bucket_key',
    'revealed_bucket_label',
    'normalization_mode',
    'normalization_run_id',
    'won_game',
    'earns_coordination_credit',
    'ante_amount',
    'game_payout',
    'net_delta',
    'player_count',
    'valid_reveal_count',
    'top_count',
    'winner_count',
    'winning_option_indexes_json',
    'winning_bucket_keys_json',
    'voided',
    'void_reason',
    'timestamp',
  ];
  const header = columns.join(',');
  const rows = (results || []).map((r: Record<string, unknown>) =>
    columns.map((c) => escapeCsvField(r[c])).join(','),
  );
  const csv = [header, ...rows].join('\n');
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="votes.csv"',
    },
  });
}

export async function handleLeaderboardEligible(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const rawBody = await readJsonObjectBody(request);
  if (rawBody instanceof Response) return rawBody;

  const accountId = getRequiredString(rawBody, 'accountId');
  const eligible = rawBody.eligible;
  if (!accountId || typeof eligible !== 'boolean') {
    return errorResponse('accountId and eligible (boolean) required');
  }
  const normalizedAccountId = normalizeWalletAddress(accountId);
  if (!normalizedAccountId) {
    return errorResponse('accountId must be a valid 0x-prefixed address');
  }
  await env.DB.prepare(
    'UPDATE accounts SET leaderboard_eligible = ? WHERE account_id = ?',
  )
    .bind(eligible ? 1 : 0, normalizedAccountId)
    .run();

  return jsonResponse({
    accountId: normalizedAccountId,
    leaderboardEligible: eligible,
  });
}
