export function getDisplayNameEditBlockMessage({
  hasActiveMatch,
  inQueue,
}) {
  if (hasActiveMatch) {
    return 'You can\'t update your display name during an active match.';
  }
  if (inQueue) {
    return 'You can\'t update your display name while in the matchmaking queue.';
  }
  return null;
}
