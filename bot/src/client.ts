import crypto from 'node:crypto';
import { type HDNodeWallet, Wallet } from 'ethers';
import WebSocket from 'ws';
import { pickOption } from './strategy.js';

// ── Types (mirroring src/types/messages.ts) ────────────────────

interface Question {
  id: number;
  text: string;
  type: 'select';
  category: string;
  options: string[];
}

interface RoundStartMsg {
  type: 'round_start';
  round: number;
  question: Question;
  commitDuration: number;
  roundAnte: number;
  phase: string;
  yourCommitted?: boolean;
  yourRevealed?: boolean;
}

interface PhaseChangeMsg {
  type: 'phase_change';
  phase: 'reveal';
  revealDuration: number;
}

interface PlayerResult {
  displayName: string;
  revealedOptionIndex: number | null;
  revealedOptionLabel: string | null;
  wonRound: boolean;
  earnsCoordinationCredit: boolean;
  antePaid: number;
  roundPayout: number;
  netDelta: number;
  newBalance: number;
}

interface RoundResultMsg {
  type: 'round_result';
  resultsDuration: number;
  result: {
    roundNum: number;
    voided: boolean;
    players: PlayerResult[];
  };
}

interface GameOverMsg {
  type: 'game_over';
  summary: {
    players: {
      displayName: string;
      startingBalance: number;
      endingBalance: number;
      netDelta: number;
      result: string;
    }[];
  };
}

type ServerMessage =
  | RoundStartMsg
  | PhaseChangeMsg
  | RoundResultMsg
  | GameOverMsg
  | { type: 'queue_state'; [k: string]: unknown }
  | { type: 'game_started'; [k: string]: unknown }
  | { type: 'commit_status'; [k: string]: unknown }
  | { type: 'reveal_status'; [k: string]: unknown }
  | { type: 'player_disconnected'; [k: string]: unknown }
  | { type: 'player_reconnected'; [k: string]: unknown }
  | { type: 'player_forfeited'; [k: string]: unknown }
  | { type: 'question_rating_tally'; [k: string]: unknown }
  | { type: 'error'; message: string };

// ── Commit-reveal (mirrors src/domain/commitReveal.ts) ─────────

const SALT_HEX_LENGTH = 64;

function generateSalt(): string {
  return crypto.randomBytes(SALT_HEX_LENGTH / 2).toString('hex');
}

function createCommitHash(optionIndex: number, salt: string): string {
  const preimage = `${optionIndex}:${salt}`;
  return crypto.createHash('sha256').update(preimage).digest('hex');
}

// ── Round log entry ────────────────────────────────────────────

export interface RoundLog {
  round: number;
  question: string;
  options: string[];
  chosen: number;
  chosenLabel: string;
  strategy: string;
  model: string;
  won?: boolean;
  netDelta?: number;
}

// ── Options ────────────────────────────────────────────────────

export interface GameClientOptions {
  serverUrl: string;
  model: string;
  ollamaUrl?: string;
  loop: boolean;
  privateKey?: string;
  displayName?: string;
  onRoundLog: (entry: RoundLog) => void;
}

// ── GameClient ─────────────────────────────────────────────────

export class GameClient {
  private wallet: Wallet | HDNodeWallet;
  private sessionCookie = '';
  private displayName = '';
  private ws: WebSocket | null = null;

  private currentRound = 0;
  private pendingOptionIndex = -1;
  private pendingSalt = '';

  private opts: GameClientOptions;

  constructor(opts: GameClientOptions) {
    this.opts = opts;
    this.wallet = opts.privateKey
      ? new Wallet(opts.privateKey)
      : Wallet.createRandom();
    console.error(`[bot] wallet: ${this.wallet.address}`);
  }

  async start(): Promise<void> {
    await this.authenticate();
    this.connect();
  }

  // ── Auth ───────────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    const base = this.opts.serverUrl;
    const address = this.wallet.address;

