import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import db from './src/db';
import { createChallenge, verifyChallenge, getSession, isValidAddress, devCreateSession } from './src/auth';
import { handleMessage, handleDisconnect, getAccountState } from './src/gameManager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    cookies[name] = rest.join('=');
  }
  return cookies;
}

function resolveAccountId(req: Request): string | null {
  const cookieHeader = req.headers.cookie;
  const cookies = parseCookies(cookieHeader);
  const token = cookies.session;
  if (!token) return null;
  const session = getSession(token);
  if (!session) return null;
  return session.accountId;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use((req: Request, _res: Response, next: NextFunction) => {
  req.accountId = resolveAccountId(req);
  next();
});

function authenticateSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.accountId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// REST API: Auth
// ---------------------------------------------------------------------------

app.post('/api/auth/challenge', (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress || !isValidAddress(walletAddress)) {
      res.status(400).json({ error: 'Invalid or missing walletAddress' });
      return;
    }
    const result = createChallenge(walletAddress);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/auth/verify', (req: Request, res: Response) => {
  try {
    const { challengeId, walletAddress, signature } = req.body;
    if (!challengeId || !walletAddress || !signature) {
      res.status(400).json({ error: 'challengeId, walletAddress, and signature are required' });
      return;
    }

    const { sessionToken, account } = verifyChallenge({ challengeId, walletAddress, signature });

    res.setHeader(
      'Set-Cookie',
      `session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
    );

    res.json(account);
  } catch (err) {
    res.status(401).json({ error: (err as Error).message });
  }
});

// Dev-only: create session without wallet signing (for local testing)
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/auth/dev', (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.body;
      if (!walletAddress) {
        res.status(400).json({ error: 'walletAddress required' });
        return;
      }
      const { sessionToken, account } = devCreateSession(walletAddress);
      res.setHeader('Set-Cookie', `session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
      res.json(account);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}

// ---------------------------------------------------------------------------
// REST API: Profile
// ---------------------------------------------------------------------------

app.get('/api/me', authenticateSession, (req: Request, res: Response) => {
  try {
    const account = db.getAccount(req.accountId!);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const accountState = getAccountState(req.accountId!);

    res.json({
      accountId: account.account_id,
      displayName: account.display_name,
      tokenBalance: account.token_balance,
      leaderboardEligible: !!account.leaderboard_eligible,
      autoRequeue: accountState.autoRequeue,
      queueStatus: accountState.queueStatus,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.patch('/api/me/profile', authenticateSession, (req: Request, res: Response) => {
  try {
    const { displayName } = req.body;
    if (!displayName || !/^[A-Za-z0-9_-]{1,20}$/.test(displayName)) {
      res.status(400).json({ error: 'displayName must match ^[A-Za-z0-9_-]{1,20}$' });
      return;
    }

    const accountState = getAccountState(req.accountId!);
    if (accountState.queueStatus === 'queued' || accountState.queueStatus === 'in_match') {
      res.status(409).json({ error: 'Cannot change display name while queued or in a match' });
      return;
    }

    db.setDisplayName(req.accountId!, displayName);
    const updated = db.getAccount(req.accountId!);

    res.json({
      accountId: updated!.account_id,
      displayName: updated!.display_name,
      tokenBalance: updated!.token_balance,
      leaderboardEligible: !!updated!.leaderboard_eligible,
    });
  } catch (err) {
    if ((err as Error).message.includes('already taken')) {
      res.status(409).json({ error: (err as Error).message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// REST API: Leaderboard
// ---------------------------------------------------------------------------

app.get('/api/leaderboard', (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 200);
    const rows = db.getLeaderboard(limit);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/leaderboard/me', authenticateSession, (req: Request, res: Response) => {
  try {
    const player = db.getPlayerRank(req.accountId!);
    if (!player) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Admin auth middleware
// ---------------------------------------------------------------------------

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const key = process.env.ADMIN_KEY;
  if (!key) {
    res.status(503).json({ error: 'ADMIN_KEY not configured' });
    return;
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${key}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// REST API: CSV export
// ---------------------------------------------------------------------------

app.get('/api/export/votes.csv', requireAdmin, (_req: Request, res: Response) => {
  try {
    const rows = db.getAllVoteLogs();
    const headers = [
      'id', 'match_id', 'round_number', 'question_id', 'account_id',
      'display_name', 'revealed_option_index', 'revealed_option_label',
      'won_round', 'earns_coordination_credit', 'ante_amount', 'round_payout',
      'net_delta', 'player_count', 'valid_reveal_count', 'top_count',
      'winner_count', 'winning_option_indexes', 'voided', 'void_reason', 'timestamp',
    ];

    const colMap: Record<string, string> = {
      id: 'id',
      match_id: 'match_id',
      round_number: 'round_number',
      question_id: 'question_id',
      account_id: 'account_id',
      display_name_snapshot: 'display_name',
      revealed_option_index: 'revealed_option_index',
      revealed_option_label: 'revealed_option_label',
      won_round: 'won_round',
      earns_coordination_credit: 'earns_coordination_credit',
      ante_amount: 'ante_amount',
      round_payout: 'round_payout',
      net_delta: 'net_delta',
      player_count: 'player_count',
      valid_reveal_count: 'valid_reveal_count',
      top_count: 'top_count',
      winner_count: 'winner_count',
      winning_option_indexes_json: 'winning_option_indexes',
      voided: 'voided',
      void_reason: 'void_reason',
      timestamp: 'timestamp',
    };

    const reverseMap: Record<string, string> = {};
    for (const [dbCol, csvCol] of Object.entries(colMap)) {
      reverseMap[csvCol] = dbCol;
    }

    const csv = [
      headers.join(','),
      ...rows.map((r) =>
        headers.map(h => JSON.stringify((r as unknown as Record<string, unknown>)[reverseMap[h]] ?? '')).join(','),
      ),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="votes.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// REST API: Admin
// ---------------------------------------------------------------------------

app.post('/api/admin/leaderboard-eligible', requireAdmin, (req: Request, res: Response) => {
  try {
    const { accountId, eligible } = req.body;
    if (!accountId) {
      res.status(400).json({ error: 'accountId required' });
      return;
    }
    if (typeof eligible !== 'boolean') {
      res.status(400).json({ error: 'eligible must be a boolean' });
      return;
    }

    db.setLeaderboardEligible(accountId, eligible);
    res.json({ accountId, eligible });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// REST API: Example votes (landing page focal point demo)
// ---------------------------------------------------------------------------

app.post('/api/example-vote', (req: Request, res: Response) => {
  try {
    const idx = req.body?.optionIndex;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx > 17) {
      res.status(400).json({ error: 'optionIndex must be an integer 0-17' });
      return;
    }
    db.insertExampleVote(idx);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/example-tally', (_req: Request, res: Response) => {
  try {
    const tally = db.getExampleVoteTally();
    const votes = tally.votes.map(v => ({ optionIndex: v.option_index, count: v.count }));
    res.json({ total: tally.total, votes });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies.session);

  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
    ws.close(4001, 'Unauthenticated');
    return;
  }

  ws._accountId = session.accountId;

  ws.on('message', (data: Buffer) => {
    handleMessage(ws, data.toString());
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });

  ws.on('error', (err: Error) => {
    console.error('WebSocket error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Schelling Game server running on http://localhost:${PORT}`);
});

export default server;
