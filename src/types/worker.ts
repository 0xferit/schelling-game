import type { GamePhase } from './domain';

export type WorkerMatchPhase =
  | GamePhase
  | 'starting'
  | 'settling'
  | 'ending'
  | 'ended';
