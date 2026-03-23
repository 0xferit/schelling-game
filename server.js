import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import db from './src/db.js';
import { createChallenge, verifyChallenge, getSession, isValidAddress } from './src/auth.js';
import { handleMessage, handleDisconnect, sessionState } from './src/gameManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    cookies[name] = rest.join('=');
  }
  return cookies;
}

function resolveAccountId(req) {
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

// Attach accountId to every request when a valid session cookie is present.
app.use((req, _res, next) => {
  req.accountId = resolveAccountId(req);
  next();
});

// Guard for routes that require authentication.
function authenticateSession(req, res, next) {
  if (!req.accountId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// ---------------------------------------------------------------------------
// REST API: Auth
// ---------------------------------------------------------------------------

app.post('/api/auth/challenge', (req, res) => {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress || !isValidAddress(walletAddress)) {
      return res.status(400).json({ error: 'Invalid or missing walletAddress' });
    }
    const result = createChallenge(walletAddress);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/verify', (req, res) => {
  try {
    const { challengeId, walletAddress, signature } = req.body;
    if (!challengeId || !walletAddress || !signature) {
      return res.status(400).json({ error: 'challengeId, walletAddress, and signature are required' });
    }

    const { sessionToken, account } = verifyChallenge({ challengeId, walletAddress, signature });

    res.setHeader(
      'Set-Cookie',
      `session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
    );

    res.json(account);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// REST API: Profile
// ---------------------------------------------------------------------------

app.get('/api/me', authenticateSession, (req, res) => {
  try {
    const account = db.getAccount(req.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const queueStatus = typeof sessionState?.getQueueStatus === 'function'
      ? sessionState.getQueueStatus(req.accountId)
      : null;

    res.json({
      accountId: account.account_id,
      displayName: account.display_name,
      tokenBalance: account.token_balance,
      leaderboardEligible: !!account.leaderboard_eligible,
      autoRequeue: false,
      queueStatus,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/me/profile', authenticateSession, (req, res) => {
  try {
    const { displayName } = req.body;
    if (!displayName || !/^[A-Za-z0-9_-]{1,20}$/.test(displayName)) {
      return res.status(400).json({ error: 'displayName must match ^[A-Za-z0-9_-]{1,20}$' });
    }

    // Prevent name changes while queued or in a match.
    const queueStatus = typeof sessionState?.getQueueStatus === 'function'
      ? sessionState.getQueueStatus(req.accountId)
      : null;
    if (queueStatus && (queueStatus.state === 'queued' || queueStatus.state === 'in_match')) {
      return res.status(409).json({ error: 'Cannot change display name while queued or in a match' });
    }

    db.setDisplayName(req.accountId, displayName);
    const updated = db.getAccount(req.accountId);

    res.json({
      accountId: updated.account_id,
      displayName: updated.display_name,
      tokenBalance: updated.token_balance,
      leaderboardEligible: !!updated.leaderboard_eligible,
    });
  } catch (err) {
    if (err.message.includes('already taken')) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// REST API: Leaderboard
// ---------------------------------------------------------------------------

app.get('/api/leaderboard', (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rows = db.getLeaderboard(limit);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaderboard/me', authenticateSession, (req, res) => {
  try {
    const player = db.getPlayerRank(req.accountId);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// REST API: CSV export
// ---------------------------------------------------------------------------

app.get('/api/export/votes.csv', (_req, res) => {
  try {
    const rows = db.getAllVoteLogs();
    const headers = [
      'id',
      'match_id',
      'round_number',
      'question_id',
      'account_id',
      'display_name',
      'revealed_option_index',
      'revealed_option_label',
      'won_round',
      'earns_coordination_credit',
      'ante_amount',
      'round_payout',
      'net_delta',
      'player_count',
      'valid_reveal_count',
      'top_count',
      'winner_count',
      'winning_option_indexes',
      'voided',
      'void_reason',
      'timestamp',
    ];

    // Map DB column names to canonical CSV column names.
    const colMap = {
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

    // Build an inverted map: canonical name -> DB column name.
    const reverseMap = {};
    for (const [dbCol, csvCol] of Object.entries(colMap)) {
      reverseMap[csvCol] = dbCol;
    }

    const csv = [
      headers.join(','),
      ...rows.map(r =>
        headers.map(h => JSON.stringify(r[reverseMap[h]] ?? '')).join(','),
      ),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="votes.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// REST API: Admin
// ---------------------------------------------------------------------------

app.post('/api/admin/leaderboard-eligible', (req, res) => {
  try {
    const { accountId, eligible } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    if (typeof eligible !== 'boolean') return res.status(400).json({ error: 'eligible must be a boolean' });

    db.setLeaderboardEligible(accountId, eligible);
    res.json({ accountId, eligible });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

wss.on('connection', (ws, req) => {
  // Authenticate via session cookie from the upgrade request.
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies.session);

  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
    ws.close(4001, 'Unauthenticated');
    return;
  }

  ws._accountId = session.accountId;

  ws.on('message', (data) => {
    handleMessage(ws, data.toString());
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Schelling Game server running on http://localhost:${PORT}`);
});

export default server;
