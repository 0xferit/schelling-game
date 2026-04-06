import { handleHttpRequest } from './worker/httpHandler';

export default {
  fetch: handleHttpRequest,
};

export { GameRoom } from './worker/gameRoom';
