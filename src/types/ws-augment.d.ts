import 'ws';

declare module 'ws' {
  interface WebSocket {
    _accountId?: string;
  }
}
