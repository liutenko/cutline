import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type {
  RailParticipant,
  RailReceipt,
  RailState,
  SettlementRail,
} from '../../../shared/src/types.js';
import { normalizeAllocations, parseAmount, toStrings, validateParticipants } from './amounts.js';

/**
 * In-memory settlement rail with the same semantics as the Yellow rail:
 * open puts the full amount with the desk, reallocate conserves the total and bumps the version,
 * close settles a final split and marks the session closed. Nothing leaves the process.
 */
export class LocalRail implements SettlementRail {
  readonly name = 'local' as const;
  private st: RailState | null = null;
  private participants: RailParticipant[] = [];
  private total = new Decimal(0);

  private fail(msg: string): never {
    throw new Error(`[rail:local] ${msg}`);
  }

  async open(p: { participants: RailParticipant[]; asset: 'usdt' | 'usdc'; amount: string }): Promise<RailReceipt> {
    try {
      if (this.st && this.st.status === 'open') this.fail(`session ${this.st.sessionId} is already open; close it first`);
      validateParticipants(p.participants);
      if (p.asset !== 'usdt' && p.asset !== 'usdc') this.fail(`unsupported asset "${String(p.asset)}"`);
      const amount = parseAmount(p.amount, 'amount');
      if (amount.lte(0)) this.fail('amount must be greater than zero');
      const desk = p.participants.find((x) => x.role === 'desk')!;
      const allocations: Record<string, string> = {};
      for (const x of p.participants) allocations[x.id] = x.id === desk.id ? amount.toFixed() : '0';
      this.participants = [...p.participants];
      this.total = amount;
      this.st = {
        sessionId: `local-${randomUUID()}`,
        version: 1,
        asset: p.asset,
        allocations,
        status: 'open',
      };
      return this.receipt('open', `desk deposited ${amount.toFixed()} ${p.asset}`);
    } catch (e) {
      throw wrap(e);
    }
  }

  async reallocate(next: Record<string, string>, memo: string): Promise<RailReceipt> {
    try {
      const st = this.requireOpen();
      const ids = this.participants.map((x) => x.id);
      const alloc = normalizeAllocations(next, ids, this.total);
      st.allocations = toStrings(alloc);
      st.version += 1;
      return this.receipt('reallocate', memo);
    } catch (e) {
      throw wrap(e);
    }
  }

  async close(final: Record<string, string>): Promise<RailReceipt> {
    try {
      const st = this.requireOpen();
      const ids = this.participants.map((x) => x.id);
      const alloc = normalizeAllocations(final, ids, this.total);
      st.allocations = toStrings(alloc);
      st.version += 1;
      st.status = 'closed';
      return this.receipt('close', 'final split settled');
    } catch (e) {
      throw wrap(e);
    }
  }

  state(): RailState | null {
    return this.st ? { ...this.st, allocations: { ...this.st.allocations } } : null;
  }

  private requireOpen(): RailState {
    if (!this.st) this.fail('no session is open; call open() first');
    if (this.st.status !== 'open') this.fail(`session ${this.st.sessionId} is closed`);
    return this.st;
  }

  private receipt(kind: RailReceipt['kind'], memo?: string): RailReceipt {
    const st = this.st!;
    return {
      kind,
      rail: 'local',
      sessionId: st.sessionId,
      version: st.version,
      offchain: true,
      memo,
      allocations: { ...st.allocations },
      ts: Date.now(),
    };
  }
}

function wrap(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(msg.startsWith('[rail:') ? msg : `[rail:local] ${msg}`);
}