    // 1. Get challenge
    const challengeRes = await fetch(`${base}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: address }),
    });
    if (!challengeRes.ok) {
      throw new Error(`Challenge failed: ${challengeRes.status}`);
    }
    const challenge = (await challengeRes.json()) as {
      challengeId: string;
      message: string;
    };

    // 2. Sign
    const signature = await this.wallet.signMessage(challenge.message);

    // 3. Verify
    const verifyRes = await fetch(`${base}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        walletAddress: address,
        signature,
      }),
    });
    if (!verifyRes.ok) {
      throw new Error(`Verify failed: ${verifyRes.status}`);
    }

    const setCookie = verifyRes.headers.get('set-cookie') ?? '';
    const match = setCookie.match(/session=([^;]+)/);
    if (!match) throw new Error('No session cookie in verify response');
    this.sessionCookie = match[1];

    const profile = (await verifyRes.json()) as {
      accountId: string;
      displayName: string | null;
      requiresDisplayName: boolean;
    };

    console.error(`[bot] authenticated as ${profile.accountId}`);

    // 4. Set display name if needed
    if (profile.requiresDisplayName) {
      const name =
        this.opts.displayName ??
        `bot-${this.wallet.address.slice(2, 8).toLowerCase()}`;
      const nameRes = await fetch(`${base}/api/me/profile`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${this.sessionCookie}`,
        },
        body: JSON.stringify({ displayName: name }),
      });
      if (!nameRes.ok) {
        throw new Error(`Set display name failed: ${nameRes.status}`);
      }
      this.displayName = name;
      console.error(`[bot] display name: ${name}`);
    } else {
      this.displayName = profile.displayName ?? 'unknown';
      console.error(`[bot] display name: ${this.displayName}`);
    }
  }

  // ── WebSocket ──────────────────────────────────────────────

  private connect(): void {
    const wsUrl = `${this.opts.serverUrl.replace(/^http/, 'ws')}/ws`;

    this.ws = new WebSocket(wsUrl, {
      headers: { Cookie: `session=${this.sessionCookie}` },
    });

    this.ws.on('open', () => {
      console.error('[bot] connected, joining queue');
      this.send({ type: 'join_queue' });
    });

    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.handleMessage(msg);
    });

    this.ws.on('close', (code) => {
      console.error(`[bot] disconnected (code ${code})`);
      if (this.opts.loop) {
        console.error('[bot] reconnecting in 3s...');
        setTimeout(() => this.connect(), 3000);
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[bot] ws error: ${err.message}`);
    });
  }

  private send(msg: object): void {
    this.ws?.send(JSON.stringify(msg));
  }

  // ── Message handling ───────────────────────────────────────

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'queue_state':
        break;
      case 'game_started':
        console.error('[bot] match started');
        break;
      case 'round_start':
        this.onRoundStart(msg);
        break;
      case 'phase_change':
        if (msg.phase === 'reveal') this.onRevealPhase();
        break;
      case 'commit_status':
      case 'reveal_status':
        break;
      case 'round_result':
        this.onRoundResult(msg);
        break;
      case 'game_over':
        this.onGameOver(msg);
        break;
      case 'error':
        console.error(`[bot] server error: ${msg.message}`);
        break;
      default:
        break;
    }
  }

  private async onRoundStart(msg: RoundStartMsg): Promise<void> {
    this.currentRound = msg.round;

    if (msg.yourCommitted) {
      console.error(`[bot] round ${msg.round}: already committed (reconnect)`);
      return;
    }

    const optionIndex = await pickOption(
      msg.question.text,
      msg.question.options,
      this.opts.model,
      this.opts.ollamaUrl,
    );

    const salt = generateSalt();
    const hash = createCommitHash(optionIndex, salt);

    this.pendingOptionIndex = optionIndex;
    this.pendingSalt = salt;

    this.send({ type: 'commit', hash });

    const label = msg.question.options[optionIndex] ?? '?';
    console.error(
      `[bot] round ${msg.round}: committed "${label}" (index ${optionIndex})`,
    );

    this.opts.onRoundLog({
      round: msg.round,
      question: msg.question.text,
      options: msg.question.options,
      chosen: optionIndex,
      chosenLabel: label,
      strategy: 'llm',
      model: this.opts.model,
    });
  }

  private onRevealPhase(): void {
    if (this.pendingOptionIndex < 0) return;
    this.send({
      type: 'reveal',
      optionIndex: this.pendingOptionIndex,
      salt: this.pendingSalt,
    });
    console.error(`[bot] round ${this.currentRound}: revealed`);
  }

  private onRoundResult(msg: RoundResultMsg): void {
    const me = msg.result.players.find(
      (p) => p.displayName === this.displayName,
    );
    if (me) {
      const outcome = me.wonRound ? 'won' : 'lost';
      console.error(
        `[bot] round ${msg.result.roundNum}: ${outcome} (${me.netDelta >= 0 ? '+' : ''}${me.netDelta})`,
      );
    }

    this.pendingOptionIndex = -1;
    this.pendingSalt = '';
  }

  private onGameOver(msg: GameOverMsg): void {
    const me = msg.summary.players.find(
      (p) => p.displayName === this.displayName,
    );
    if (me) {
      console.error(
        `[bot] match over: net ${me.netDelta >= 0 ? '+' : ''}${me.netDelta} (${me.startingBalance} → ${me.endingBalance})`,
      );
    }

    if (this.opts.loop) {
      console.error('[bot] re-queuing...');
      this.send({ type: 'join_queue' });
    }
  }
}
