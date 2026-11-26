// DEV ONLY. In-memory settlement rail used when the rail package is missing and DATA=dev, and in tests.
import type { RailName, RailParticipant, RailReceipt, RailState, SettlementRail } from '../../../../shared/src/types.ts';
import { fromUnits, sumUnits, toUnits } from '../money.ts';

export class DevRail implements SettlementRail {
  readonly name: RailName = 'local';
  readonly isDevRail = true;
  private st: RailState | null = null;
  private total = 0n;
  private participants: RailParticipant[] = [];

  async open(p: { participants: RailParticipant[]; asset: 'usdt' | 'usdc'; amount: string }): Promise<RailReceipt> {
    if (this.st?.status === 'open') throw new Error('DevRail: session already open');
    this.participants = p.participants;
    this.total = toUnits(p.amount);
    const desk = p.participants.find((x) => x.role === 'desk');
    if (!desk) throw new Error('DevRail: no desk participant');
    const allocations: Record<string, string> = {};
    for (const x of p.participants) allocations[x.id] = x.id === desk.id ? fromUnits(this.total) : '0';
    this.st = { sessionId: `dev-${Date.now().toString(36)}`, version: 1, asset: p.asset, allocations, status: 'open' };
    return this.receipt('open', 'session opened');
  }

  async reallocate(next: Record<string, string>, memo: string): Promise<RailReceipt> {
    this.assertOpen();
    this.assertConserved(next);
    this.st!.allocations = { ...next };
    this.st!.version++;
    return this.receipt('reallocate', memo);
  }

  async close(final: Record<string, string>): Promise<RailReceipt> {
    this.assertOpen();
    this.assertConserved(final);
    this.st!.allocations = { ...final };
    this.st!.version++;
    this.st!.status = 'closed';
    return this.receipt('close', 'session closed');
  }

  state(): RailState | null {
    return this.st ? { ...this.st, allocations: { ...this.st.allocations } } : null;
  }

  private assertOpen() {
    if (!this.st || this.st.status !== 'open') throw new Error('DevRail: no open session');
  }

  private assertConserved(m: Record<string, string>) {
    const s = sumUnits(m);
    if (s !== this.total) throw new Error(`DevRail: allocations sum ${fromUnits(s)} != pot ${fromUnits(this.total)}`);
    for (const id of Object.keys(m)) {
      if (!this.participants.some((p) => p.id === id)) throw new Error(`DevRail: unknown participant ${id}`);
    }
  }

  private receipt(kind: RailReceipt['kind'], memo: string): RailReceipt {
    return {
      kind,
      rail: this.name,
      sessionId: this.st!.sessionId,
      version: this.st!.version,
      offchain: true,
      memo: `[dev rail] ${memo}`,
      allocations: { ...this.st!.allocations },
      ts: Date.now(),
    };
  }
}
