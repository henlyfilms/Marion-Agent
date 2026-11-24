import type { ResponseUsage } from '@shared/types';

const number = new Intl.NumberFormat();

export function usageLabel(usage: Pick<ResponseUsage, 'input' | 'output' | 'estimated'>) {
  return `${usage.estimated ? 'About ' : ''}${number.format(usage.input)} in · ${number.format(usage.output)} out tokens`;
}
