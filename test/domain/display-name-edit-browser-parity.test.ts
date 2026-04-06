import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface BrowserDisplayNameEditApi {
  getDisplayNameEditBlockMessage(state: {
    hasActiveMatch: boolean;
    inQueue: boolean;
    // Included in the test shape so callers can prove the helper ignores it.
    formingMatch?: unknown;
  }): string | null;
}

async function loadBrowserDisplayNameEditApi(): Promise<BrowserDisplayNameEditApi> {
  const moduleUrl = pathToFileURL(
    path.resolve(process.cwd(), 'public/scripts/displayNameEdit.js'),
  ).href;
  const module = await import(moduleUrl);
  return {
    getDisplayNameEditBlockMessage: module.getDisplayNameEditBlockMessage,
  };
}

let browserDisplayNameEditApi: BrowserDisplayNameEditApi;

describe('browser display-name edit gating', () => {
  beforeAll(async () => {
    browserDisplayNameEditApi = await loadBrowserDisplayNameEditApi();
  });

  it('allows idle spectators to edit while another lobby is forming', () => {
    expect(
      browserDisplayNameEditApi.getDisplayNameEditBlockMessage({
        hasActiveMatch: false,
        inQueue: false,
        formingMatch: {
          playerCount: 3,
          youCanVoteStartNow: false,
        },
      }),
    ).toBeNull();
  });

  it('blocks queued players from editing', () => {
    expect(
      browserDisplayNameEditApi.getDisplayNameEditBlockMessage({
        hasActiveMatch: false,
        inQueue: true,
      }),
    ).toBe(
      "You can't update your display name while in the matchmaking queue.",
    );
  });

  it('blocks forming-lobby participants from editing because they are in queue state', () => {
    expect(
      browserDisplayNameEditApi.getDisplayNameEditBlockMessage({
        hasActiveMatch: false,
        inQueue: true,
        formingMatch: {
          playerCount: 4,
          youCanVoteStartNow: true,
        },
      }),
    ).toBe(
      "You can't update your display name while in the matchmaking queue.",
    );
  });

  it('blocks players in an active match from editing', () => {
    expect(
      browserDisplayNameEditApi.getDisplayNameEditBlockMessage({
        hasActiveMatch: true,
        inQueue: false,
      }),
    ).toBe("You can't update your display name during an active match.");
  });
});
