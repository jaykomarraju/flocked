import { describe, expect, it } from 'vitest';
import {
  claimStatus,
  confirmLine,
  destinationLine,
  formatClaimDay,
  formatClockTime,
  readyNote,
  resultWord,
  shortAddress,
  waitingNote,
  walletErrorMessage,
} from './copy';

/** 11:03pm on the reader's own clock, whatever time zone the test runs in. */
const ELEVEN_OH_THREE = new Date(2026, 9, 8, 23, 3).getTime();
const NOON = new Date(2026, 9, 8, 12, 0).getTime();

describe('claims copy', () => {
  it('says a claim-open time the way the screen does', () => {
    expect(formatClockTime(ELEVEN_OH_THREE)).toBe('11:03pm');
    expect(formatClockTime(NOON)).toBe('12:00pm');
  });

  it('names the day as a row does', () => {
    expect(formatClaimDay('2026-10-07')).toBe('Wed, Oct 7');
    expect(formatClaimDay('2026-10-05')).toBe('Mon, Oct 5');
  });

  it('says what each payout kind is', () => {
    expect(resultWord('win')).toBe('Won');
    expect(resultWord('rebate')).toBe('Rebate');
    expect(resultWord('refund')).toBe('Refunded');
    expect(resultWord('void_refund')).toBe('Refunded');
  });

  it('shows a payout inside its challenge window as claimable-at, never as ready', () => {
    expect(claimStatus(null, true, false)).toBe('Ready');
    expect(claimStatus(ELEVEN_OH_THREE, true, false)).toBe('Ready');
    expect(claimStatus(ELEVEN_OH_THREE, false, false)).toBe('Opens 11:03pm');
    expect(claimStatus(ELEVEN_OH_THREE, false, true)).toBe('Claiming');
  });

  it('counts what is ready and names the one that is not', () => {
    const waiting = [{ index: 2, opensAt: ELEVEN_OH_THREE }];
    expect(readyNote({ ready: 2, total: 3, waiting })).toBe(
      '2 of 3 are ready. The third opens at 11:03pm.',
    );
    expect(
      readyNote({ ready: 1, total: 2, waiting: [{ index: 1, opensAt: ELEVEN_OH_THREE }] }),
    ).toBe('1 of 2 is ready. The second opens at 11:03pm.');
  });

  it('names the next one when more than one is waiting, and says nothing when none is', () => {
    expect(
      readyNote({
        ready: 1,
        total: 3,
        waiting: [
          { index: 1, opensAt: ELEVEN_OH_THREE },
          { index: 2, opensAt: ELEVEN_OH_THREE },
        ],
      }),
    ).toBe('1 of 3 is ready. The next opens at 11:03pm.');
    expect(readyNote({ ready: 3, total: 3, waiting: [] })).toBeNull();
  });

  it('says what the confirm is about to send', () => {
    expect(confirmLine(2, '0x3f2c…a91c')).toBe(
      'Two payouts, one transaction. They go to 0x3f2c…a91c.',
    );
    expect(confirmLine(1, '0x3f2c…a91c')).toBe(
      'One payout, one transaction. It goes to 0x3f2c…a91c.',
    );
  });

  it('says what the batch leaves behind', () => {
    expect(waitingNote({ count: 1, opensAt: ELEVEN_OH_THREE, gameDay: '2026-10-08' })).toBe(
      'The Oct 8 payout opens at 11:03pm. Claim it then.',
    );
    expect(waitingNote({ count: 1, opensAt: ELEVEN_OH_THREE, gameDay: null })).toBe(
      'One more payout opens at 11:03pm. Claim it then.',
    );
    expect(waitingNote({ count: 2, opensAt: ELEVEN_OH_THREE, gameDay: null })).toBe(
      'Two more payouts open later. The next is at 11:03pm.',
    );
    expect(waitingNote(null)).toBeNull();
  });

  it('truncates the destination wallet', () => {
    expect(shortAddress('0x3f2c00000000000000000000000000000000a91c')).toBe('0x3f2c…a91c');
    expect(destinationLine('0x3f2c…a91c')).toContain('the wallet that entered, 0x3f2c…a91c.');
  });

  it("doesn't apologise for a claim the player waved off", () => {
    expect(walletErrorMessage('rejected')).toBe(
      'You turned the claim down in your wallet. Nothing was sent.',
    );
    expect(walletErrorMessage('not_sponsored')).toContain("couldn't cover the gas");
    expect(walletErrorMessage('failed')).toBe('Something broke. The flock is looking into it.');
  });
});
