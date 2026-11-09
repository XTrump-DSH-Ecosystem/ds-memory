import type { AliasGroup } from './hybrid.ts';

/**
 * 生产别名表 v1：只做证据门的查询扩展，不直接产生命中。
 *
 * 收录标准：
 * - 同义/术语改写，且组内词在聊天里指向同一类事物
 * - 不收「叫」「块」「元」「花了」这类过宽词，避免把普通叙述当证据
 * - 新增/删除别名必须补单元测试；线上 JSON 与 CONTRACT 不受影响
 */
export const PRODUCTION_ALIASES: readonly AliasGroup[] = [
  { id: 'gpu', terms: ['gpu', '显卡', '图形卡', '显示卡'] },
  { id: 'computer', terms: ['电脑', '笔记本', '台式机'] },
  { id: 'display', terms: ['屏幕', '显示器'] },
  { id: 'language', terms: ['外语', '语言', '日语', '中文', '英语', '西班牙语'] },
  { id: 'dog', terms: ['狗', '小狗', '柯基'] },
  { id: 'cat', terms: ['猫', '橘猫'] },
  { id: 'pet', terms: ['毛孩子', '宠物', '狗', '小狗', '柯基', '猫', '橘猫'] },
  { id: 'japanese-food', terms: ['日本料理', '日料', '料理店'] },
  { id: 'price', terms: ['价格', '价钱', '多少钱', '花费'] },
  { id: 'dislike', terms: ['讨厌', '不喜欢', '不吃', '受不了'] },
  { id: 'resolution', terms: ['分辨率', '4k', '2k'] },
];
