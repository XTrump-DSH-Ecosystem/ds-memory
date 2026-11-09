import type { QqSenderRole, WakeItem, WakePacket } from './types.ts';

/** 缺省 senderRole 视为普通成员，避免漏标后误用 owner 豁免。 */
export function isOwnerWakeItem(item: Pick<WakeItem, 'senderRole'>): boolean {
  return item.senderRole === 'owner';
}

/**
 * 一包里只要出现 owner，就按 owner 回合处理，保证 owner 不受成员限流影响。
 * 成员命令仍由 turn 层要求“单条且 owner”，不会因混批获得控制权限。
 */
export function wakeAudience(packet: Pick<WakePacket, 'items'>): QqSenderRole {
  return packet.items.some(isOwnerWakeItem) ? 'owner' : 'member';
}
